import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import {
  createOwnerWithBuilding,
  createFloor,
  createNode,
  connectNodes,
  qrIdFor,
} from './helpers.js';

/**
 * CONTRACT TEST for GET /api/qr/scan/route/:qrId.
 *
 * Every printed QR code in the field funnels through this endpoint, and the
 * deployed SPA reads the exact field names asserted here. If one of these
 * assertions has to change, that is a breaking change to physical stickers on
 * walls — stop and think.
 */

async function seedScanScenario() {
  const { user, building } = await createOwnerWithBuilding();
  const floor1 = await createFloor(building.id, {
    floorNumber: 1,
    name: 'Ground',
    mapImageUrl: 'https://assets.example/f1.svg',
  });
  const start = await createNode(building.id, floor1.id, {
    x: 0,
    y: 0,
    type: 'NORMAL',
    label: 'Lobby',
  });
  const mid = await createNode(building.id, floor1.id, { x: 100, y: 0, type: 'NORMAL' });
  const exit = await createNode(building.id, floor1.id, {
    x: 200,
    y: 0,
    type: 'EMERGENCY_EXIT',
    label: 'Main Exit',
  });
  await connectNodes(start, mid);
  await connectNodes(mid, exit);
  return { user, building, floor1, start, mid, exit };
}

describe('GET /api/qr/scan/route/:qrId — legacy envelope contract', () => {
  test('resolves a QR slug and returns every legacy field', async () => {
    const { building, floor1, start, mid, exit } = await seedScanScenario();
    const qrId = qrIdFor(start, floor1.floorNumber);

    const res = await request(app).get(`/api/qr/scan/route/${qrId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const data = res.body.data;
    // Top-level legacy contract fields
    expect(data.qrId).toBe(qrId);
    expect(data.buildingId).toBe(building.id);
    expect(data.buildingName).toBe(building.name);
    expect(data.floorNumber).toBe('1');
    expect(data.nodeId).toBe(start.id);
    expect(data.nodeType).toBe('path'); // legacy vocabulary
    expect(data.nodeLabel).toBe('Lobby');
    expect(data.nodePosition).toEqual({ x: 0, y: 0 });
    expect(Array.isArray(data.connectedNodes)).toBe(true);
    expect(Array.isArray(data.allFloorNodes)).toBe(true);
    expect(Array.isArray(data.routeNodes)).toBe(true);
    expect(Array.isArray(data.floorTransitions)).toBe(true);
    expect(typeof data.requiresFloorChange).toBe('boolean');
    expect(typeof data.timestamp).toBe('string');
    expect(typeof data.scanCount).toBe('number');

    // connectedNodes: the single neighbour, in legacy shape
    expect(data.connectedNodes).toHaveLength(1);
    expect(data.connectedNodes[0]).toMatchObject({
      id: mid.id,
      type: 'path',
      floor: 1,
    });
    expect(data.connectedNodes[0].connections).toContain(start.id);

    // emergencyRoute block
    const er = data.emergencyRoute;
    expect(er.found).toBe(true);
    expect(er.exitNodeId).toBe(exit.id);
    expect(er.path).toEqual([start.id, mid.id, exit.id]);
    expect(er.distance).toBe(2); // hop count
    expect(er.walkingDistance).toBe(200);
    expect(er.exitNode).toMatchObject({ id: exit.id, type: 'exit', label: 'Main Exit', floor: 1 });

    // floorMap from the Floor row
    expect(data.floorMap).toMatchObject({
      floor: 'Ground',
      map: 'https://assets.example/f1.svg',
      imageUrl: 'https://assets.example/f1.svg',
    });

    // A floor with no drawing sends an explicit null, not a missing key —
    // the scan page branches on it. Canvas size mirrors the row.
    expect(data.floorMap.drawing).toBeNull();
    expect(data.floorMap.width).toBe(floor1.width ?? null);
    expect(data.floorMap.height).toBe(floor1.height ?? null);

    // Additions for the redesigned viewer (must not replace legacy fields)
    expect(data.emergency).toEqual({ active: false, message: null, emergencyId: null });
    expect(data.route).toMatchObject({ mode: 'EVACUATION' });
    expect(data.route.segments[0].nodes.map((n) => n.id)).toEqual([
      start.id,
      mid.id,
      exit.id,
    ]);
  });

  test('a hand-drawn floor plan travels in floorMap with its canvas size', async () => {
    const { building } = await createOwnerWithBuilding();
    const drawing = {
      version: 1,
      shapes: [{ id: 'a', kind: 'room', x: 0, y: 0, width: 100, height: 50, name: 'Lobby' }],
    };
    const floor = await createFloor(building.id, {
      floorNumber: 1,
      name: 'Drawn',
      drawing,
      width: 500,
      height: 400,
    });
    const node = await createNode(building.id, floor.id, { x: 10, y: 10, type: 'NORMAL' });

    const res = await request(app).get(
      `/api/qr/scan/route/${qrIdFor(node, floor.floorNumber)}`,
    );
    expect(res.status).toBe(200);

    // The drawn plan and its canvas size ride along, so the scan page can
    // render exactly what the owner drew — there is no image to fall back on.
    expect(res.body.data.floorMap.drawing).toEqual(drawing);
    expect(res.body.data.floorMap.width).toBe(500);
    expect(res.body.data.floorMap.height).toBe(400);
  });

  test('multi-floor route reports transitions and requiresFloorChange', async () => {
    const { building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1 });
    const f2 = await createFloor(building.id, { floorNumber: 2 });
    const start = await createNode(building.id, f1.id, { x: 0, y: 0 });
    const stairs1 = await createNode(building.id, f1.id, { x: 50, y: 0, type: 'TRANSIT' });
    const stairs2 = await createNode(building.id, f2.id, { x: 50, y: 0, type: 'TRANSIT' });
    const exit2 = await createNode(building.id, f2.id, { x: 80, y: 0, type: 'EMERGENCY_EXIT' });
    await connectNodes(start, stairs1);
    await connectNodes(stairs1, stairs2, { transitType: 'STAIRS', weight: 400, distance: 0 });
    await connectNodes(stairs2, exit2);

    const res = await request(app).get(`/api/qr/scan/route/${qrIdFor(start, 1)}`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.requiresFloorChange).toBe(true);
    expect(data.floorTransitions).toHaveLength(1);
    expect(data.floorTransitions[0]).toMatchObject({ from: 1, to: 2 });
    expect(data.emergencyRoute.path).toEqual([start.id, stairs1.id, stairs2.id, exit2.id]);
    expect(data.route.transitions[0]).toMatchObject({
      transitType: 'STAIRS',
      fromFloorNumber: 1,
      toFloorNumber: 2,
      direction: 'up',
    });
  });

  test('emergency mode: payload carries active emergency and scan is counted', async () => {
    const { building, floor1, start } = await seedScanScenario();
    await prisma.building.update({
      where: { id: building.id },
      data: { emergencyMode: true, emergencyMessage: 'Fire drill in progress' },
    });
    const event = await prisma.emergencyEvent.create({
      data: { buildingId: building.id },
    });

    const res = await request(app).get(
      `/api/qr/scan/route/${qrIdFor(start, floor1.floorNumber)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.emergency).toEqual({
      active: true,
      message: 'Fire drill in progress',
      emergencyId: event.id,
    });

    const updatedEvent = await prisma.emergencyEvent.findUnique({
      where: { id: event.id },
    });
    expect(updatedEvent.scanned).toBe(1);
    const log = await prisma.log.findFirst({ where: { buildingId: building.id } });
    expect(log.type).toBe('SCAN');
    expect(log.isEmergency).toBe(true);
  });

  test('rejects malformed slugs and unknown nodes like the old endpoint', async () => {
    const bad = await request(app).get('/api/qr/scan/route/not-a-qr');
    expect(bad.status).toBe(400);
    expect(bad.body.success).toBe(false);

    const { building } = await seedScanScenario();
    const ghost = await request(app).get(
      `/api/qr/scan/route/qr_${building.id}_9_${'0'.repeat(24)}`
    );
    expect(ghost.status).toBe(404);
  });

  test('node with no reachable exit still returns 200 with found:false', async () => {
    const { building } = await createOwnerWithBuilding();
    const f1 = await createFloor(building.id, { floorNumber: 1 });
    const lonely = await createNode(building.id, f1.id, { x: 0, y: 0, label: 'Isolated' });

    const res = await request(app).get(`/api/qr/scan/route/${qrIdFor(lonely, 1)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.emergencyRoute.found).toBe(false);
    expect(res.body.data.emergencyRoute.message).toBe(
      'No exit route found from this location'
    );
    expect(res.body.data.route).toBeNull();
  });
});
