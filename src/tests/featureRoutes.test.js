import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import {
  createUser,
  createOwnerWithBuilding,
  createFloor,
  createNode,
  connectNodes,
  addMember,
} from './helpers.js';

// Integration coverage for the new feature routers: map editor, wayfinding,
// emergency v2.

describe('map editor API', () => {
  test('floor + node + edge + POI lifecycle with permission gating', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();

    // Floor create (no image — S3 guard covers uploads elsewhere)
    const floorRes = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '1')
      .field('name', 'Ground Floor')
      .field('scalePixelsPerMeter', '10');
    expect(floorRes.status).toBe(201);
    const floor = floorRes.body.data.floor;
    expect(floor.scalePixelsPerMeter).toBe(10);

    // Duplicate floor number → 409
    const dupFloor = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '1');
    expect(dupFloor.status).toBe(409);

    // Nodes
    const nodeA = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/nodes`)
      .set('Cookie', cookie)
      .send({ x: 10, y: 10, type: 'ENTRANCE', label: 'Main door' });
    expect(nodeA.status).toBe(201);
    const nodeB = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/nodes`)
      .set('Cookie', cookie)
      .send({ x: 110, y: 10, type: 'NORMAL' });
    expect(nodeB.status).toBe(201);
    const a = nodeA.body.data.node;
    const b = nodeB.body.data.node;

    // Every node is printable the moment it exists — the slug is not deferred
    // until someone opens the QR dialog.
    expect(a.qrSlug).toBe(`qr_${building.id}_1_${a.id}`);
    expect(b.qrSlug).toBe(`qr_${building.id}_1_${b.id}`);

    // Edge
    const edgeRes = await request(app)
      .post('/api/map-editor/edges')
      .set('Cookie', cookie)
      .send({ sourceNodeId: a.id, targetNodeId: b.id, buildingId: building.id });
    expect(edgeRes.status).toBe(201);
    expect(edgeRes.body.data.edge.distance).toBe(100);
    expect(edgeRes.body.data.edge.weight).toBe(100);

    // Duplicate edge → 409
    const dupEdge = await request(app)
      .post('/api/map-editor/edges')
      .set('Cookie', cookie)
      .send({ sourceNodeId: b.id, targetNodeId: a.id, buildingId: building.id });
    expect(dupEdge.status).toBe(409);

    // Moving a node recomputes edge distance
    const move = await request(app)
      .patch(`/api/map-editor/nodes/${b.id}`)
      .set('Cookie', cookie)
      .send({ x: 210 });
    expect(move.status).toBe(200);
    const movedEdge = await prisma.edge.findFirst({ where: { buildingId: building.id } });
    expect(movedEdge.distance).toBe(200);
    expect(movedEdge.weight).toBe(200); // weight tracked distance

    // POI upsert flips node type
    const poiRes = await request(app)
      .put(`/api/map-editor/nodes/${b.id}/poi`)
      .set('Cookie', cookie)
      .send({ name: 'LC Waikiki', category: 'Apparel', keywords: ['Clothes', 'fashion '] });
    expect(poiRes.status).toBe(200);
    expect(poiRes.body.data.poi.keywords).toEqual(['clothes', 'fashion']);
    const poiNode = await prisma.node.findUnique({ where: { id: b.id } });
    expect(poiNode.type).toBe('POI');

    // Viewer member cannot edit the map
    const viewer = await createUser();
    await addMember(building.id, viewer.user.id, roles['Viewer'].id);
    const denied = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/nodes`)
      .set('Cookie', viewer.cookie)
      .send({ x: 1, y: 1, type: 'NORMAL' });
    expect(denied.status).toBe(403);

    // Moderator (CAN_EDIT_MAP) can
    const moderator = await createUser();
    await addMember(building.id, moderator.user.id, roles['Moderator'].id);
    const allowed = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/nodes`)
      .set('Cookie', moderator.cookie)
      .send({ x: 1, y: 1, type: 'NORMAL' });
    expect(allowed.status).toBe(201);
  });

  test('floor capacity follows the owner plan: 2 free, 4 Starter, 10 Business', async () => {
    const { cookie, building, user } = await createOwnerWithBuilding();

    // Free: two floors, then the wall.
    for (let n = 1; n <= 2; n += 1) {
      const res = await request(app)
        .post(`/api/map-editor/buildings/${building.id}/floors`)
        .set('Cookie', cookie)
        .field('floorNumber', String(n));
      expect(res.status).toBe(201);
    }
    const third = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '3');
    expect(third.status).toBe(403);
    expect(third.body.message).toMatch(/limit of 2 floors/);

    // Starter: floors 3-4 fit, the 5th is refused with an upgrade nudge.
    await prisma.user.update({ where: { id: user.id }, data: { plan: 'STARTER' } });
    for (let n = 3; n <= 4; n += 1) {
      const res = await request(app)
        .post(`/api/map-editor/buildings/${building.id}/floors`)
        .set('Cookie', cookie)
        .field('floorNumber', String(n));
      expect(res.status).toBe(201);
    }
    const fifth = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '5');
    expect(fifth.status).toBe(403);
    expect(fifth.body.message).toMatch(/limit of 4 floors/);

    // Business unlocks up to 10.
    await prisma.user.update({ where: { id: user.id }, data: { plan: 'BUSINESS' } });
    for (let n = 5; n <= 10; n += 1) {
      const res = await request(app)
        .post(`/api/map-editor/buildings/${building.id}/floors`)
        .set('Cookie', cookie)
        .field('floorNumber', String(n));
      expect(res.status).toBe(201);
    }
    const eleventh = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '11');
    expect(eleventh.status).toBe(403);
    expect(eleventh.body.message).toMatch(/limit of 10 floors/);
  });

  test('transit links require different floors; validation reports issues', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1 });
    const f2 = await createFloor(building.id, { floorNumber: 2 });
    const t1 = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'TRANSIT' });
    const t1b = await createNode(building.id, f1.id, { x: 9, y: 0, type: 'TRANSIT' });
    const t2 = await createNode(building.id, f2.id, { x: 0, y: 0, type: 'TRANSIT' });

    const sameFloor = await request(app)
      .post('/api/map-editor/transit-links')
      .set('Cookie', cookie)
      .send({ nodeIds: [t1.id, t1b.id], transitType: 'ELEVATOR', buildingId: building.id });
    expect(sameFloor.status).toBe(422);

    const link = await request(app)
      .post('/api/map-editor/transit-links')
      .set('Cookie', cookie)
      .send({ nodeIds: [t1.id, t2.id], transitType: 'ELEVATOR', buildingId: building.id });
    expect(link.status).toBe(201);
    expect(link.body.data.edge.transitType).toBe('ELEVATOR');
    expect(link.body.data.edge.accessible).toBe(true);
    expect(link.body.data.edge.weight).toBe(300);

    const validation = await request(app)
      .get(`/api/map-editor/buildings/${building.id}/validate`)
      .set('Cookie', cookie);
    expect(validation.status).toBe(200);
    expect(validation.body.data.ok).toBe(false); // no exits anywhere
    const codes = validation.body.data.issues.map((i) => i.code);
    expect(codes).toContain('NO_EXIT');
    expect(codes).toContain('ORPHAN_NODE'); // t1b has no edges
  });

  test('auto-connect wires the floor once, respects walls, and is idempotent', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, {
      floorNumber: 1,
      drawing: {
        version: 1,
        // Vertical wall at x=500 spanning y 0..800 — splits the floor.
        shapes: [{ id: 'w', kind: 'wall', points: [500, 0, 500, 800], thickness: 6 }],
      },
    });
    const a = await createNode(building.id, floor.id, { x: 100, y: 100 });
    const b = await createNode(building.id, floor.id, { x: 300, y: 100 });
    const c = await createNode(building.id, floor.id, { x: 900, y: 100 });

    const first = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/auto-connect`)
      .set('Cookie', cookie);
    expect(first.status).toBe(200);

    const createdPairs = first.body.data.edges.map((e) =>
      [e.sourceNodeId, e.targetNodeId].sort().join(':'),
    );
    // a-b connect; nothing crosses the wall to c.
    expect(createdPairs).toContain([a.id, b.id].sort().join(':'));
    expect(createdPairs.some((k) => k.includes(c.id))).toBe(false);

    // Second run: nothing left to do.
    const second = await request(app)
      .post(`/api/map-editor/floors/${floor.id}/auto-connect`)
      .set('Cookie', cookie);
    expect(second.status).toBe(200);
    expect(second.body.data.edges).toHaveLength(0);
  });

  test('a hand-drawn floor plan round-trips through create, patch and clear', async () => {
    const { cookie, building } = await createOwnerWithBuilding();

    // A floor drawn rather than uploaded carries its own canvas size, derived
    // from the room dimensions the user typed.
    const created = await request(app)
      .post(`/api/map-editor/buildings/${building.id}/floors`)
      .set('Cookie', cookie)
      .field('floorNumber', '1')
      .field('width', '1000')
      .field('height', '800')
      .field('scalePixelsPerMeter', '50');
    expect(created.status).toBe(201);
    const floor = created.body.data.floor;
    expect(floor.width).toBe(1000);
    expect(floor.height).toBe(800);

    // Drawings travel as a JSON string in a multipart field.
    const drawing = {
      version: 1,
      shapes: [
        { id: 'a', kind: 'room', x: 0, y: 0, width: 100, height: 50, name: 'Lobby' },
        {
          id: 'b',
          kind: 'shop',
          x: 200,
          y: 0,
          width: 80,
          height: 60,
          name: 'Cafe',
          logoUrl: 'javascript:alert(1)', // must not survive
        },
        { id: 'c', kind: 'icon', x: 40, y: 40, icon: 'ELEVATOR' },
        { id: 'd', kind: 'nonsense', x: 0, y: 0 }, // unknown kind, dropped
      ],
    };

    const patched = await request(app)
      .patch(`/api/map-editor/floors/${floor.id}`)
      .set('Cookie', cookie)
      .field('drawing', JSON.stringify(drawing));
    expect(patched.status).toBe(200);

    const saved = patched.body.data.floor.drawing;
    expect(saved.shapes.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    // The dangerous URL is stripped rather than the whole save being rejected.
    expect(saved.shapes[1].logoUrl).toBeUndefined();
    expect(saved.shapes[1].name).toBe('Cafe');

    // The graph endpoint the editor loads from hands the drawing back.
    const graph = await request(app)
      .get(`/api/map-editor/buildings/${building.id}/graph`)
      .set('Cookie', cookie);
    expect(graph.status).toBe(200);
    expect(graph.body.data.floors[0].drawing.shapes).toHaveLength(3);

    // An empty field clears the drawing without touching anything else.
    const cleared = await request(app)
      .patch(`/api/map-editor/floors/${floor.id}`)
      .set('Cookie', cookie)
      .field('drawing', '');
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.floor.drawing).toBeNull();
    expect(cleared.body.data.floor.width).toBe(1000); // untouched

    // An oversized shape list is refused outright.
    const tooMany = await request(app)
      .patch(`/api/map-editor/floors/${floor.id}`)
      .set('Cookie', cookie)
      .field(
        'drawing',
        JSON.stringify({
          shapes: Array.from({ length: 2001 }, () => ({
            kind: 'icon',
            x: 0,
            y: 0,
            icon: 'WC',
          })),
        }),
      );
    expect(tooMany.status).toBe(422);
  });
});

describe('wayfinding API', () => {
  async function seedMall() {
    const seeded = await createOwnerWithBuilding();
    const { building } = seeded;
    const f1 = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const f4 = await createFloor(building.id, { floorNumber: 4, scalePixelsPerMeter: 10 });
    const entrance = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'ENTRANCE' });
    const esc1 = await createNode(building.id, f1.id, { x: 100, y: 0, type: 'TRANSIT', label: 'Escalator A' });
    const esc4 = await createNode(building.id, f4.id, { x: 100, y: 0, type: 'TRANSIT', label: 'Escalator A' });
    const shopNode = await createNode(building.id, f4.id, { x: 300, y: 0, type: 'POI' });
    const exit1 = await createNode(building.id, f1.id, { x: 50, y: 50, type: 'EMERGENCY_EXIT' });
    await connectNodes(entrance, esc1);
    await connectNodes(esc1, esc4, { transitType: 'ESCALATOR', weight: 350, distance: 0, accessible: false });
    await connectNodes(esc4, shopNode);
    await connectNodes(entrance, exit1);
    const poi = await prisma.poi.create({
      data: {
        nodeId: shopNode.id,
        name: 'LC Waikiki',
        category: 'Apparel',
        keywords: ['clothes', 'fashion'],
      },
    });
    return { ...seeded, f1, f4, entrance, esc1, esc4, shopNode, exit1, poi };
  }

  test('POI search matches name and keywords', async () => {
    const { building } = await seedMall();
    const byName = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/pois?q=waikiki`
    );
    expect(byName.status).toBe(200);
    expect(byName.body.data.pois).toHaveLength(1);
    expect(byName.body.data.pois[0]).toMatchObject({
      name: 'LC Waikiki',
      floorNumber: 4,
    });

    const byKeyword = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/pois?q=clothes`
    );
    expect(byKeyword.body.data.pois).toHaveLength(1);
  });

  test('directory: POIs, named drawn rooms and labeled nodes — doors excluded', async () => {
    const { building } = await createOwnerWithBuilding();

    const corridorNode = { x: 120, y: 120 }; // near the drawn room below
    const floor = await createFloor(building.id, {
      floorNumber: 1,
      name: 'Ground',
      drawing: {
        version: 1,
        shapes: [
          // Named room with NO linked node: still a destination — it routes
          // via the nearest node in range.
          { id: 'r1', kind: 'room', x: 50, y: 50, width: 100, height: 100, name: 'Waikiki' },
          // Named room too far from any node: unroutable, so omitted.
          { id: 'r2', kind: 'room', x: 5000, y: 5000, width: 50, height: 50, name: 'Far Room' },
          // Door marker: navigation furniture, not a destination.
          { id: 'd1', kind: 'icon', x: 60, y: 60, icon: 'DOOR', nodeId: 'DOOR_NODE' },
        ],
      },
    });

    const near = await createNode(building.id, floor.id, {
      ...corridorNode, type: 'NORMAL',
    });
    const poiNode = await createNode(building.id, floor.id, { x: 10, y: 10, type: 'POI' });
    await prisma.poi.create({
      data: { nodeId: poiNode.id, name: 'Cafe Aroma', category: 'coffee' },
    });
    const exit = await createNode(building.id, floor.id, {
      x: 300, y: 10, type: 'EMERGENCY_EXIT', label: 'Main Exit',
    });
    const doorNode = await createNode(building.id, floor.id, {
      x: 62, y: 62, type: 'NORMAL', label: 'Door',
    });
    // Point the drawing's door marker at the real node id.
    await prisma.floor.update({
      where: { id: floor.id },
      data: {
        drawing: {
          version: 1,
          shapes: [
            { id: 'r1', kind: 'room', x: 50, y: 50, width: 100, height: 100, name: 'Waikiki' },
            { id: 'r2', kind: 'room', x: 5000, y: 5000, width: 50, height: 50, name: 'Far Room' },
            { id: 'd1', kind: 'icon', x: 60, y: 60, icon: 'DOOR', nodeId: doorNode.id },
          ],
        },
      },
    });
    // Unlabeled node: not a destination anyone can name — stays out.
    await createNode(building.id, floor.id, { x: 90, y: 10, type: 'NORMAL' });

    const res = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/directory`,
    );
    expect(res.status).toBe(200);

    const entries = res.body.data.entries;
    expect(entries.map((e) => e.name)).toEqual(['Cafe Aroma', 'Main Exit', 'Waikiki']);

    // The drawn room routes via the nearest in-range node.
    const waikiki = entries.find((e) => e.name === 'Waikiki');
    expect(waikiki).toMatchObject({ kind: 'shape', nodeId: near.id, floorNumber: 1 });

    // Doors are not searchable; the far room is unroutable and omitted.
    expect(entries.some((e) => e.name === 'Door')).toBe(false);
    expect(entries.some((e) => e.name === 'Far Room')).toBe(false);
    expect(entries.find((e) => e.name === 'Main Exit')).toMatchObject({
      kind: 'node', nodeId: exit.id, nodeType: 'EMERGENCY_EXIT',
    });
  });

  test('multi-floor route to a POI returns stepper segments', async () => {
    const { entrance, poi } = await seedMall();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}`
    );
    expect(res.status).toBe(200);
    const route = res.body.data.route;
    expect(route.mode).toBe('WAYFINDING');
    expect(route.destination.poi.name).toBe('LC Waikiki');
    expect(route.segments).toHaveLength(2);
    expect(route.transitions).toHaveLength(1);
    expect(route.transitions[0]).toMatchObject({
      transitType: 'ESCALATOR',
      fromFloorNumber: 1,
      toFloorNumber: 4,
      direction: 'up',
      label: 'Escalator A',
    });
    expect(route.steps.map((s) => s.kind)).toEqual(['walk', 'transit', 'walk', 'arrive']);
    // meters via scalePixelsPerMeter=10: floor1 100px=10m, floor4 200px=20m
    expect(route.totalDistanceMeters).toBe(30);
  });

  test('accessible route falls back with a flag when only escalators exist', async () => {
    const { entrance, poi } = await seedMall();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}&accessible=true`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.route.accessibleRouteUnavailable).toBe(true);
  });

  test('evacuation route finds nearest exit', async () => {
    const { entrance, exit1 } = await seedMall();
    const res = await request(app).get(`/api/wayfinding/evacuate?from=${entrance.id}`);
    expect(res.status).toBe(200);
    const route = res.body.data.route;
    expect(route.mode).toBe('EVACUATION');
    expect(route.destination.nodeId).toBe(exit1.id);
    expect(route.segments).toHaveLength(1);
  });
});

/** Fetch and solve an arming challenge — the human check on the switch. */
const solvedChallenge = async (cookie) => {
  const res = await request(app).get('/api/emergency/challenge').set('Cookie', cookie);
  const { token, question } = res.body.data;
  const [a, b] = question.split(' + ').map(Number);
  return { token, answer: a + b };
};

describe('emergency v2 API', () => {
  test('trigger/resolve are idempotent and permission-gated', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();

    // No challenge → refused before anything arms. 428 tells the client this
    // is a missing step, not a permissions problem.
    const bare = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ message: 'Fire on floor 2' });
    expect(bare.status).toBe(428);

    // Wrong answer → refused.
    const wrong = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ message: 'x', challenge: { ...(await solvedChallenge(cookie)), answer: -1 } });
    expect(wrong.status).toBe(403);

    const trigger = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ message: 'Fire on floor 2', challenge: await solvedChallenge(cookie) });
    expect(trigger.status).toBe(200);
    expect(trigger.body.data.alreadyActive).toBe(false);
    const emergencyId = trigger.body.data.emergencyId;
    expect(emergencyId).toBeTruthy();

    const again = await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ challenge: await solvedChallenge(cookie) });
    expect(again.body.data.alreadyActive).toBe(true);
    expect(again.body.data.emergencyId).toBe(emergencyId);

    // Public status
    const status = await request(app).get(
      `/api/emergency/buildings/${building.id}/status`
    );
    expect(status.body.data).toMatchObject({
      isEmergency: true,
      message: 'Fire on floor 2',
      emergencyId,
    });

    // Viewer cannot trigger/resolve
    const viewer = await createUser();
    await addMember(building.id, viewer.user.id, roles['Viewer'].id);
    const denied = await request(app)
      .post(`/api/emergency/buildings/${building.id}/resolve`)
      .set('Cookie', viewer.cookie)
      .send({ challenge: await solvedChallenge(viewer.cookie) });
    expect(denied.status).toBe(403);

    // Security Officer can resolve
    const officer = await createUser();
    await addMember(building.id, officer.user.id, roles['Security Officer'].id);
    const resolve = await request(app)
      .post(`/api/emergency/buildings/${building.id}/resolve`)
      .set('Cookie', officer.cookie)
      .send({ challenge: await solvedChallenge(officer.cookie) });
    expect(resolve.status).toBe(200);
    expect(resolve.body.data.alreadyResolved).toBe(false);

    const event = await prisma.emergencyEvent.findUnique({ where: { id: emergencyId } });
    expect(event.status).toBe('RESOLVED');
    expect(event.endedAt).toBeTruthy();

    const after = await request(app).get(
      `/api/emergency/buildings/${building.id}/status`
    );
    expect(after.body.data.isEmergency).toBe(false);
    expect(after.body.data.message).toBeNull();
  });

  test('anonymous evacuated/called actions count on the open event (incl. legacy aliases)', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    await request(app)
      .post(`/api/emergency/buildings/${building.id}/trigger`)
      .set('Cookie', cookie)
      .send({ challenge: await solvedChallenge(cookie) });

    const evac = await request(app).post(
      `/api/emergency/buildings/${building.id}/evacuated`
    );
    expect(evac.status).toBe(200);

    // Legacy alias with body-supplied buildingId
    const legacy = await request(app)
      .post('/api/building/evacuated')
      .send({ buildingId: building.id });
    expect(legacy.status).toBe(200);

    const called = await request(app)
      .post('/api/building/emergencyCall')
      .send({ buildingId: building.id });
    expect(called.status).toBe(200);

    const event = await prisma.emergencyEvent.findFirst({
      where: { buildingId: building.id, status: 'ACTIVE' },
    });
    expect(event.evacuated).toBe(2);
    expect(event.calledEmergency).toBe(1);
  });
});
