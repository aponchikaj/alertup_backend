import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import {
  createUser,
  createOwnerWithBuilding,
  createFloor,
  createNode,
  addMember,
} from './helpers.js';

/**
 * The /api/nodes router is a compatibility shim for the deployed node manager
 * UI: it speaks the legacy contract (type vocabulary path|exit|stairs, an
 * embedded `connections` array, `_id`) on top of the Prisma node/edge tables.
 * These tests pin that contract — the old UI is still in production.
 */

describe('/api/nodes legacy shim', () => {
  test('creates a node and returns the legacy shape', async () => {
    const { cookie, building } = await createOwnerWithBuilding();

    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', cookie)
      .send({
        buildingId: building.id,
        floorNumber: 1,
        x: 100,
        y: 150,
        type: 'path',
        label: 'Corridor',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.node).toMatchObject({
      buildingId: building.id,
      floorNumber: 1,
      x: 100,
      y: 150,
      type: 'path',
      label: 'Corridor',
      connections: [],
    });
    expect(res.body.node._id).toBeTruthy();
    expect(res.body.node._id).toBe(res.body.node.id);

    // A placeholder floor is created for a floor number with no Floor row.
    const floor = await prisma.floor.findFirst({
      where: { buildingId: building.id, floorNumber: 1 },
    });
    expect(floor).toBeTruthy();

    // Stored with the new vocabulary.
    const stored = await prisma.node.findUnique({ where: { id: res.body.node.id } });
    expect(stored.type).toBe('NORMAL');
  });

  test('maps every legacy type to its new equivalent and back', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const cases = [
      ['path', 'NORMAL'],
      ['exit', 'EMERGENCY_EXIT'],
      ['stairs', 'TRANSIT'],
    ];

    for (const [legacy, stored] of cases) {
      const res = await request(app)
        .post('/api/nodes')
        .set('Cookie', cookie)
        .send({ buildingId: building.id, floorNumber: 1, x: 1, y: 1, type: legacy });

      expect(res.status).toBe(200);
      expect(res.body.node.type).toBe(legacy);
      const row = await prisma.node.findUnique({ where: { id: res.body.node.id } });
      expect(row.type).toBe(stored);
    }
  });

  test('rejects invalid payloads with the legacy error shape', async () => {
    const { cookie, building } = await createOwnerWithBuilding();

    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', cookie)
      .send({ buildingId: building.id, floorNumber: 1, x: 'nope', y: 1, type: 'teleport' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        'Valid x, y coordinates are required',
        'Type must be path, exit, or stairs',
      ])
    );
  });

  test('connect writes one symmetric edge, visible from both nodes', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 300, y: 400 });

    const res = await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: building.id, node1Id: a.id, node2Id: b.id });

    expect(res.status).toBe(200);
    expect(res.body.data.connection.node1.connections).toContain(b.id);
    expect(res.body.data.connection.node2.connections).toContain(a.id);

    // One row, not two — symmetry is a property of the table now.
    const edges = await prisma.edge.findMany({ where: { buildingId: building.id } });
    expect(edges).toHaveLength(1);
    expect(edges[0].distance).toBe(500); // 3-4-5 triangle
  });

  test('rejects self-connection and duplicate connection', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 10, y: 0 });

    const self = await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: building.id, node1Id: a.id, node2Id: a.id });
    expect(self.status).toBe(400);
    expect(self.body.message).toMatch(/itself/i);

    await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: building.id, node1Id: a.id, node2Id: b.id });

    const dup = await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: building.id, node1Id: b.id, node2Id: a.id });
    expect(dup.status).toBe(400);
    expect(dup.body.message).toMatch(/already connected/i);
  });

  test('cross-building connection is refused', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const other = await createOwnerWithBuilding();
    const floorA = await createFloor(building.id, { floorNumber: 1 });
    const floorB = await createFloor(other.building.id, { floorNumber: 1 });
    const mine = await createNode(building.id, floorA.id, { x: 0, y: 0 });
    const theirs = await createNode(other.building.id, floorB.id, { x: 0, y: 0 });

    const res = await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: building.id, node1Id: mine.id, node2Id: theirs.id });

    expect(res.status).toBe(400);
    expect(await prisma.edge.count()).toBe(0);
  });

  test('updating connections adds and removes edges symmetrically', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 100, y: 0 });
    const c = await createNode(building.id, floor.id, { x: 200, y: 0 });

    // Attach both
    let res = await request(app)
      .put(`/api/nodes/${a.id}`)
      .set('Cookie', cookie)
      .send({ connections: [b.id, c.id] });
    expect(res.status).toBe(200);
    expect(res.body.node.connections.sort()).toEqual([b.id, c.id].sort());
    expect(await prisma.edge.count()).toBe(2);

    // Drop one — the reverse edge must go too, or the graph stays walkable
    // through a corridor the editor just deleted.
    res = await request(app)
      .put(`/api/nodes/${a.id}`)
      .set('Cookie', cookie)
      .send({ connections: [c.id] });
    expect(res.status).toBe(200);
    expect(res.body.node.connections).toEqual([c.id]);

    const listed = await request(app)
      .get(`/api/nodes/building/${building.id}`)
      .set('Cookie', cookie);
    const bRow = listed.body.nodes.find((n) => n.id === b.id);
    expect(bRow.connections).toEqual([]);
  });

  test('moving a node recomputes the distance of its edges', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 100, y: 0 });
    await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: building.id, node1Id: a.id, node2Id: b.id });

    await request(app).put(`/api/nodes/${b.id}`).set('Cookie', cookie).send({ x: 250 });

    const edge = await prisma.edge.findFirst({ where: { buildingId: building.id } });
    expect(edge.distance).toBe(250);
    expect(edge.weight).toBe(250);
  });

  test('deleting a node removes its edges', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 100, y: 0 });
    await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: building.id, node1Id: a.id, node2Id: b.id });

    const res = await request(app).delete(`/api/nodes/${a.id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.deletedNodeId).toBe(a.id);
    expect(await prisma.edge.count()).toBe(0);
    expect(await prisma.node.count()).toBe(1);
  });

  test('lists nodes ordered by floor, then position', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1 });
    const f2 = await createFloor(building.id, { floorNumber: 2 });
    await createNode(building.id, f2.id, { x: 5, y: 5 });
    await createNode(building.id, f1.id, { x: 50, y: 0 });
    await createNode(building.id, f1.id, { x: 10, y: 0 });

    const res = await request(app)
      .get(`/api/nodes/building/${building.id}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.nodes.map((n) => [n.floorNumber, n.x])).toEqual([
      [1, 10],
      [1, 50],
      [2, 5],
    ]);
  });

  test('a non-member cannot read or write another building graph', async () => {
    const { building } = await createOwnerWithBuilding();
    const stranger = await createUser();

    const read = await request(app)
      .get(`/api/nodes/building/${building.id}`)
      .set('Cookie', stranger.cookie);
    expect(read.status).toBe(403);

    const write = await request(app)
      .post('/api/nodes')
      .set('Cookie', stranger.cookie)
      .send({ buildingId: building.id, floorNumber: 1, x: 0, y: 0, type: 'path' });
    expect(write.status).toBe(403);
  });

  test('a Moderator (CAN_EDIT_MAP) can edit the graph', async () => {
    const { building, roles } = await createOwnerWithBuilding();
    const moderator = await createUser();
    await addMember(building.id, moderator.user.id, roles['Moderator'].id);

    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', moderator.cookie)
      .send({ buildingId: building.id, floorNumber: 1, x: 4, y: 4, type: 'exit' });

    expect(res.status).toBe(200);
    expect(res.body.node.type).toBe('exit');
  });
});
