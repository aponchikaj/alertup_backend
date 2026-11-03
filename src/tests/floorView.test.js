import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createUser, createOwnerWithBuilding, createFloor } from './helpers.js';

/* ============================================================================
   FX-022 — looking at your own floor is not a QR scan.

   GET /api/building/scan/:id/:floor serves two audiences: a visitor who
   scanned a printed floor QR (which opens /building/:id/:floor) and the
   owner viewing the same page from the dashboard. Every owner page view used
   to bump scanCount, write a ScanEvent and, during an emergency, log "Floor
   QR has been scanned" into the live incident feed. Only a visitor counts.
   ========================================================================= */

test("the owner viewing their floor does not count as a scan", async () => {
  const { cookie, building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { floorNumber: 1, name: 'Ground', svgContent: '<svg/>' });

  const res = await request(app).get(`/api/building/scan/${building.id}/Ground`).set('Cookie', cookie);

  expect(res.status).toBe(200);
  expect(res.body.data.floorData).toBeTruthy();
  const after = await prisma.floor.findUnique({ where: { id: floor.id } });
  expect(after.scanCount).toBe(floor.scanCount);
  expect(await prisma.scanEvent.count({ where: { buildingId: building.id } })).toBe(0);
});

test('an anonymous visitor scanning the printed QR still counts', async () => {
  const { building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { floorNumber: 1, name: 'Ground', svgContent: '<svg/>' });

  const res = await request(app).get(`/api/building/scan/${building.id}/Ground`);

  expect(res.status).toBe(200);
  const after = await prisma.floor.findUnique({ where: { id: floor.id } });
  expect(after.scanCount).toBe(floor.scanCount + 1);
});

test('a signed-in visitor from outside the building still counts', async () => {
  const { building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { floorNumber: 1, name: 'Ground', svgContent: '<svg/>' });
  const { cookie } = await createUser();

  await request(app).get(`/api/building/scan/${building.id}/Ground`).set('Cookie', cookie);

  const after = await prisma.floor.findUnique({ where: { id: floor.id } });
  expect(after.scanCount).toBe(floor.scanCount + 1);
});
