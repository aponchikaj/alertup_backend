import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { runTool } from '../features/ai/agents/toolRegistry.js';
import { wayfindingTools } from '../features/ai/agents/tools/wayfindingTools.js';
import { buildBriefFacts } from '../features/ai/evacuationBrief.routes.js';
import { clearAll } from '../features/wayfinding/graphCache.js';
import { clearAllClosures } from '../features/wayfinding/closures.js';
import { createUser, createBuilding, createFloor, createNode, connectNodes } from './helpers.js';

/* ============================================================================
   FX-002 / FX-010 — every surface gives the same evacuation answer.

   The visitor sees a red line drawn by /evacuate (or the QR scan route). The
   AI concierge's tools and the one-sentence evacuation brief sit on the same
   screen. If a corridor is closed, all of them must route around it: an AI
   that says "North Exit" while the line leads to "South Exit" is sending
   someone toward the fire.
   ========================================================================= */

beforeEach(() => {
  clearAll();
  clearAllClosures();
});

const ctxFor = (buildingId, nodeId) => ({ buildingId, nodeId, permissions: [], locale: 'en' });

/**
 * Lobby ── short ── North Exit
 *   └──── long ──── South Exit
 * The short corridor is the obvious answer until it is closed.
 */
const seedTwoExits = async () => {
  const { user } = await createUser();
  const { building } = await createBuilding(user.id);
  const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 50 });
  const lobby = await createNode(building.id, floor.id, { x: 0, y: 0, label: 'Lobby' });
  const north = await createNode(building.id, floor.id, {
    x: 100,
    y: 0,
    type: 'EMERGENCY_EXIT',
    label: 'North Exit',
  });
  const south = await createNode(building.id, floor.id, {
    x: 0,
    y: 900,
    type: 'EMERGENCY_EXIT',
    label: 'South Exit',
  });
  const shortCorridor = await connectNodes(lobby, north);
  await connectNodes(lobby, south);
  return { user, building, floor, lobby, north, south, shortCorridor };
};

const closeEdge = (buildingId, edgeId) =>
  prisma.closure.create({
    data: { buildingId, edgeIds: [edgeId], costMultiplier: null, reason: 'Fire' },
  });

describe('a closed corridor is closed for every evacuation surface', () => {
  test('/evacuate routes around the closure (baseline)', async () => {
    const { building, lobby, south, shortCorridor } = await seedTwoExits();
    await closeEdge(building.id, shortCorridor.id);

    const res = await request(app).get(`/api/wayfinding/evacuate?from=${lobby.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.route.destination.nodeId).toBe(south.id);
  });

  test('find_nearest_exit names the exit the drawn route leads to, not the closed one', async () => {
    const { building, lobby, shortCorridor } = await seedTwoExits();
    await closeEdge(building.id, shortCorridor.id);

    const result = await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: ctxFor(building.id, lobby.id),
      args: {},
    });

    expect(result.data.found).toBe(true);
    expect(result.data.exitName).toBe('South Exit');
  });

  test('the evacuation brief names the exit the drawn route leads to, not the closed one', async () => {
    const { building, lobby, shortCorridor } = await seedTwoExits();
    await closeEdge(building.id, shortCorridor.id);

    const facts = await buildBriefFacts({ buildingId: building.id, nodeId: lobby.id });

    expect(facts.found).toBe(true);
    expect(facts.exitName).toBe('South Exit');
  });

  test('without a closure every surface still agrees on the nearer exit', async () => {
    const { building, lobby } = await seedTwoExits();

    const tool = await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: ctxFor(building.id, lobby.id),
      args: {},
    });
    const facts = await buildBriefFacts({ buildingId: building.id, nodeId: lobby.id });

    expect(tool.data.exitName).toBe('North Exit');
    expect(facts.exitName).toBe('North Exit');
  });
});

describe('find_nearest_exit uses the emergency profile', () => {
  test('never offers a lift the building has not rated for evacuation', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const ground = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 50 });
    const upper = await createFloor(building.id, { floorNumber: 2, scalePixelsPerMeter: 50 });
    const here = await createNode(building.id, upper.id, { label: 'Office' });
    const lift = await createNode(building.id, ground.id, { type: 'TRANSIT' });
    const exit = await createNode(building.id, ground.id, {
      x: 300,
      type: 'EMERGENCY_EXIT',
      label: 'Side Exit',
    });
    await connectNodes(here, lift, { transitType: 'ELEVATOR', distance: 0, weight: 300 });
    await connectNodes(lift, exit);

    const result = await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: ctxFor(building.id, here.id),
      args: {},
    });

    expect(result.data.found).toBe(false);
  });
});

describe('get_route respects closures like GET /api/wayfinding/route', () => {
  test('a place behind a fully closed corridor is reported unreachable', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 50 });
    const lobby = await createNode(building.id, floor.id, { x: 0, label: 'Lobby' });
    const shop = await createNode(building.id, floor.id, { x: 300, type: 'POI' });
    const corridor = await connectNodes(lobby, shop);
    const poi = await prisma.poi.create({ data: { nodeId: shop.id, name: 'Bakery', category: 'food' } });
    await closeEdge(building.id, corridor.id);

    const http = await request(app).get(`/api/wayfinding/route?from=${lobby.id}&to=poi:${poi.id}`);
    const tool = await runTool({
      tool: wayfindingTools.get_route,
      ctx: ctxFor(building.id, lobby.id),
      args: { toPoiId: poi.id },
    });

    expect(http.status).toBe(404);
    expect(tool.data.found).toBe(false);
  });
});


/* ============================================================================
   D14 / FX-045 — when closures cut off every exit, give the least-closed way
   out with a warning (founder decision 2026-11-03).

   "No exit route found" leaves a person inside an incident with nothing. The
   last resort routes through closed areas at a heavy cost (so it crosses as
   few as possible), keeps visibility and the lift block, and says loudly that
   it did — on the route, in the brief, and to the AI.
   ========================================================================= */
describe('last-resort evacuation when every exit is behind a closure', () => {
  const seedAllClosed = async () => {
    const seeded = await seedTwoExits();
    const southCorridor = await prisma.edge.findFirst({
      where: { buildingId: seeded.building.id, id: { not: seeded.shortCorridor.id } },
    });
    await closeEdge(seeded.building.id, seeded.shortCorridor.id);
    await closeEdge(seeded.building.id, southCorridor.id);
    return seeded;
  };

  test('/evacuate returns the least-closed route, flagged, instead of 404', async () => {
    const { lobby, north } = await seedAllClosed();

    const res = await request(app).get(`/api/wayfinding/evacuate?from=${lobby.id}`);

    expect(res.status).toBe(200);
    const { route } = res.body.data;
    expect(route.closuresIgnored).toBe(true);
    expect(route.warnings[0].code).toBe('ROUTE_THROUGH_CLOSURE');
    // Both corridors are closed; the shorter one is the least-bad.
    expect(route.destination.nodeId).toBe(north.id);
  });

  test('a normal route around a closure is not flagged', async () => {
    const { building, lobby, shortCorridor } = await seedTwoExits();
    await closeEdge(building.id, shortCorridor.id);

    const res = await request(app).get(`/api/wayfinding/evacuate?from=${lobby.id}`);

    expect(res.body.data.route.closuresIgnored).toBeFalsy();
    expect(res.body.data.route.warnings.some((w) => w.code === 'ROUTE_THROUGH_CLOSURE')).toBe(false);
  });

  test('the brief and the AI tool report the same exit and say it is through a closure', async () => {
    const { building, lobby } = await seedAllClosed();

    const facts = await buildBriefFacts({ buildingId: building.id, nodeId: lobby.id });
    const tool = await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: ctxFor(building.id, lobby.id),
      args: {},
    });

    expect(facts.found).toBe(true);
    expect(facts.closuresIgnored).toBe(true);
    expect(facts.exitName).toBe('North Exit');
    expect(tool.data.closuresIgnored).toBe(true);
    expect(tool.data.exitName).toBe('North Exit');
  });

  test('the last resort still never uses a lift the building has not rated', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const ground = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 50 });
    const upper = await createFloor(building.id, { floorNumber: 2, scalePixelsPerMeter: 50 });
    const here = await createNode(building.id, upper.id, { label: 'Office' });
    const lift = await createNode(building.id, ground.id, { type: 'TRANSIT' });
    const exit = await createNode(building.id, ground.id, { x: 300, type: 'EMERGENCY_EXIT' });
    await connectNodes(here, lift, { transitType: 'ELEVATOR', distance: 0, weight: 300 });
    const corridor = await connectNodes(lift, exit);
    await closeEdge(building.id, corridor.id);

    const res = await request(app).get(`/api/wayfinding/evacuate?from=${here.id}`);

    expect(res.status).toBe(404);
  });
});

describe('briefTemplate — last-resort caution (D14)', () => {
  test('warns in English and Georgian when the route crosses a closed area', async () => {
    const { briefTemplate } = await import('../features/ai/evacuationBrief.routes.js');
    const facts = { found: true, exitName: 'North Exit', floorChanges: 0, closuresIgnored: true };

    expect(briefTemplate(facts, 'en')).toMatch(/closed area/);
    expect(briefTemplate(facts, 'ka')).toMatch(/სიფრთხილით/);
    expect(briefTemplate({ ...facts, closuresIgnored: false }, 'en')).not.toMatch(/closed area/);
  });
});
