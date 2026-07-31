import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import Node from '../models/node.model.js';
import BUILDINGS from '../models/building.model.js';
import { createOwnerWithBuilding, createNode, qrIdFor } from './helpers.js';

/**
 * The scan endpoint — what a person actually hits after scanning a QR during an
 * emergency. This is the most important request in the product, so it is
 * covered end to end, including the multi-floor case that previously did not
 * work at all in production.
 */

let building;

const connect = async (a, b) => {
  await Node.findByIdAndUpdate(a._id, { $addToSet: { connections: b._id } });
  await Node.findByIdAndUpdate(b._id, { $addToSet: { connections: a._id } });
};

beforeEach(async () => {
  ({ building } = await createOwnerWithBuilding());
});

describe('GET /api/qr/scan/route/:qrId', () => {
  test('returns a route to the exit for an anonymous scanner', async () => {
    const start = await createNode(building._id, { x: 0, y: 0, label: 'Corridor' });
    const exit = await createNode(building._id, { x: 100, y: 0, type: 'exit', label: 'Main Exit' });
    await connect(start, exit);

    // Deliberately no auth: an occupant scanning a wall QR has no account.
    const res = await request(app).get(`/api/qr/scan/route/${qrIdFor(start)}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.emergencyRoute.found).toBe(true);
    expect(res.body.data.emergencyRoute.path).toHaveLength(2);
    expect(res.body.data.emergencyRoute.exitNode.label).toBe('Main Exit');
    expect(res.body.data.buildingName).toBe('Test Building');
  });

  test('includes the full route across floors, not just the scanned floor', async () => {
    const start = await createNode(building._id, { floorNumber: 2, x: 0, y: 0, label: 'Office' });
    const stairsUp = await createNode(building._id, { floorNumber: 2, x: 10, y: 0, type: 'stairs', label: 'Stairs L2' });
    const stairsDown = await createNode(building._id, { floorNumber: 1, x: 10, y: 0, type: 'stairs', label: 'Stairs L1' });
    const exit = await createNode(building._id, { floorNumber: 1, x: 20, y: 0, type: 'exit', label: 'Ground Exit' });

    await connect(start, stairsUp);
    await connect(stairsUp, stairsDown);
    await connect(stairsDown, exit);

    const res = await request(app).get(`/api/qr/scan/route/${qrIdFor(start)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.emergencyRoute.found).toBe(true);
    expect(res.body.data.requiresFloorChange).toBe(true);
    expect(res.body.data.floorTransitions).toEqual([
      expect.objectContaining({ from: 2, to: 1, nodeType: 'stairs' }),
    ]);

    // routeNodes must carry the floor-1 steps too. allFloorNodes only has the
    // scanned floor, so the map could not draw the rest of the route from it.
    const floors = res.body.data.routeNodes.map((n) => n.floor);
    expect(floors).toEqual([2, 2, 1, 1]);
    expect(res.body.data.allFloorNodes.every((n) => n.floor === 2)).toBe(true);
  });

  test('reports when no exit is reachable instead of failing', async () => {
    const start = await createNode(building._id, { x: 0, y: 0 });
    const dead = await createNode(building._id, { x: 10, y: 0 });
    await connect(start, dead);

    const res = await request(app).get(`/api/qr/scan/route/${qrIdFor(start)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.emergencyRoute.found).toBe(false);
    expect(res.body.data.emergencyRoute.path).toEqual([]);
    // The floor map and node list are still returned so the page can render.
    expect(res.body.data.buildingName).toBe('Test Building');
  });

  test('increments the node scan count', async () => {
    const start = await createNode(building._id, { x: 0, y: 0 });
    const exit = await createNode(building._id, { x: 10, y: 0, type: 'exit' });
    await connect(start, exit);

    await request(app).get(`/api/qr/scan/route/${qrIdFor(start)}`).expect(200);

    // The write is fire-and-forget, so allow the event loop to flush it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await Node.findById(start._id)).scanCount).toBe(1);
  });

  test('rejects a malformed qr id', async () => {
    const res = await request(app).get('/api/qr/scan/route/not-a-qr-code');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid QR code format/);
  });

  test('rejects a qr id with non-ObjectId parts', async () => {
    const res = await request(app).get('/api/qr/scan/route/qr_abc_1_def');

    expect(res.status).toBe(400);
  });

  test('returns 404 for a node that does not exist', async () => {
    const res = await request(app).get(
      `/api/qr/scan/route/qr_${building._id}_1_${new mongoose.Types.ObjectId()}`
    );

    expect(res.status).toBe(404);
  });

  test('logs the scan when the building is in emergency mode', async () => {
    await BUILDINGS.findByIdAndUpdate(building._id, { emergencyMode: true });

    const start = await createNode(building._id, { x: 0, y: 0, label: 'Lobby' });
    const exit = await createNode(building._id, { x: 10, y: 0, type: 'exit' });
    await connect(start, exit);

    await request(app).get(`/api/qr/scan/route/${qrIdFor(start)}`).expect(200);

    const LOGS = mongoose.model('log');
    const logs = await LOGS.find({ buildingID: building._id, logType: 'scan' });
    expect(logs).toHaveLength(1);
    expect(logs[0].isEmergency).toBe(true);
  });

  test('does not log scans when the building is not in emergency mode', async () => {
    const start = await createNode(building._id, { x: 0, y: 0 });
    const exit = await createNode(building._id, { x: 10, y: 0, type: 'exit' });
    await connect(start, exit);

    await request(app).get(`/api/qr/scan/route/${qrIdFor(start)}`).expect(200);

    const LOGS = mongoose.model('log');
    expect(await LOGS.countDocuments({ buildingID: building._id })).toBe(0);
  });

  test('an invalid session cookie does not break the route', async () => {
    const start = await createNode(building._id, { x: 0, y: 0 });
    const exit = await createNode(building._id, { x: 10, y: 0, type: 'exit' });
    await connect(start, exit);

    // Regression: scan.js used jwt without importing it, so any request
    // carrying a cookie threw a ReferenceError and returned 500.
    const res = await request(app)
      .get(`/api/qr/scan/route/${qrIdFor(start)}`)
      .set('Cookie', ['userToken=garbage-token']);

    expect(res.status).toBe(200);
    expect(res.body.data.emergencyRoute.found).toBe(true);
  });
});
