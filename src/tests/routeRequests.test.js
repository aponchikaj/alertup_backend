import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { runTool } from '../features/ai/agents/toolRegistry.js';
import { wayfindingTools } from '../features/ai/agents/tools/wayfindingTools.js';
import { clearAll } from '../features/wayfinding/graphCache.js';
import {
  createOwnerWithBuilding,
  createFloor,
  createNode,
  connectNodes,
  qrIdFor,
} from './helpers.js';
import { drain } from '../services/analyticsQueue.js';

/**
 * RouteRequest analytics (B13): what visitors actually asked for, so a
 * building owner can see which destinations people search for and which
 * routes fail. Writes go through the analytics queue, so every assertion on
 * the database follows an `await drain()`.
 */

beforeEach(() => clearAll());

async function seedMall() {
  const seeded = await createOwnerWithBuilding();
  const { building } = seeded;
  const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
  const entrance = await createNode(building.id, floor.id, { x: 0, y: 0, type: 'ENTRANCE' });
  const shopNode = await createNode(building.id, floor.id, { x: 300, y: 0, type: 'POI' });
  const exit = await createNode(building.id, floor.id, { x: 50, y: 50, type: 'EMERGENCY_EXIT' });
  const island = await createNode(building.id, floor.id, { x: 900, y: 900, type: 'NORMAL' });
  await connectNodes(entrance, shopNode);
  await connectNodes(entrance, exit);
  const poi = await prisma.poi.create({
    data: { nodeId: shopNode.id, buildingId: building.id, name: 'LC Waikiki' },
  });
  return { ...seeded, floor, entrance, shopNode, exit, island, poi };
}

describe('RouteRequest — /api/wayfinding/route', () => {
  test('a successful route call writes one found:true row after drain', async () => {
    const { building, entrance, poi } = await seedMall();

    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}`
    );
    expect(res.status).toBe(200);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      to: `poi:${poi.id}`,
      profile: 'walk',
      mode: 'WAYFINDING',
      src: 'web',
      found: true,
    });
    expect(rows[0].distanceM).not.toBeNull();
    expect(rows[0].durationSec).not.toBeNull();
  });

  test('a 404 (no route between two disconnected points) still writes a found:false row', async () => {
    const { building, entrance, island } = await seedMall();

    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=${island.id}`
    );
    expect(res.status).toBe(404);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      to: island.id,
      mode: 'WAYFINDING',
      found: false,
      distanceM: null,
      durationSec: null,
    });
  });

  test('an unknown origin node never writes a row — buildingId is never known', async () => {
    const fakeNodeId = 'a'.repeat(24);
    const res = await request(app).get(`/api/wayfinding/route?from=${fakeNodeId}&to=${fakeNodeId}`);
    expect(res.status).toBe(404);

    await drain();

    const count = await prisma.routeRequest.count();
    expect(count).toBe(0);
  });

  test('a multi-stop request records `to` as the ordered list of requested stops, not just the last one', async () => {
    const { building, entrance, shopNode, exit } = await seedMall();

    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=${exit.id}&to=${shopNode.id}`
    );
    expect(res.status).toBe(200);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].to)).toEqual([exit.id, shopNode.id]);
    expect(rows[0].found).toBe(true);
  });

  test('a failing insert (spied rejection) never affects the HTTP response', async () => {
    const { entrance, poi } = await seedMall();

    const spy = jest
      .spyOn(prisma.routeRequest, 'create')
      .mockRejectedValueOnce(new Error('boom'));

    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=poi:${poi.id}`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.route).toBeTruthy();

    await drain();

    spy.mockRestore();
  });
});

describe('RouteRequest — /api/wayfinding/evacuate', () => {
  test('a successful evacuation writes a found:true EVACUATION row', async () => {
    const { building, entrance } = await seedMall();

    const res = await request(app).get(`/api/wayfinding/evacuate?from=${entrance.id}`);
    expect(res.status).toBe(200);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      mode: 'EVACUATION',
      found: true,
    });
  });

  test('no exit reachable still writes a found:false EVACUATION row', async () => {
    const seeded = await createOwnerWithBuilding();
    const floor = await createFloor(seeded.building.id, { floorNumber: 1 });
    // A lone, disconnected node: nothing to route to.
    const stranded = await createNode(seeded.building.id, floor.id, { x: 0, y: 0 });

    const res = await request(app).get(`/api/wayfinding/evacuate?from=${stranded.id}`);
    expect(res.status).toBe(404);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: seeded.building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'EVACUATION', found: false });
  });
});

describe('RouteRequest — QR scan route', () => {
  test('a scan records src:"scan" against the same table', async () => {
    const { building, floor, entrance } = await seedMall();
    const qrId = qrIdFor(entrance, floor.floorNumber);

    const res = await request(app).get(`/api/qr/scan/route/${qrId}`);
    expect(res.status).toBe(200);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      mode: 'EVACUATION',
      src: 'scan',
    });
  });

  // B16: the stored `profile` column must reflect the profile actually used
  // for THIS request, not a value hardcoded at the call site — a scan under
  // `?profile=wheelchair` is a different row, for analytics purposes, than a
  // plain emergency one, and a column that silently means different things
  // across rows is worse than no column at all.
  test('a scan under ?profile=wheelchair records "wheelchair", not a hardcoded value', async () => {
    const { building, floor, entrance } = await seedMall();
    const qrId = qrIdFor(entrance, floor.floorNumber);

    const res = await request(app).get(`/api/qr/scan/route/${qrId}?profile=wheelchair`);
    expect(res.status).toBe(200);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      mode: 'EVACUATION',
      src: 'scan',
      profile: 'wheelchair',
    });
  });
});

describe('RouteRequest — AI wayfinding tool', () => {
  test('get_route records src:"ai"', async () => {
    const { building, entrance, shopNode } = await seedMall();

    await runTool({
      tool: wayfindingTools.get_route,
      ctx: { buildingId: building.id, nodeId: entrance.id, permissions: [] },
      args: { toNodeId: shopNode.id },
    });

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      to: shopNode.id,
      mode: 'WAYFINDING',
      src: 'ai',
      found: true,
    });
  });

  test('find_nearest_exit records src:"ai" against the EVACUATION mode, with an EVACUATION-shaped profile', async () => {
    const { building, entrance } = await seedMall();

    await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: { buildingId: building.id, nodeId: entrance.id, permissions: [] },
      args: {},
    });

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      mode: 'EVACUATION',
      src: 'ai',
      found: true,
      // Every other EVACUATION-mode row records 'wheelchair' or 'emergency'
      // — never 'walk', which is the WAYFINDING-mode default and means
      // something else entirely on this shared column.
      profile: 'emergency',
    });
  });

  test('find_nearest_exit records profile:"emergency" (not "walk") on a failed search too', async () => {
    const seeded = await createOwnerWithBuilding();
    const floor = await createFloor(seeded.building.id, { floorNumber: 1 });
    const stranded = await createNode(seeded.building.id, floor.id, { x: 0, y: 0 });

    await runTool({
      tool: wayfindingTools.find_nearest_exit,
      ctx: { buildingId: seeded.building.id, nodeId: stranded.id, permissions: [] },
      args: {},
    });

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: seeded.building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'EVACUATION', found: false, profile: 'emergency' });
  });

  test('get_route records a found:false row when the requested poi never resolves — the mistyped/invented destination case', async () => {
    const { building, entrance } = await seedMall();

    const result = await runTool({
      tool: wayfindingTools.get_route,
      ctx: { buildingId: building.id, nodeId: entrance.id, permissions: [] },
      args: { toPoiId: 'not-a-real-poi-id' },
    });
    expect(result.data.found).toBe(false);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      to: 'poi:not-a-real-poi-id',
      mode: 'WAYFINDING',
      src: 'ai',
      found: false,
    });
  });

  test('get_route records a found:false row when the resolved node is not in this building\'s graph', async () => {
    const { building, entrance } = await seedMall();
    const other = await createOwnerWithBuilding();
    const otherFloor = await createFloor(other.building.id, { floorNumber: 1 });
    const otherNode = await createNode(other.building.id, otherFloor.id);

    const result = await runTool({
      tool: wayfindingTools.get_route,
      ctx: { buildingId: building.id, nodeId: entrance.id, permissions: [] },
      args: { toNodeId: otherNode.id },
    });
    expect(result.data.found).toBe(false);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      to: otherNode.id,
      mode: 'WAYFINDING',
      src: 'ai',
      found: false,
    });
  });
});

describe('RouteRequest — remaining per-branch coverage', () => {
  test('/evacuate with an unknown origin never writes a row — buildingId is never known', async () => {
    const fakeNodeId = 'a'.repeat(24);
    const res = await request(app).get(`/api/wayfinding/evacuate?from=${fakeNodeId}`);
    expect(res.status).toBe(404);

    await drain();

    const count = await prisma.routeRequest.count();
    expect(count).toBe(0);
  });

  test('a multi-stop planning failure (one stop unreachable, not merely absent) 404s and records found:false', async () => {
    const { building, entrance, shopNode, island } = await seedMall();

    // `shopNode` is reachable; `island` is a real node in this building's
    // graph but has no edges at all, so `resolveDestination` and the
    // graph-membership check both pass — only `planMultiStopWithFallbacks`
    // itself fails. This is a distinct shape from the single-destination
    // "no route found" 404 and from "destination not in this building": it
    // is the multi-stop plan's OWN failure path, so it needs its own test
    // rather than resting on the single-destination equivalent.
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=${shopNode.id}&to=${island.id}`
    );
    expect(res.status).toBe(404);

    await drain();

    const rows = await prisma.routeRequest.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      buildingId: building.id,
      fromNodeId: entrance.id,
      mode: 'WAYFINDING',
      found: false,
    });
    expect(JSON.parse(rows[0].to)).toEqual([shopNode.id, island.id]);
  });
});
