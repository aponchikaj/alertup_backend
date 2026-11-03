import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createOwnerWithBuilding } from './helpers.js';

/* ============================================================================
   FX-050 — "clear logs" clears the CURRENT incident's feed only.

   POST /api/administration/logs/clear/:id deleted every isEmergency log of
   the building, wiping the feeds of past, resolved emergencies — the record
   emergency analytics reads. It now deletes only what was written since the
   active emergency started.
   ========================================================================= */

const log = (buildingId, createdAt, message) =>
  prisma.log.create({ data: { buildingId, type: 'EVACUATED', isEmergency: true, message, createdAt } });

test('past incidents keep their logs; the active incident feed is cleared', async () => {
  const { cookie, building } = await createOwnerWithBuilding();
  const hour = 3600_000;
  await prisma.emergencyEvent.create({
    data: {
      buildingId: building.id,
      status: 'RESOLVED',
      startedAt: new Date(Date.now() - 48 * hour),
      endedAt: new Date(Date.now() - 47 * hour),
    },
  });
  await log(building.id, new Date(Date.now() - 47.5 * hour), 'past incident');
  await prisma.emergencyEvent.create({
    data: { buildingId: building.id, status: 'ACTIVE', startedAt: new Date(Date.now() - hour) },
  });
  await prisma.building.update({ where: { id: building.id }, data: { emergencyMode: true } });
  await log(building.id, new Date(Date.now() - 30 * 60_000), 'current incident');

  const res = await request(app).post(`/api/administration/logs/clear/${building.id}`).set('Cookie', cookie);

  expect(res.status).toBe(200);
  const left = await prisma.log.findMany({ where: { buildingId: building.id } });
  expect(left.map((l) => l.message)).toEqual(['past incident']);
});

test('with no active emergency there is nothing to clear', async () => {
  const { cookie, building } = await createOwnerWithBuilding();
  await log(building.id, new Date(Date.now() - 60_000), 'old');

  const res = await request(app).post(`/api/administration/logs/clear/${building.id}`).set('Cookie', cookie);

  expect(res.status).toBe(409);
  expect(await prisma.log.count({ where: { buildingId: building.id } })).toBe(1);
});
