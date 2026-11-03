import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createOwnerWithBuilding, createFloor, createNode, connectNodes, qrIdFor } from './helpers.js';

// FX-094: ScanEvent was only written for signed-in visitors, but almost every
// real scan is anonymous (a visitor with a phone camera), so building
// analytics undercounted scans by roughly the anonymous share. Every visitor
// scan now records an event; userId is null when nobody is signed in. Nothing
// identifying is stored for anonymous scans.

test('an anonymous QR scan is recorded against the building and sticker', async () => {
  const { building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { floorNumber: 1 });
  const here = await createNode(building.id, floor.id, { x: 0, y: 0 });
  const exit = await createNode(building.id, floor.id, { x: 40, y: 0, type: 'EMERGENCY_EXIT' });
  await connectNodes(here, exit);

  const res = await request(app).get(`/api/qr/scan/route/${qrIdFor(here, 1)}`);
  expect(res.status).toBe(200);

  const events = await prisma.scanEvent.findMany({ where: { buildingId: building.id } });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ userId: null, nodeId: here.id, buildingName: building.name });
});

test('an anonymous floor-QR scan is recorded too', async () => {
  const { building } = await createOwnerWithBuilding();
  await createFloor(building.id, { floorNumber: 1, name: 'Ground' });

  expect((await request(app).get(`/api/building/scan/${building.id}/Ground`)).status).toBe(200);
  const events = await prisma.scanEvent.findMany({ where: { buildingId: building.id } });
  expect(events).toHaveLength(1);
  expect(events[0].userId).toBeNull();
});
