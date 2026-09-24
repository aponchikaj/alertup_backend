import { PERMISSIONS } from '../auth/permissions.js';
import { runTool } from '../features/ai/agents/toolRegistry.js';
import { auditTools } from '../features/ai/agents/tools/auditTools.js';
import { clearAll } from '../features/wayfinding/graphCache.js';
import {
  createUser,
  createBuilding,
  createFloor,
  createNode,
  connectNodes,
} from './helpers.js';

/* ============================================================================
   Safety Auditor tools.

   These are the highest-value tools in the suite precisely because they invent
   nothing: validateGraph already emits {code, severity, message, nodeIds}, so
   the model's job is to explain a structured finding rather than to notice one.

   The test that matters most is tenant isolation. ctx.buildingId comes from
   requireBuildingPermission; a floorId comes from the MODEL, which means it is
   attacker-influenced input. Every lookup has to be scoped by both.
   ========================================================================= */

const ctxFor = (buildingId, permissions = [PERMISSIONS.CAN_EDIT_MAP]) => ({
  buildingId,
  permissions,
});

beforeEach(() => clearAll());

/** A floor with two connected nodes and no emergency exit. */
const seedFloorWithoutExit = async (buildingId) => {
  const floor = await createFloor(buildingId, { floorNumber: 1 });
  const a = await createNode(buildingId, floor.id, { label: 'Lobby' });
  const b = await createNode(buildingId, floor.id, { x: 300, label: 'Hall' });
  await connectNodes(a, b);
  return { floor, a, b };
};

describe('validate_building', () => {
  test('reports the structured issues for a building with no exit', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    await seedFloorWithoutExit(building.id);

    const result = await runTool({
      tool: auditTools.validate_building,
      ctx: ctxFor(building.id),
      args: {},
    });

    expect(result.ok).toBe(true);
    expect(result.data.issues.some((issue) => issue.code === 'NO_EXIT')).toBe(true);
    expect(result.data.ok).toBe(false);
  });

  test('passes a building that has a reachable exit', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const lobby = await createNode(building.id, floor.id, { label: 'Lobby' });
    const exit = await createNode(building.id, floor.id, {
      x: 300,
      type: 'EMERGENCY_EXIT',
      label: 'North Exit',
    });
    await connectNodes(lobby, exit);

    const result = await runTool({
      tool: auditTools.validate_building,
      ctx: ctxFor(building.id),
      args: {},
    });

    expect(result.data.issues.some((issue) => issue.severity === 'error')).toBe(false);
  });

  test('requires CAN_EDIT_MAP', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);

    const result = await runTool({
      tool: auditTools.validate_building,
      ctx: ctxFor(building.id, [PERMISSIONS.CAN_VIEW_ANALYTICS]),
      args: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/permission/i);
  });
});

describe('get_building_overview', () => {
  test('lists each floor with its node and exit counts', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const floor = await createFloor(building.id, { floorNumber: 1, name: 'Ground' });
    await createNode(building.id, floor.id, { label: 'Lobby' });
    await createNode(building.id, floor.id, { x: 300, type: 'EMERGENCY_EXIT' });

    const result = await runTool({
      tool: auditTools.get_building_overview,
      ctx: ctxFor(building.id),
      args: {},
    });

    expect(result.ok).toBe(true);
    expect(result.data.floors).toHaveLength(1);
    expect(result.data.floors[0]).toMatchObject({
      floorNumber: 1,
      name: 'Ground',
      nodeCount: 2,
      exitCount: 1,
    });
  });

  test('never reports another building’s floors', async () => {
    const { user } = await createUser();
    const { building: mine } = await createBuilding(user.id);
    const { building: theirs } = await createBuilding(user.id);
    await createFloor(theirs.id, { floorNumber: 7, name: 'Theirs' });

    const result = await runTool({
      tool: auditTools.get_building_overview,
      ctx: ctxFor(mine.id),
      args: {},
    });

    expect(result.data.floors).toHaveLength(0);
  });
});

describe('propose_auto_connect — tenant isolation', () => {
  test('proposes the action for a floor in this building', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const { floor } = await seedFloorWithoutExit(building.id);

    const result = await runTool({
      tool: auditTools.propose_auto_connect,
      ctx: ctxFor(building.id),
      args: { floorId: floor.id },
    });

    expect(result.ok).toBe(true);
    expect(result.data.action).toMatchObject({
      name: 'auto_connect_floor',
      args: { floorId: floor.id },
    });
  });

  test('refuses a floorId belonging to another building', async () => {
    const { user } = await createUser();
    const { building: mine } = await createBuilding(user.id);
    const { building: theirs } = await createBuilding(user.id);
    const theirFloor = await createFloor(theirs.id, { floorNumber: 3 });

    const result = await runTool({
      tool: auditTools.propose_auto_connect,
      ctx: ctxFor(mine.id),
      args: { floorId: theirFloor.id },
    });

    expect(result.ok).toBe(true);
    expect(result.data.action).toBeUndefined();
    expect(result.data.error).toMatch(/not found/i);
  });

  test('leaks nothing about a floor it refused', async () => {
    const { user } = await createUser();
    const { building: mine } = await createBuilding(user.id);
    const { building: theirs } = await createBuilding(user.id);
    const theirFloor = await createFloor(theirs.id, { floorNumber: 3, name: 'Executive Suite' });

    const result = await runTool({
      tool: auditTools.propose_auto_connect,
      ctx: ctxFor(mine.id),
      args: { floorId: theirFloor.id },
    });

    expect(result.fenced).not.toContain('Executive Suite');
  });
});
