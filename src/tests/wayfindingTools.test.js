import prisma from '../db/prisma.js';
import { runTool } from '../features/ai/agents/toolRegistry.js';
import { wayfindingTools } from '../features/ai/agents/tools/wayfindingTools.js';
import { clearAll } from '../features/wayfinding/graphCache.js';
import { createUser, createBuilding, createFloor, createNode, connectNodes } from './helpers.js';

/* ============================================================================
   Wayfinder tools — the anonymous, safety-critical surface.

   Two properties matter more than anything else here:

   1. The agent must REFUSE rather than guess. "Never invent shops, floors or
      exits" is a line in the prompt, but a prompt is not an enforcement point.
      A tool that cannot find an exit has to say so plainly, so the model has
      nothing to embroider.

   2. Everything is scoped by ctx.buildingId. This surface is anonymous — the
      only thing standing between one building's visitor and another
      building's data is the query shape.
   ========================================================================= */

const ctxFor = (buildingId, nodeId = null) => ({
  buildingId,
  nodeId,
  permissions: [],
  locale: 'en',
});

const addPoi = (nodeId, name, overrides = {}) =>
  prisma.poi.create({
    data: { nodeId, name, category: overrides.category ?? 'shop', keywords: overrides.keywords ?? [] },
  });

beforeEach(() => clearAll());

/** Lobby -> corridor -> exit on one floor. */
const seedSimpleBuilding = async () => {
  const { user } = await createUser();
  const { building } = await createBuilding(user.id);
  const floor = await createFloor(building.id, {
    floorNumber: 1,
    name: 'Ground',
    scalePixelsPerMeter: 50,
  });
  const lobby = await createNode(building.id, floor.id, { x: 0, y: 0, label: 'Lobby' });
  const middle = await createNode(building.id, floor.id, { x: 200, y: 0, type: 'POI' });
  const exit = await createNode(building.id, floor.id, {
    x: 400,
    y: 0,
    type: 'EMERGENCY_EXIT',
    label: 'North Exit',
  });
  await connectNodes(lobby, middle);
  await connectNodes(middle, exit);
  const poi = await addPoi(middle.id, 'Pharmacy', { keywords: ['medicine', 'chemist'] });
  return { building, floor, lobby, middle, exit, poi };
};

describe('search_destinations', () => {
  test('finds a place by name', async () => {
    const { building } = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.search_destinations,
      ctx: ctxFor(building.id),
      args: { query: 'pharm' },
    });

    expect(result.ok).toBe(true);
    expect(result.data.places[0]).toMatchObject({ name: 'Pharmacy', floorNumber: 1 });
    expect(result.data.places[0].poiId).toBeTruthy();
  });

  test('finds a place by keyword, not just its name', async () => {
    const { building } = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.search_destinations,
      ctx: ctxFor(building.id),
      args: { query: 'chemist' },
    });

    expect(result.data.places.map((p) => p.name)).toContain('Pharmacy');
  });

  test('never returns another building’s places', async () => {
    const { building: mine } = await seedSimpleBuilding();
    const theirs = await seedSimpleBuilding();
    // Poi.nodeId is unique, so the vault needs a node of its own.
    const vaultNode = await createNode(theirs.building.id, theirs.floor.id, { x: 600 });
    await addPoi(vaultNode.id, 'Secret Vault');

    const result = await runTool({
      tool: wayfindingTools.search_destinations,
      ctx: ctxFor(mine.id),
      args: { query: 'Secret Vault' },
    });

    expect(result.data.places).toHaveLength(0);
  });

  test('says plainly when nothing matches, so the model has nothing to invent', async () => {
    const { building } = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.search_destinations,
      ctx: ctxFor(building.id),
      args: { query: 'helicopter pad' },
    });

    expect(result.data.places).toHaveLength(0);
    expect(result.data.found).toBe(false);
  });

  test('needs no permission — the scan page is anonymous', async () => {
    const { building } = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.search_destinations,
      ctx: { buildingId: building.id },
      args: { query: 'pharm' },
    });

    expect(result.ok).toBe(true);
  });
});

describe('find_nearest_exit', () => {
  test('reports the nearest exit with a real distance', async () => {
    const { building, lobby } = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: ctxFor(building.id, lobby.id),
      args: {},
    });

    expect(result.data.found).toBe(true);
    expect(result.data.exitName).toBe('North Exit');
    expect(result.data.distanceMeters).toBeGreaterThan(0);
    expect(result.data.durationSec).toBeGreaterThan(0);
  });

  test('an ETA that reflects the building\'s OWN calibrated walk speed, not a generic default', async () => {
    // B16 regression guard: an earlier version of this tool threaded a bare
    // profile-name STRING into `assembleRoute`, which resolves with NO
    // building overrides at all (`resolveProfile(null, name)`) — silently
    // discarding a building's own `routingProfile` and roughly halving the
    // ETA for any building that calibrated a slower walk speed. Passing
    // nothing (the current behaviour) falls back to
    // `resolveProfile(graph.routingProfile ?? null, 'walk')`, which DOES pick
    // up the override.
    const { user } = await createUser();
    const { building } = await createBuilding(user.id, {
      routingProfile: { walkSpeedMps: 0.7 },
    });
    const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 50 });
    const lobby = await createNode(building.id, floor.id, { x: 0, y: 0, label: 'Lobby' });
    const exit = await createNode(building.id, floor.id, {
      x: 400,
      y: 0,
      type: 'EMERGENCY_EXIT',
      label: 'Exit',
    });
    await connectNodes(lobby, exit);

    const result = await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: ctxFor(building.id, lobby.id),
      args: {},
    });

    expect(result.data.found).toBe(true);
    // 400 px / 50 px-per-metre = 8 m; at the building's own 0.7 m/s that is
    // ~11.4 s. The regression above would have reported ~5.7 s instead (the
    // generic 1.4 m/s default with the override discarded).
    expect(result.data.durationSec).toBeGreaterThanOrEqual(11);
  });

  test('reports honestly when the building has no exit at all', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const a = await createNode(building.id, floor.id, { label: 'Lobby' });
    const b = await createNode(building.id, floor.id, { x: 200 });
    await connectNodes(a, b);

    const result = await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: ctxFor(building.id, a.id),
      args: {},
    });

    expect(result.data.found).toBe(false);
    expect(result.data.exitName).toBeUndefined();
  });

  test('reports honestly when it does not know where the visitor is', async () => {
    const { building } = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: ctxFor(building.id, null),
      args: {},
    });

    expect(result.data.found).toBe(false);
  });
});

describe('get_route', () => {
  test('summarizes a route to a place', async () => {
    const { building, lobby, poi } = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.get_route,
      ctx: ctxFor(building.id, lobby.id),
      args: { toPoiId: poi.id },
    });

    expect(result.data.found).toBe(true);
    expect(result.data.distanceMeters).toBeGreaterThan(0);
    expect(result.data.floorChanges).toBe(0);
    expect(result.data.durationSec).toBeGreaterThan(0);
  });

  test('omits the distance on an unscaled floor rather than saying "0 metres"', async () => {
    // A floor with no scalePixelsPerMeter cannot express metres. Reporting 0
    // would read to a visitor as "you are already there".
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const lobby = await createNode(building.id, floor.id, { x: 0, label: 'Lobby' });
    const shop = await createNode(building.id, floor.id, { x: 500, type: 'POI' });
    await connectNodes(lobby, shop);
    const poi = await addPoi(shop.id, 'Bakery');

    const result = await runTool({
      tool: wayfindingTools.get_route,
      ctx: ctxFor(building.id, lobby.id),
      args: { toPoiId: poi.id },
    });

    expect(result.data.found).toBe(true);
    expect(result.data.distanceMeters).toBeUndefined();
    expect(result.fenced).not.toContain('"distanceMeters":0');
  });

  test('refuses a destination in another building', async () => {
    const { building: mine, lobby } = await seedSimpleBuilding();
    const theirs = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.get_route,
      ctx: ctxFor(mine.id, lobby.id),
      args: { toPoiId: theirs.poi.id },
    });

    expect(result.data.found).toBe(false);
  });
});

describe('show_route_to — the action that drives the map', () => {
  test('proposes the action for a place in this building', async () => {
    const { building, lobby, poi } = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.show_route_to,
      ctx: ctxFor(building.id, lobby.id),
      args: { poiId: poi.id },
    });

    expect(result.data.action).toMatchObject({
      name: 'show_route_to',
      args: { poiId: poi.id, name: 'Pharmacy' },
    });
  });

  test('refuses a poiId from another building and proposes nothing', async () => {
    const { building: mine, lobby } = await seedSimpleBuilding();
    const theirs = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.show_route_to,
      ctx: ctxFor(mine.id, lobby.id),
      args: { poiId: theirs.poi.id },
    });

    expect(result.data.action).toBeUndefined();
  });

  test('a fabricated id proposes nothing', async () => {
    const { building, lobby } = await seedSimpleBuilding();

    const result = await runTool({
      tool: wayfindingTools.show_route_to,
      ctx: ctxFor(building.id, lobby.id),
      args: { poiId: 'poi-that-never-existed' },
    });

    expect(result.data.action).toBeUndefined();
    expect(result.data.error).toBeTruthy();
  });

  test('is declared client-side, so the runtime may emit its action', () => {
    expect(wayfindingTools.show_route_to.sideEffect).toBe('client');
  });
});
