import prisma from '../db/prisma.js';
import { createOwnerWithBuilding } from './helpers.js';
import {
  sweepOnce,
  ROUTE_REQUEST_RETENTION_MS,
  SYSTEM_LOG_RETENTION_MS,
  ENDED_CLOSURE_RETENTION_MS,
  SCAN_EVENT_RETENTION_MS,
  INBOX_RETENTION_MS,
} from '../jobs/sweeper.js';

/* ============================================================================
   FX-054 — every growing table has a retention rule.

   RouteRequest (one row per public route call), system-noise Log rows, ended
   Closures, ScanEvents and the contact/report inbox grew without bound.
   What is swept, and what is never swept:
     - RouteRequest after 90 days, system Log rows (no entity, not emergency)
       after 90 days, Closures 30 days after they ended, ScanEvent and the
       contact/report inbox after a year;
     - audit rows (Log.entity set) and emergency logs are the incident record
       and are never swept (they move to IncidentArchive with the building).
   ========================================================================= */

const ago = (ms) => new Date(Date.now() - ms - 60_000);

test('old rows are swept; recent rows, audit rows and emergency logs stay', async () => {
  const { building, user } = await createOwnerWithBuilding();
  const b = building.id;

  await prisma.routeRequest.create({ data: { buildingId: b, profile: 'walk', mode: 'WAYFINDING', createdAt: ago(ROUTE_REQUEST_RETENTION_MS) } });
  await prisma.routeRequest.create({ data: { buildingId: b, profile: 'walk', mode: 'WAYFINDING' } });

  await prisma.log.create({ data: { buildingId: b, message: 'old noise', createdAt: ago(SYSTEM_LOG_RETENTION_MS) } });
  await prisma.log.create({ data: { buildingId: b, message: 'old audit', entity: 'Closure', entityId: 'c1', createdAt: ago(SYSTEM_LOG_RETENTION_MS) } });
  await prisma.log.create({ data: { buildingId: b, message: 'old incident', isEmergency: true, createdAt: ago(SYSTEM_LOG_RETENTION_MS) } });

  await prisma.closure.create({ data: { buildingId: b, reason: 'old', endsAt: ago(ENDED_CLOSURE_RETENTION_MS) } });
  await prisma.closure.create({ data: { buildingId: b, reason: 'open-ended' } });

  await prisma.scanEvent.create({ data: { buildingId: b, userId: user.id, buildingName: 'x', scannedAt: ago(SCAN_EVENT_RETENTION_MS) } });
  await prisma.scanEvent.create({ data: { buildingId: b, userId: user.id, buildingName: 'x' } });

  await prisma.contact.create({ data: { email: 'a@b.c', message: 'old', createdAt: ago(INBOX_RETENTION_MS) } });
  await prisma.report.create({ data: { email: 'a@b.c', message: 'old', createdAt: ago(INBOX_RETENTION_MS) } });
  await prisma.contact.create({ data: { email: 'a@b.c', message: 'new' } });

  await sweepOnce();

  expect(await prisma.routeRequest.count({ where: { buildingId: b } })).toBe(1);
  expect((await prisma.log.findMany({ where: { buildingId: b } })).map((l) => l.message).sort()).toEqual(['old audit', 'old incident']);
  expect((await prisma.closure.findMany({ where: { buildingId: b } })).map((c) => c.reason)).toEqual(['open-ended']);
  expect(await prisma.scanEvent.count({ where: { buildingId: b } })).toBe(1);
  expect((await prisma.contact.findMany()).map((c) => c.message)).toEqual(['new']);
  expect(await prisma.report.count()).toBe(0);
});
