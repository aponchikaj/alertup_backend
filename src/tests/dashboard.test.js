import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createUser, createBuilding, createFloor, createOwnerWithBuilding } from './helpers.js';

/* FX-027 — integration coverage for src/routes/dashboard.js (GET /api/dashboard). */

const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(12, 0, 0, 0);
  return d;
};

test('401 without a session', async () => {
  const res = await request(app).get('/api/dashboard');
  expect(res.status).toBe(401);
});

test('an empty account gets zeroed stats and 14 empty activity buckets', async () => {
  const { cookie } = await createUser();
  const res = await request(app).get('/api/dashboard').set('Cookie', cookie);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  const m = res.body.data;
  expect(m).toMatchObject({ MyBuildings: 0, scanned: 0, myBuildingsScanned: 0, lastScanned: null, recentScans: [] });
  expect(m.scanActivity).toHaveLength(14);
  expect(m.scanActivity.every((b) => b.count === 0)).toBe(true);
  expect(m.scanActivity[13].date).toBe(new Date().toISOString().slice(0, 10));
});

test('aggregates owned buildings, floor scan sums, own scan history and daily activity', async () => {
  const { user, cookie, building } = await createOwnerWithBuilding();
  const second = await createBuilding(user.id, { name: 'Second' });
  await createFloor(building.id, { floorNumber: 1, scanCount: 4 });
  await createFloor(building.id, { floorNumber: 2, scanCount: 6 });
  await createFloor(second.building.id, { floorNumber: 1, scanCount: 5 });

  // Someone else's building: its scans must not count toward this owner.
  const stranger = await createOwnerWithBuilding();
  await createFloor(stranger.building.id, { floorNumber: 1, scanCount: 100 });

  await prisma.scanEvent.createMany({
    data: [
      { userId: user.id, buildingId: stranger.building.id, buildingName: 'Old', scannedAt: daysAgo(30) },
      { userId: user.id, buildingId: stranger.building.id, buildingName: 'Mid', scannedAt: daysAgo(2) },
      { userId: user.id, buildingId: stranger.building.id, buildingName: 'Mid', scannedAt: daysAgo(2) },
      { userId: user.id, buildingId: building.id, buildingName: 'Newest', scannedAt: daysAgo(0) },
      // Another user's scan: never in this dashboard.
      { userId: stranger.user.id, buildingId: building.id, buildingName: 'Theirs', scannedAt: daysAgo(0) },
    ],
  });

  const res = await request(app).get('/api/dashboard').set('Cookie', cookie);
  const m = res.body.data;

  expect(m.MyBuildings).toBe(2);
  expect(m.myBuildingsScanned).toBe(15);
  expect(m.scanned).toBe(4);
  expect(m.lastScanned).toBe('Newest');
  expect(m.recentScans.map((s) => s.buildingName)).toEqual(['Newest', 'Mid', 'Mid', 'Old']);
  expect(m.recentScans[0]).toEqual({
    buildingName: 'Newest',
    scannedAt: expect.any(String),
    buildingID: building.id,
  });

  const byDate = Object.fromEntries(m.scanActivity.map((b) => [b.date, b.count]));
  expect(byDate[daysAgo(0).toISOString().slice(0, 10)]).toBe(1);
  expect(byDate[daysAgo(2).toISOString().slice(0, 10)]).toBe(2);
  // The 30-day-old scan is outside the 14-day window.
  expect(m.scanActivity.reduce((n, b) => n + b.count, 0)).toBe(3);
});

test('recent scans are capped at 8', async () => {
  const { user, cookie, building } = await createOwnerWithBuilding();
  await prisma.scanEvent.createMany({
    data: Array.from({ length: 11 }, (_, i) => ({
      userId: user.id,
      buildingId: building.id,
      buildingName: `B${i}`,
      scannedAt: daysAgo(i),
    })),
  });
  const res = await request(app).get('/api/dashboard').set('Cookie', cookie);
  expect(res.body.data.recentScans).toHaveLength(8);
  expect(res.body.data.scanned).toBe(11);
});

test('the plan card reflects the account plan (it read fields the API stopped sending)', async () => {
  const { cookie: freeCookie } = await createUser();
  const free = await request(app).get('/api/dashboard').set('Cookie', freeCookie);
  expect(free.body.data).toMatchObject({ premiumStatus: 'Free', premiumExpires: null });

  const { cookie } = await createUser({ plan: 'BUSINESS' });
  const business = await request(app).get('/api/dashboard').set('Cookie', cookie);
  expect(business.body.data.premiumStatus).toBe('Business');
});

test('myBuildingsScanned counts node-QR scans as well as floor-QR scans (BE-32)', async () => {
  const { cookie, building } = await createOwnerWithBuilding();
  const floor = await createFloor(building.id, { scanCount: 2 });
  await prisma.node.create({
    data: { buildingId: building.id, floorId: floor.id, x: 0, y: 0, type: 'NORMAL', scanCount: 5 },
  });
  const res = await request(app).get('/api/dashboard').set('Cookie', cookie);
  expect(res.body.data.myBuildingsScanned).toBe(7);
});
