import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import Node from '../models/node.model.js';
import { createOwnerWithBuilding, createUser, createNode } from './helpers.js';

/**
 * Node management API: creating the graph an evacuation route is computed from.
 * Ownership matters here — one building owner must not be able to edit another
 * owner's escape routes.
 */

let owner;
let cookie;
let building;

beforeEach(async () => {
  ({ user: owner, cookie, building } = await createOwnerWithBuilding());
});

describe('POST /api/nodes', () => {
  test('creates a node for the owner', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', cookie)
      .send({ buildingId: String(building._id), floorNumber: 1, x: 10, y: 20, type: 'exit', label: 'Main Exit' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.node.type).toBe('exit');

    expect(await Node.countDocuments({ buildingId: building._id })).toBe(1);
  });

  test('rejects an unauthenticated request', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .send({ buildingId: String(building._id), floorNumber: 1, x: 10, y: 20, type: 'exit' });

    expect(res.body.Success).toBe(false);
    expect(await Node.countDocuments({})).toBe(0);
  });

  test('rejects a user who does not own the building', async () => {
    const stranger = await createUser();

    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', stranger.cookie)
      .send({ buildingId: String(building._id), floorNumber: 1, x: 10, y: 20, type: 'exit' });

    expect(res.status).toBe(403);
    expect(await Node.countDocuments({})).toBe(0);
  });

  test('rejects an invalid node type', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', cookie)
      .send({ buildingId: String(building._id), floorNumber: 1, x: 10, y: 20, type: 'teleporter' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expect.arrayContaining([expect.stringContaining('Type must be')]));
  });

  test('rejects missing coordinates', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', cookie)
      .send({ buildingId: String(building._id), floorNumber: 1, type: 'path' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/nodes/building/:buildingId', () => {
  test('returns the building nodes for the owner', async () => {
    await createNode(building._id, { x: 1, y: 1 });
    await createNode(building._id, { x: 2, y: 2, type: 'exit' });

    const res = await request(app)
      .get(`/api/nodes/building/${building._id}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(2);
  });

  test('does not expose another owner\'s nodes', async () => {
    await createNode(building._id);
    const stranger = await createUser();

    const res = await request(app)
      .get(`/api/nodes/building/${building._id}`)
      .set('Cookie', stranger.cookie);

    expect(res.status).toBe(403);
  });
});

describe('POST /api/nodes/connect', () => {
  test('connects two nodes bidirectionally', async () => {
    const a = await createNode(building._id, { x: 0, y: 0 });
    const b = await createNode(building._id, { x: 10, y: 0 });

    const res = await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: String(building._id), node1Id: String(a._id), node2Id: String(b._id) });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const [freshA, freshB] = await Promise.all([Node.findById(a._id), Node.findById(b._id)]);
    expect(freshA.connections.map(String)).toContain(String(b._id));
    expect(freshB.connections.map(String)).toContain(String(a._id));
  });

  test('refuses to connect a node to itself', async () => {
    const a = await createNode(building._id);

    const res = await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: String(building._id), node1Id: String(a._id), node2Id: String(a._id) });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/itself/i);
  });

  test('refuses a duplicate connection', async () => {
    const a = await createNode(building._id);
    const b = await createNode(building._id, { x: 5, y: 5 });
    const payload = { buildingId: String(building._id), node1Id: String(a._id), node2Id: String(b._id) };

    await request(app).post('/api/nodes/connect').set('Cookie', cookie).send(payload).expect(200);
    const res = await request(app).post('/api/nodes/connect').set('Cookie', cookie).send(payload);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already connected/i);
  });

  test('refuses to connect nodes from a different building', async () => {
    const a = await createNode(building._id);
    const otherBuildingId = new mongoose.Types.ObjectId();
    const foreign = await createNode(otherBuildingId);

    const res = await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: String(building._id), node1Id: String(a._id), node2Id: String(foreign._id) });

    expect(res.status).toBe(400);
  });

  test('requires all three ids', async () => {
    const res = await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: String(building._id) });

    expect(res.status).toBe(400);
  });
});

describe('PUT /api/nodes/:nodeId', () => {
  test('updates coordinates and type', async () => {
    const node = await createNode(building._id);

    const res = await request(app)
      .put(`/api/nodes/${node._id}`)
      .set('Cookie', cookie)
      .send({ x: 500, y: 600, type: 'stairs', label: 'North Stairs' });

    expect(res.status).toBe(200);
    expect(res.body.node.x).toBe(500);
    expect(res.body.node.type).toBe('stairs');
    expect(res.body.node.label).toBe('North Stairs');
  });

  test('rejects a negative coordinate', async () => {
    const node = await createNode(building._id);

    const res = await request(app)
      .put(`/api/nodes/${node._id}`)
      .set('Cookie', cookie)
      .send({ x: -5 });

    expect(res.status).toBe(400);
  });

  test('rejects an update from a non-owner', async () => {
    const node = await createNode(building._id);
    const stranger = await createUser();

    const res = await request(app)
      .put(`/api/nodes/${node._id}`)
      .set('Cookie', stranger.cookie)
      .send({ x: 999 });

    expect(res.status).toBe(403);
    expect((await Node.findById(node._id)).x).toBe(100);
  });
});

describe('DELETE /api/nodes/:nodeId', () => {
  test('deletes the node and detaches it from its neighbours', async () => {
    const a = await createNode(building._id, { x: 0, y: 0 });
    const b = await createNode(building._id, { x: 10, y: 0 });

    await request(app)
      .post('/api/nodes/connect')
      .set('Cookie', cookie)
      .send({ buildingId: String(building._id), node1Id: String(a._id), node2Id: String(b._id) })
      .expect(200);

    const res = await request(app).delete(`/api/nodes/${a._id}`).set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(await Node.findById(a._id)).toBeNull();

    // The surviving node must not keep a dangling edge to the deleted one.
    const survivor = await Node.findById(b._id);
    expect(survivor.connections.map(String)).not.toContain(String(a._id));
  });

  test('returns 404 for a node that does not exist', async () => {
    const res = await request(app)
      .delete(`/api/nodes/${new mongoose.Types.ObjectId()}`)
      .set('Cookie', cookie);

    expect(res.status).toBe(404);
  });

  test('rejects deletion by a non-owner', async () => {
    const node = await createNode(building._id);
    const stranger = await createUser();

    const res = await request(app).delete(`/api/nodes/${node._id}`).set('Cookie', stranger.cookie);

    expect(res.status).toBe(403);
    expect(await Node.findById(node._id)).not.toBeNull();
  });
});
