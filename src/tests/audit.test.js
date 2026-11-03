import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import {
  createOwnerWithBuilding,
  createFloor,
  createNode,
} from './helpers.js';
import { triggerEmergency, resolveEmergency } from '../features/emergency/emergencyService.js';
import { writeAudit } from '../services/audit.js';

// B14 — audit rows written in the same transaction as the change they
// describe, plus the corrected `logs/clear` filter.

describe('writeAudit guard', () => {
  test('rejects the global prisma client — only a transaction client has no $transaction method', async () => {
    const { building } = await createOwnerWithBuilding();

    // The global client happens to have `.log.create` too, so a guard that
    // only checks for that would let this through — and the row it writes
    // would sit outside whatever transaction the caller thought it was in.
    await expect(
      writeAudit(prisma, {
        buildingId: building.id,
        entity: 'Node',
        entityId: 'fake-id',
        action: 'create',
      })
    ).rejects.toThrow(/transaction client/i);

    const rows = await prisma.log.count({ where: { buildingId: building.id } });
    expect(rows).toBe(0);
  });

  test('accepts a real transaction client', async () => {
    const { building } = await createOwnerWithBuilding();

    await prisma.$transaction(async (tx) => {
      await writeAudit(tx, {
        buildingId: building.id,
        entity: 'Node',
        entityId: 'fake-id',
        action: 'create',
      });
    });

    const rows = await prisma.log.count({ where: { buildingId: building.id } });
    expect(rows).toBe(1);
  });
});

describe('audit trail', () => {
  test('creating an edge writes an edge.create audit row with actor and payload', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id);
    const a = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const b = await createNode(building.id, floor.id, { x: 100, y: 0 });

    const res = await request(app)
      .post('/api/map-editor/edges')
      .set('Cookie', cookie)
      .send({ sourceNodeId: a.id, targetNodeId: b.id, buildingId: building.id });
    expect(res.status).toBe(201);
    const edgeId = res.body.data.edge.id;

    const rows = await prisma.log.findMany({
      where: { buildingId: building.id, entity: 'Edge', entityId: edgeId, },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.message).toBe('Edge.create');
    expect(row.actorType).toBe('USER');
    expect(row.actorUserId).not.toBeNull();
    expect(row.payload).toBeTruthy();
    expect(row.payload.sourceNodeId ?? row.payload.targetNodeId).toBeTruthy();
    // Audit rows are not part of the emergency live-log feed.
    expect(row.isEmergency).toBe(false);
  });

  test('a write that fails a real unique constraint leaves no audit row behind', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id);
    const nodeA = await createNode(building.id, floor.id, { externalId: 'booth-1' });
    const nodeB = await createNode(building.id, floor.id, { externalId: 'booth-2' });

    const before = await prisma.log.count({
      where: { buildingId: building.id, entity: 'Node' },
    });

    // Real P2002 from Node's @@unique([buildingId, externalId]) — not mocked.
    const res = await request(app)
      .patch(`/api/map-editor/nodes/${nodeB.id}`)
      .set('Cookie', cookie)
      .send({ externalId: 'booth-1' });
    expect(res.status).toBe(409);

    // The domain write itself never took effect ...
    const reread = await prisma.node.findUnique({ where: { id: nodeB.id } });
    expect(reread.externalId).toBe('booth-2');

    // ... and neither did any audit row describing it — same transaction,
    // same rollback.
    const after = await prisma.log.count({
      where: { buildingId: building.id, entity: 'Node' },
    });
    expect(after).toBe(before);

    // Sanity: nodeA's own row is untouched and unambiguous.
    const rereadA = await prisma.node.findUnique({ where: { id: nodeA.id } });
    expect(rereadA.externalId).toBe('booth-1');
  });

  test('a successful node update always leaves exactly one audit row', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id);
    const node = await createNode(building.id, floor.id);

    const res = await request(app)
      .patch(`/api/map-editor/nodes/${node.id}`)
      .set('Cookie', cookie)
      .send({ label: 'Front desk' });
    expect(res.status).toBe(200);

    const rows = await prisma.log.findMany({
      where: { buildingId: building.id, entity: 'Node', entityId: node.id, },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('Node.update');
  });

  test('triggering and resolving an emergency both carry actorUserId and entityId', async () => {
    const { user, building } = await createOwnerWithBuilding();

    const { event } = await triggerEmergency(building.id, {
      message: 'Fire drill',
      userId: user.id,
      trigger: 'ADMIN',
    });

    const triggerRows = await prisma.log.findMany({
      where: { buildingId: building.id, entity: 'EmergencyEvent', entityId: event.id, },
    });
    expect(triggerRows.length).toBeGreaterThanOrEqual(1);
    const triggerAudit = triggerRows.find((r) => r.message === 'EmergencyEvent.trigger');
    expect(triggerAudit).toBeTruthy();
    expect(triggerAudit.actorUserId).toBe(user.id);
    expect(triggerAudit.actorType).toBe('USER');
    expect(triggerAudit.isEmergency).toBe(false);

    await resolveEmergency(building.id, { userId: user.id });

    const resolveAudit = await prisma.log.findFirst({
      where: {
        buildingId: building.id,
        entity: 'EmergencyEvent',
        entityId: event.id,
        message: 'EmergencyEvent.resolve',
      },
    });
    expect(resolveAudit).toBeTruthy();
    expect(resolveAudit.actorUserId).toBe(user.id);
    expect(resolveAudit.isEmergency).toBe(false);
  });

  test('triggering an already-active emergency with a new message returns the UPDATED message, not the stale one', async () => {
    const { user, building } = await createOwnerWithBuilding();

    await triggerEmergency(building.id, {
      message: 'Fire in progress',
      userId: user.id,
      trigger: 'ADMIN',
    });

    // Second trigger call on an already-active emergency, with a new message.
    // The event row this returns must reflect the message AFTER this call's
    // own update — never the value read before it, which is what a caller
    // relying on `.message` here (e.g. to redisplay to occupants) would need.
    const result = await triggerEmergency(building.id, {
      message: 'Fire contained — proceed to nearest exit',
      userId: user.id,
      trigger: 'ADMIN',
    });

    expect(result.alreadyActive).toBe(true);
    expect(result.event.message).toBe('Fire contained — proceed to nearest exit');

    // And the database agrees — this isn't just a return-value patch job.
    const stored = await prisma.emergencyEvent.findUnique({ where: { id: result.event.id } });
    expect(stored.message).toBe('Fire contained — proceed to nearest exit');
  });
});

describe('POST /api/administration/logs/clear/:id', () => {
  test('removes emergency logs but keeps audit rows', async () => {
    const { cookie, user, building } = await createOwnerWithBuilding();

    // An operational emergency-feed log (what the live incident view reads).
    await prisma.log.create({
      data: {
        buildingId: building.id,
        type: 'EMERGENCY',
        isEmergency: true,
        message: 'Emergency mode activated.',
      },
    });
    // An accountability row for an unrelated editor change — must survive.
    const floor = await createFloor(building.id);
    const node = await createNode(building.id, floor.id);
    await prisma.log.create({
      data: {
        buildingId: building.id,
        type: 'SYSTEM',
        isEmergency: false,
        message: 'Node.update',
        actorUserId: user.id,
        actorType: 'USER',
        entity: 'Node',
        entityId: node.id,
        payload: { label: 'Front desk' },
      },
    });

    const res = await request(app)
      .post(`/api/administration/logs/clear/${building.id}`)
      .set('Cookie', cookie)
      .send({ buildingID: building.id });
    expect(res.body.Success).toBe(true);

    const remaining = await prisma.log.findMany({ where: { buildingId: building.id } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].entity).toBe('Node');
    expect(remaining[0].isEmergency).toBe(false);

    const emergencyLeft = await prisma.log.count({
      where: { buildingId: building.id, isEmergency: true },
    });
    expect(emergencyLeft).toBe(0);
  });
});

describe('GET /api/administration/analytics/:buildingId/:emergencyID', () => {
  test('lists the incident feed only — an audit row for a map edit in the same window is not an incident log', async () => {
    const { cookie, user, building } = await createOwnerWithBuilding();
    const startedAt = new Date('2026-01-01T00:00:00.000Z');
    const endedAt = new Date('2026-01-01T01:00:00.000Z');
    const inWindow = new Date('2026-01-01T00:30:00.000Z');

    const emergency = await prisma.emergencyEvent.create({
      data: { buildingId: building.id, status: 'RESOLVED', trigger: 'ADMIN', startedAt, endedAt },
    });

    // Operational incident-feed row — what this endpoint is for.
    await prisma.log.create({
      data: {
        buildingId: building.id,
        type: 'SCAN',
        isEmergency: true,
        message: 'A QR code was scanned during the emergency.',
        createdAt: inWindow,
      },
    });
    // An unrelated map edit that happened to land in the same time window —
    // a routine accountability row, not an incident event.
    const floor = await createFloor(building.id);
    const node = await createNode(building.id, floor.id);
    await prisma.log.create({
      data: {
        buildingId: building.id,
        type: 'SYSTEM',
        isEmergency: false,
        message: 'Node.update',
        actorUserId: user.id,
        actorType: 'USER',
        entity: 'Node',
        entityId: node.id,
        createdAt: inWindow,
      },
    });

    const res = await request(app)
      .get(`/api/administration/analytics/${building.id}/${emergency.id}`)
      .set('Cookie', cookie);

    expect(res.body.Success).toBe(true);
    const logs = res.body.Message.logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].logType).toBe('scan');
  });
});
