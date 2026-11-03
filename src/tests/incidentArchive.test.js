import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createOwnerWithBuilding, adminCookie, TEST_PASSWORD } from './helpers.js';

/* ============================================================================
   D3 — incident history outlives the building (founder decision 2026-11-03).

   Deleting a building — directly, or by deleting the owner's account —
   cascaded away its EmergencyEvents, the incident and audit Log rows and the
   AI transcripts taken during emergencies. Those are the record of what
   happened during an evacuation; they now survive in IncidentArchive, which
   has no foreign keys back to the building or the user.
   ========================================================================= */

const seedIncident = async () => {
  const seeded = await createOwnerWithBuilding();
  const { building, user } = seeded;
  const event = await prisma.emergencyEvent.create({
    data: {
      buildingId: building.id,
      status: 'RESOLVED',
      triggeredById: user.id,
      message: 'Fire on floor 2',
      evacuated: 12,
      startedAt: new Date(Date.now() - 3600_000),
      endedAt: new Date(Date.now() - 600_000),
    },
  });
  await prisma.log.create({
    data: {
      buildingId: building.id,
      type: 'EVACUATED',
      isEmergency: true,
      message: 'An occupant reported themselves evacuated.',
      createdAt: new Date(Date.now() - 1800_000),
    },
  });
  await prisma.log.create({
    data: {
      buildingId: building.id,
      message: 'Closure added',
      entity: 'Closure',
      entityId: 'c1',
      actorType: 'USER',
      actorUserId: user.id,
    },
  });
  const convo = await prisma.aiConversation.create({
    data: { agentId: 'wayfinder', buildingId: building.id, emergencyId: event.id },
  });
  await prisma.aiMessage.create({
    data: { conversationId: convo.id, role: 'user', content: 'where is the exit?' },
  });
  return { ...seeded, event };
};

test('deleting a building archives its incidents and audit trail first', async () => {
  const { cookie, building, event } = await seedIncident();

  const res = await request(app).delete(`/api/building/delete/${building.id}`).set('Cookie', cookie);

  expect(res.status).toBe(200);
  expect(await prisma.building.findUnique({ where: { id: building.id } })).toBeNull();

  const archived = await prisma.incidentArchive.findMany({ where: { buildingId: building.id } });
  const incident = archived.find((a) => a.emergencyId === event.id);
  expect(incident).toBeTruthy();
  expect(incident.buildingName).toBe(building.name);
  expect(incident.reason).toBe('building_deleted');
  expect(incident.snapshot.event.message).toBe('Fire on floor 2');
  expect(incident.snapshot.event.evacuated).toBe(12);
  expect(incident.snapshot.logs.some((l) => l.type === 'EVACUATED')).toBe(true);
  expect(incident.snapshot.aiConversations[0].messages[0].content).toBe('where is the exit?');

  const audit = archived.find((a) => a.kind === 'AUDIT');
  expect(audit.snapshot.logs.some((l) => l.entity === 'Closure')).toBe(true);
});

test('deleting the owner account archives the incidents of every owned building', async () => {
  const { cookie, building, event } = await seedIncident();

  const res = await request(app)
    .post('/api/settings/account')
    .set('Cookie', cookie)
    .send({ password: TEST_PASSWORD });

  expect(res.status).toBe(200);
  const incident = await prisma.incidentArchive.findFirst({ where: { emergencyId: event.id } });
  expect(incident).toBeTruthy();
  expect(incident.buildingId).toBe(building.id);
  expect(incident.reason).toBe('account_deleted');
});

test('a building with no incidents and no audit rows archives nothing', async () => {
  const { cookie, building } = await createOwnerWithBuilding();

  await request(app).delete(`/api/building/delete/${building.id}`).set('Cookie', cookie);

  expect(await prisma.incidentArchive.count({ where: { buildingId: building.id } })).toBe(0);
});

test('an admin deleting a building archives its incidents too', async () => {
  const { building, event } = await seedIncident();

  const res = await request(app).delete(`/api/admin/buildings/${building.id}`).set('Cookie', adminCookie());

  expect(res.status).toBe(200);
  const incident = await prisma.incidentArchive.findFirst({ where: { emergencyId: event.id } });
  expect(incident.reason).toBe('admin_deleted');
});
