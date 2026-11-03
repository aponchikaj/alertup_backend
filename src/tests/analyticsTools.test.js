import prisma from '../db/prisma.js';
import { PERMISSIONS } from '../auth/permissions.js';
import { runTool } from '../features/ai/agents/toolRegistry.js';
import { analyticsTools } from '../features/ai/agents/tools/analyticsTools.js';
import { createUser, createBuilding, createFloor, createNode } from './helpers.js';

/* ============================================================================
   Analytics tools.

   The interesting one is get_scan_activity's entrance breakdown: it only works
   because ScanEvent grew a nodeId in this work. Before that, "which entrance
   do visitors actually use" was unanswerable from the data — the row knew the
   building and the time and nothing else.

   Day buckets are UTC and ISO-keyed, matching /api/dashboard. Two analytics
   surfaces disagreeing about when a day starts is its own kind of bug.
   ========================================================================= */

const ctxFor = (buildingId, permissions = [PERMISSIONS.CAN_VIEW_ANALYTICS]) => ({
  buildingId,
  permissions,
});

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const addScan = (buildingId, { nodeId = null, at = new Date(), name = 'Test Building' } = {}) =>
  prisma.scanEvent.create({
    data: { buildingId, nodeId, buildingName: name, scannedAt: at },
  });

const addEmergency = (buildingId, overrides = {}) =>
  prisma.emergencyEvent.create({
    data: {
      buildingId,
      status: 'RESOLVED',
      trigger: 'ADMIN',
      startedAt: daysAgo(1),
      endedAt: daysAgo(1),
      scanned: 5,
      evacuated: 3,
      calledEmergency: 1,
      ...overrides,
    },
  });

describe('get_scan_activity', () => {
  test('counts this building’s scans and buckets them by day', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    await addScan(building.id);
    await addScan(building.id);
    await addScan(building.id, { at: daysAgo(2) });

    const result = await runTool({
      tool: analyticsTools.get_scan_activity,
      ctx: ctxFor(building.id),
      args: { days: 7 },
    });

    expect(result.ok).toBe(true);
    expect(result.data.total).toBe(3);
    expect(result.data.daily).toHaveLength(7);
    const today = new Date().toISOString().slice(0, 10);
    expect(result.data.daily.find((d) => d.date === today).count).toBe(2);
  });

  test('never counts another building’s scans', async () => {
    const { user } = await createUser();
    const { building: mine } = await createBuilding(user.id);
    const { building: theirs } = await createBuilding(user.id);
    await addScan(theirs.id);
    await addScan(theirs.id);

    const result = await runTool({
      tool: analyticsTools.get_scan_activity,
      ctx: ctxFor(mine.id),
      args: { days: 7 },
    });

    expect(result.data.total).toBe(0);
  });

  test('breaks scans down by entrance — the reason ScanEvent grew a nodeId', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const north = await createNode(building.id, floor.id, { label: 'North Entrance' });
    const south = await createNode(building.id, floor.id, { x: 500, label: 'South Entrance' });
    await addScan(building.id, { nodeId: north.id });
    await addScan(building.id, { nodeId: north.id });
    await addScan(building.id, { nodeId: south.id });

    const result = await runTool({
      tool: analyticsTools.get_scan_activity,
      ctx: ctxFor(building.id),
      args: { days: 7 },
    });

    expect(result.data.topEntrances[0]).toMatchObject({ label: 'North Entrance', count: 2 });
    expect(result.data.topEntrances[1]).toMatchObject({ label: 'South Entrance', count: 1 });
  });

  test('ignores scans older than the window', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    await addScan(building.id, { at: daysAgo(40) });

    const result = await runTool({
      tool: analyticsTools.get_scan_activity,
      ctx: ctxFor(building.id),
      args: { days: 7 },
    });

    expect(result.data.total).toBe(0);
  });

  test('requires CAN_VIEW_ANALYTICS', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);

    const result = await runTool({
      tool: analyticsTools.get_scan_activity,
      ctx: ctxFor(building.id, [PERMISSIONS.CAN_EDIT_MAP]),
      args: { days: 7 },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/permission/i);
  });
});

describe('list_emergencies', () => {
  test('summarizes this building’s emergencies with their counters', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    await addEmergency(building.id);

    const result = await runTool({
      tool: analyticsTools.list_emergencies,
      ctx: ctxFor(building.id),
      args: { days: 30 },
    });

    expect(result.data.count).toBe(1);
    expect(result.data.emergencies[0]).toMatchObject({
      status: 'RESOLVED',
      trigger: 'ADMIN',
      scanned: 5,
      evacuated: 3,
      calledEmergency: 1,
    });
  });

  test('never lists another building’s emergencies', async () => {
    const { user } = await createUser();
    const { building: mine } = await createBuilding(user.id);
    const { building: theirs } = await createBuilding(user.id);
    await addEmergency(theirs.id);

    const result = await runTool({
      tool: analyticsTools.list_emergencies,
      ctx: ctxFor(mine.id),
      args: { days: 30 },
    });

    expect(result.data.count).toBe(0);
  });

  test('reports an unresolved emergency as still running', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    await addEmergency(building.id, { status: 'ACTIVE', endedAt: null });

    const result = await runTool({
      tool: analyticsTools.list_emergencies,
      ctx: ctxFor(building.id),
      args: { days: 30 },
    });

    expect(result.data.emergencies[0].status).toBe('ACTIVE');
    expect(result.data.emergencies[0].durationMinutes).toBeNull();
  });
});

describe('get_emergency_report', () => {
  test('summarizes one emergency and what was logged during it', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    // An explicit window with the logs inside it, the way a real incident
    // runs: triggered, things happen, resolved.
    const startedAt = daysAgo(2);
    const endedAt = daysAgo(1);
    const during = new Date((startedAt.getTime() + endedAt.getTime()) / 2);
    const emergency = await addEmergency(building.id, { startedAt, endedAt });
    await prisma.log.createMany({
      data: [
        { buildingId: building.id, type: 'SCAN', message: 'scan', isEmergency: true, createdAt: during },
        { buildingId: building.id, type: 'SCAN', message: 'scan', isEmergency: true, createdAt: during },
        { buildingId: building.id, type: 'EVACUATED', message: 'out', isEmergency: true, createdAt: during },
      ],
    });

    const result = await runTool({
      tool: analyticsTools.get_emergency_report,
      ctx: ctxFor(building.id),
      args: { emergencyId: emergency.id },
    });

    expect(result.data.found).toBe(true);
    expect(result.data.logCounts.SCAN).toBe(2);
    expect(result.data.logCounts.EVACUATED).toBe(1);
  });

  test('refuses an emergency id from another building', async () => {
    const { user } = await createUser();
    const { building: mine } = await createBuilding(user.id);
    const { building: theirs } = await createBuilding(user.id);
    const theirEmergency = await addEmergency(theirs.id);

    const result = await runTool({
      tool: analyticsTools.get_emergency_report,
      ctx: ctxFor(mine.id),
      args: { emergencyId: theirEmergency.id },
    });

    expect(result.data.found).toBe(false);
    expect(result.data.logCounts).toBeUndefined();
  });

  test('a fabricated id is simply not found', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);

    const result = await runTool({
      tool: analyticsTools.get_emergency_report,
      ctx: ctxFor(building.id),
      args: { emergencyId: 'not-a-real-emergency' },
    });

    expect(result.data.found).toBe(false);
  });
});
