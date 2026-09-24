import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { buildGraph } from './graphFixtures.js';
import { clearAll } from '../features/wayfinding/graphCache.js';
import { subscribe } from '../features/realtime/broadcaster.js';
import {
  createOwnerWithBuilding,
  createUser,
  createFloor,
  createNode,
  connectNodes,
  addMember,
  qrIdFor,
} from './helpers.js';
import {
  buildOverlay,
  publicClosure,
  applyOverlay,
  getActiveClosures,
  invalidateClosures,
  clearAllClosures,
} from '../features/wayfinding/closures.js';

/* ============================================================================
   B7 — route-time closures.

   A closure is an incident-cadence fact: "this corridor is flooded", "this
   lift is out". It has to reach the router within seconds, it has to expire
   on its own, and it must never strand the person who just scanned the QR
   standing next to it.
   ========================================================================= */

/**
 * a —— b —— c on floor 1 (a straight corridor), plus the one stair up to d on
 * floor 2. `b` is the only way from `a` to `c`, so blocking it (or either of
 * its edges) leaves no route at all — which is exactly what a closure test
 * needs to be able to assert.
 */
const corridor = () =>
  buildGraph({
    nodes: [
      { id: 'a', x: 0, y: 0, floorNumber: 1 },
      { id: 'b', x: 100, y: 0, floorNumber: 1 },
      { id: 'c', x: 200, y: 0, floorNumber: 1 },
      { id: 'd', x: 200, y: 0, floorNumber: 2 },
    ],
    edges: [
      ['a', 'b', { edgeId: 'e-ab' }],
      ['b', 'c', { edgeId: 'e-bc' }],
      ['c', 'd', { edgeId: 'e-cd', transitType: 'STAIRS' }],
    ],
  });

const closure = (overrides = {}) => ({
  id: 'cl-1',
  buildingId: 'bld-1',
  floorId: null,
  edgeIds: [],
  nodeIds: [],
  costMultiplier: null,
  reason: null,
  startsAt: new Date('2026-01-01T00:00:00.000Z'),
  endsAt: null,
  createdById: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('buildOverlay', () => {
  test('an empty closure list produces an inert overlay', () => {
    const overlay = buildOverlay([], corridor());

    expect(overlay.edgeMultiplier.size).toBe(0);
    expect(overlay.blockedEdgeIds.size).toBe(0);
    expect(overlay.blockedNodeIds.size).toBe(0);
  });

  test('a null costMultiplier blocks the listed edges outright', () => {
    const overlay = buildOverlay(
      [closure({ edgeIds: ['e-ab'], costMultiplier: null })],
      corridor()
    );

    expect([...overlay.blockedEdgeIds]).toEqual(['e-ab']);
    expect(overlay.edgeMultiplier.size).toBe(0);
  });

  test('a costMultiplier penalizes the listed edges instead of blocking them', () => {
    const overlay = buildOverlay(
      [closure({ edgeIds: ['e-ab'], costMultiplier: 4 })],
      corridor()
    );

    expect(overlay.edgeMultiplier.get('e-ab')).toBe(4);
    expect(overlay.blockedEdgeIds.size).toBe(0);
  });

  test('a blocked node goes to blockedNodeIds, not to its edges', () => {
    // The origin exemption can only lift a block that lives on the node, so
    // baking a node closure down into its edge ids would make the exemption
    // impossible.
    const overlay = buildOverlay(
      [closure({ nodeIds: ['b'], costMultiplier: null })],
      corridor()
    );

    expect([...overlay.blockedNodeIds]).toEqual(['b']);
    expect(overlay.blockedEdgeIds.size).toBe(0);
  });

  test('a penalized node penalizes every edge touching it', () => {
    const overlay = buildOverlay(
      [closure({ nodeIds: ['b'], costMultiplier: 3 })],
      corridor()
    );

    expect(overlay.edgeMultiplier.get('e-ab')).toBe(3);
    expect(overlay.edgeMultiplier.get('e-bc')).toBe(3);
    expect(overlay.edgeMultiplier.has('e-cd')).toBe(false);
    expect(overlay.blockedNodeIds.size).toBe(0);
  });

  test('a floor with no explicit ids covers every edge with both ends on it', () => {
    const overlay = buildOverlay(
      [closure({ floorId: 'floor-1', costMultiplier: null })],
      corridor()
    );

    // e-cd straddles floors 1 and 2 — closing floor 1 must not close the
    // staircase that leads off it, or a floor closure becomes a trap.
    expect([...overlay.blockedEdgeIds].sort()).toEqual(['e-ab', 'e-bc']);
  });

  test('a floorId alongside explicit ids scopes to the ids, not the floor', () => {
    const overlay = buildOverlay(
      [closure({ floorId: 'floor-1', edgeIds: ['e-ab'], costMultiplier: null })],
      corridor()
    );

    expect([...overlay.blockedEdgeIds]).toEqual(['e-ab']);
  });

  test('overlapping penalties compound rather than overwrite', () => {
    const overlay = buildOverlay(
      [
        closure({ id: 'cl-1', edgeIds: ['e-ab'], costMultiplier: 2 }),
        closure({ id: 'cl-2', edgeIds: ['e-ab'], costMultiplier: 3 }),
      ],
      corridor()
    );

    expect(overlay.edgeMultiplier.get('e-ab')).toBe(6);
  });

  test('a block beats a penalty on the same edge', () => {
    const overlay = buildOverlay(
      [
        closure({ id: 'cl-1', edgeIds: ['e-ab'], costMultiplier: 2 }),
        closure({ id: 'cl-2', edgeIds: ['e-ab'], costMultiplier: null }),
      ],
      corridor()
    );

    expect(overlay.blockedEdgeIds.has('e-ab')).toBe(true);
    expect(overlay.edgeMultiplier.has('e-ab')).toBe(false);
  });

  test('unknown ids are ignored rather than poisoning the overlay', () => {
    const overlay = buildOverlay(
      [closure({ edgeIds: ['nope'], nodeIds: ['also-nope'], costMultiplier: null })],
      corridor()
    );

    expect(overlay.blockedEdgeIds.size).toBe(0);
    expect(overlay.blockedNodeIds.size).toBe(0);
  });

  test('a mixed node+edge block keeps the node part liftable', () => {
    // The origin exemption can only lift `blockedNodeIds`. If naming an edge
    // alongside a node made the node's own edges HARD edge blocks, anyone
    // standing on that node would be stranded with no route at all — the one
    // thing the exemption exists to prevent.
    const overlay = buildOverlay(
      [closure({ nodeIds: ['b'], edgeIds: ['e-ab'], costMultiplier: null })],
      corridor()
    );

    expect([...overlay.blockedEdgeIds]).toEqual(['e-ab']);
    expect([...overlay.blockedNodeIds]).toEqual(['b']);
  });

  test('a scope named by ids stays scoped to ids even when every id is gone', () => {
    // The edge this closure named has since been deleted from the map. It now
    // restricts nothing — it must NOT quietly widen into the whole floor it
    // also carries for labelling.
    const overlay = buildOverlay(
      [closure({ floorId: 'floor-1', edgeIds: ['deleted'], costMultiplier: null })],
      corridor()
    );

    expect(overlay.blockedEdgeIds.size).toBe(0);
    expect(overlay.blockedNodeIds.size).toBe(0);
  });

  test('a stale edge id alongside a node leaves the node block liftable', () => {
    const overlay = buildOverlay(
      [closure({ nodeIds: ['b'], edgeIds: ['deleted'], costMultiplier: null })],
      corridor()
    );

    expect(overlay.blockedEdgeIds.size).toBe(0);
    expect([...overlay.blockedNodeIds]).toEqual(['b']);
  });

  test('a mixed node+edge penalty applies once per edge, not once per scope', () => {
    const overlay = buildOverlay(
      [closure({ nodeIds: ['b'], edgeIds: ['e-ab'], costMultiplier: 2 })],
      corridor()
    );

    expect(overlay.edgeMultiplier.get('e-ab')).toBe(2);
    expect(overlay.edgeMultiplier.get('e-bc')).toBe(2);
  });

  test('the fingerprint is stable for the same closures and changes with them', () => {
    const graph = corridor();
    const a = buildOverlay([closure({ edgeIds: ['e-ab'], costMultiplier: 2 })], graph);
    const same = buildOverlay([closure({ edgeIds: ['e-ab'], costMultiplier: 2 })], graph);
    const different = buildOverlay([closure({ edgeIds: ['e-ab'], costMultiplier: 5 })], graph);

    expect(a.fingerprint).toBe(same.fingerprint);
    expect(a.fingerprint).not.toBe(different.fingerprint);
    expect(buildOverlay([], graph).fingerprint).toBe('');
  });
});

describe('publicClosure', () => {
  test('emits exactly the wire-contract shape', () => {
    const row = closure({
      id: 'cl-9',
      floorId: 'floor-1',
      reason: 'Flooded corridor',
      costMultiplier: 2.5,
      endsAt: new Date('2026-01-01T02:00:00.000Z'),
    });

    expect(publicClosure(row)).toEqual({
      id: 'cl-9',
      floorId: 'floor-1',
      reason: 'Flooded corridor',
      costMultiplier: 2.5,
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-01-01T02:00:00.000Z',
      blocked: false,
    });
  });

  test('a null multiplier reads as blocked, and an open end as null', () => {
    const view = publicClosure(closure({ costMultiplier: null, endsAt: null }));

    expect(view.blocked).toBe(true);
    expect(view.endsAt).toBeNull();
  });
});

describe('applyOverlay', () => {
  const spec = (graph) => ({ graph, name: 'walk' });

  test('folds the overlay into the routing context it returns', () => {
    const graph = corridor();
    const overlay = buildOverlay(
      [closure({ edgeIds: ['e-ab'], costMultiplier: null })],
      graph
    );

    const ctx = applyOverlay(spec(graph), overlay, { originId: 'a' });

    expect(ctx.ok).toBe(true);
    const abEdge = graph.adj.get('a').find((e) => e.edgeId === 'e-ab');
    expect(ctx.edgeFilter(abEdge, graph.nodes.get('a'), graph.nodes.get('b'))).toBe(false);
  });

  test('never blocks the origin node — the person scanning is already there', () => {
    const graph = corridor();
    const overlay = buildOverlay(
      [closure({ nodeIds: ['b'], costMultiplier: null })],
      graph
    );

    const fromElsewhere = applyOverlay(spec(graph), overlay, { originId: 'a' });
    const fromB = applyOverlay(spec(graph), overlay, { originId: 'b' });
    const bcEdge = graph.adj.get('b').find((e) => e.edgeId === 'e-bc');
    const [b, c] = [graph.nodes.get('b'), graph.nodes.get('c')];

    expect(fromElsewhere.edgeFilter(bcEdge, b, c)).toBe(false);
    expect(fromB.edgeFilter(bcEdge, b, c)).toBe(true);
  });

  test('exposes the origin-adjusted overlay for the assembler to warn from', () => {
    const graph = corridor();
    const overlay = buildOverlay(
      [closure({ nodeIds: ['b'], costMultiplier: null })],
      graph
    );

    const ctx = applyOverlay(spec(graph), overlay, { originId: 'b' });

    expect(ctx.overlay.blockedNodeIds.has('b')).toBe(false);
    // The overlay handed in is never mutated: it is cached per request and
    // reused by the assembler.
    expect(overlay.blockedNodeIds.has('b')).toBe(true);
  });

  test('passes an unknown profile name through as the 400 buildRoutingContext gives', () => {
    const graph = corridor();

    const ctx = applyOverlay({ graph, name: 'teleport' }, buildOverlay([], graph), {
      originId: 'a',
    });

    expect(ctx.ok).toBe(false);
    expect(ctx.status).toBe(400);
  });
});

/* ---------------------------------------------------------------- cache --- */

describe('getActiveClosures', () => {
  const at = (msFromNow) => new Date(Date.now() + msFromNow);

  const seedClosure = async (buildingId, data = {}) =>
    prisma.closure.create({
      data: { buildingId, costMultiplier: null, ...data },
    });

  beforeEach(() => clearAllClosures());

  test('returns a closure that has started and has not ended', async () => {
    const { building } = await createOwnerWithBuilding();
    const row = await seedClosure(building.id, {
      startsAt: at(-60_000),
      endsAt: at(60_000),
      reason: 'Flood',
    });

    const active = await getActiveClosures(building.id);

    expect(active.map((c) => c.id)).toEqual([row.id]);
  });

  test('ignores a closure that has not started yet', async () => {
    const { building } = await createOwnerWithBuilding();
    await seedClosure(building.id, { startsAt: at(60_000) });

    expect(await getActiveClosures(building.id)).toEqual([]);
  });

  test('a closure scheduled to start inside the TTL needs no flush', async () => {
    const { building } = await createOwnerWithBuilding();
    const row = await seedClosure(building.id, { startsAt: at(5_000) });

    // Warm the cache before it starts…
    expect(await getActiveClosures(building.id)).toEqual([]);
    // …and it is in force at its start time, off the same cached rows.
    const later = await getActiveClosures(building.id, at(6_000));

    expect(later.map((c) => c.id)).toEqual([row.id]);
  });

  test('an expired closure is ignored without a cache flush', async () => {
    const { building } = await createOwnerWithBuilding();
    await seedClosure(building.id, { startsAt: at(-60_000), endsAt: at(5_000) });

    expect(await getActiveClosures(building.id)).toHaveLength(1);
    // Same cache entry, later clock: expiry needs no write and no eviction.
    expect(await getActiveClosures(building.id, at(6_000))).toEqual([]);
  });

  test('caches per building until invalidated', async () => {
    const { building } = await createOwnerWithBuilding();
    await getActiveClosures(building.id); // warm: empty

    await seedClosure(building.id, { startsAt: at(-1_000) });
    expect(await getActiveClosures(building.id)).toEqual([]);

    invalidateClosures(building.id);
    expect(await getActiveClosures(building.id)).toHaveLength(1);
  });

  test('scopes to the building asked for', async () => {
    const mine = await createOwnerWithBuilding();
    const theirs = await createOwnerWithBuilding();
    await seedClosure(theirs.building.id, { startsAt: at(-1_000) });

    expect(await getActiveClosures(mine.building.id)).toEqual([]);
    expect(await getActiveClosures(theirs.building.id)).toHaveLength(1);
  });
});

/* ---------------------------------------------------------- HTTP routes --- */

const closuresUrl = (buildingId) => `/api/map-editor/buildings/${buildingId}/closures`;

/** Collect everything published on a building's realtime channel. */
const captureEvents = (buildingId) => {
  const seen = [];
  const stop = subscribe(buildingId, (msg) => seen.push(msg));
  return { seen, stop };
};

describe('closure CRUD', () => {
  beforeEach(() => {
    clearAllClosures();
    clearAll();
  });

  const seed = async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0, label: 'A' });
    const b = await createNode(building.id, floor.id, { x: 100, y: 0, label: 'B' });
    const edge = await connectNodes(a, b);
    return { cookie, building, roles, floor, a, b, edge };
  };

  test('an owner creates a closure, which is published and cached fresh', async () => {
    const { cookie, building, edge, floor } = await seed();
    const { seen, stop } = captureEvents(building.id);

    const res = await request(app)
      .post(closuresUrl(building.id))
      .set('Cookie', cookie)
      .send({ edgeIds: [edge.id], floorId: floor.id, reason: 'Flooded', costMultiplier: null });

    expect(res.status).toBe(201);
    expect(res.body.data.closure).toMatchObject({
      blocked: true,
      reason: 'Flooded',
      costMultiplier: null,
    });
    expect(seen).toEqual([
      {
        event: 'closure_changed',
        data: expect.objectContaining({
          closureId: res.body.data.closure.id,
          action: 'created',
          blocked: true,
          edgeIds: [edge.id],
          nodeIds: [],
          reason: 'Flooded',
          endsAt: null,
        }),
      },
    ]);
    // The write invalidated the closure cache, so the router sees it at once.
    expect(await getActiveClosures(building.id)).toHaveLength(1);
    stop();
  });

  test('a member without CAN_EDIT_MAP cannot write, and anonymous cannot either', async () => {
    const { building, roles, edge } = await seed();
    const viewer = await createUser();
    await addMember(building.id, viewer.user.id, roles.Viewer.id);

    const member = await request(app)
      .post(closuresUrl(building.id))
      .set('Cookie', viewer.cookie)
      .send({ edgeIds: [edge.id] });
    expect(member.status).toBe(403);

    const anon = await request(app).post(closuresUrl(building.id)).send({ edgeIds: [edge.id] });
    expect(anon.status).toBe(401);

    const anonList = await request(app).get(closuresUrl(building.id));
    expect(anonList.status).toBe(401);
  });

  test('rejects ids from another building, bad multipliers, bad windows and long reasons', async () => {
    const { cookie, building, edge } = await seed();
    const other = await seed();

    const post = (body) =>
      request(app).post(closuresUrl(building.id)).set('Cookie', cookie).send(body);

    expect((await post({ edgeIds: [other.edge.id] })).status).toBe(422);
    expect((await post({ nodeIds: [other.a.id] })).status).toBe(422);
    expect((await post({ floorId: other.floor.id })).status).toBe(422);
    expect((await post({ edgeIds: [edge.id], costMultiplier: 0.5 })).status).toBe(422);
    expect((await post({ edgeIds: [edge.id], costMultiplier: 'soon' })).status).toBe(422);
    expect(
      (
        await post({
          edgeIds: [edge.id],
          startsAt: '2026-01-02T00:00:00.000Z',
          endsAt: '2026-01-01T00:00:00.000Z',
        })
      ).status
    ).toBe(422);
    expect((await post({ edgeIds: [edge.id], reason: 'x'.repeat(201) })).status).toBe(422);
    // Nothing targeted at all: a closure that restricts nothing is a mistake,
    // not an empty success.
    expect((await post({})).status).toBe(422);
  });

  test('patch and delete publish their own actions and refresh the cache', async () => {
    const { cookie, building, edge } = await seed();
    const created = await request(app)
      .post(closuresUrl(building.id))
      .set('Cookie', cookie)
      .send({ edgeIds: [edge.id], reason: 'Flooded' });
    const closureId = created.body.data.closure.id;

    const { seen, stop } = captureEvents(building.id);

    const patched = await request(app)
      .patch(`${closuresUrl(building.id)}/${closureId}`)
      .set('Cookie', cookie)
      .send({ costMultiplier: 3, reason: 'Wet floor' });
    expect(patched.status).toBe(200);
    expect(patched.body.data.closure).toMatchObject({ blocked: false, costMultiplier: 3 });

    const removed = await request(app)
      .delete(`${closuresUrl(building.id)}/${closureId}`)
      .set('Cookie', cookie);
    expect(removed.status).toBe(200);

    expect(seen.map((m) => m.data.action)).toEqual(['updated', 'deleted']);
    expect(seen[0].data).toMatchObject({ closureId, blocked: false, reason: 'Wet floor' });
    expect(await getActiveClosures(building.id)).toEqual([]);
    stop();
  });

  test('a closure from another building is not reachable by id', async () => {
    const { cookie, building } = await seed();
    const other = await seed();
    const created = await request(app)
      .post(closuresUrl(other.building.id))
      .set('Cookie', other.cookie)
      .send({ edgeIds: [other.edge.id] });

    const res = await request(app)
      .patch(`${closuresUrl(building.id)}/${created.body.data.closure.id}`)
      .set('Cookie', cookie)
      .send({ reason: 'nope' });

    expect(res.status).toBe(404);
  });

  test('the editor list shows scheduled and expired rows; the public list shows only active ones', async () => {
    const { cookie, building, edge } = await seed();
    const now = Date.now();
    const active = await prisma.closure.create({
      data: {
        buildingId: building.id,
        edgeIds: [edge.id],
        reason: 'Now',
        startsAt: new Date(now - 60_000),
      },
    });
    await prisma.closure.create({
      data: {
        buildingId: building.id,
        edgeIds: [edge.id],
        reason: 'Over',
        startsAt: new Date(now - 120_000),
        endsAt: new Date(now - 60_000),
      },
    });
    await prisma.closure.create({
      data: {
        buildingId: building.id,
        edgeIds: [edge.id],
        reason: 'Later',
        startsAt: new Date(now + 600_000),
      },
    });

    const editor = await request(app).get(closuresUrl(building.id)).set('Cookie', cookie);
    expect(editor.status).toBe(200);
    expect(editor.body.data.closures.map((c) => c.reason).sort()).toEqual([
      'Later',
      'Now',
      'Over',
    ]);

    const publicList = await request(app).get(
      `/api/wayfinding/buildings/${building.id}/closures`
    );
    expect(publicList.status).toBe(200);
    expect(publicList.body.data.closures).toEqual([
      expect.objectContaining({ id: active.id, reason: 'Now', blocked: true }),
    ]);
    // The public view never leaks which edges or nodes are involved.
    expect(publicList.body.data.closures[0].edgeIds).toBeUndefined();
  });
});

/* ------------------------------------------------- routing under closure --- */

describe('closures change the route', () => {
  beforeEach(() => {
    clearAllClosures();
    clearAll();
  });

  /** a —— b —— c, one corridor and nothing else. */
  const seedCorridor = async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const a = await createNode(building.id, floor.id, { x: 0, y: 0, label: 'A' });
    const b = await createNode(building.id, floor.id, { x: 100, y: 0, label: 'B' });
    const c = await createNode(building.id, floor.id, { x: 200, y: 0, label: 'C' });
    const ab = await connectNodes(a, b);
    const bc = await connectNodes(b, c);
    return { cookie, building, floor, a, b, c, ab, bc };
  };

  /** The corridor above plus a long way round: a — d — e — c. */
  const seedWithDetour = async () => {
    const base = await seedCorridor();
    const d = await createNode(base.building.id, base.floor.id, { x: 0, y: 300, label: 'D' });
    const e = await createNode(base.building.id, base.floor.id, { x: 200, y: 300, label: 'E' });
    await connectNodes(base.a, d);
    await connectNodes(d, e);
    await connectNodes(e, base.c);
    return { ...base, d, e };
  };

  const routeNodeIds = (route) => route.segments.flatMap((s) => s.nodes.map((n) => n.id));

  const askRoute = (from, to, query = '') =>
    request(app).get(`/api/wayfinding/route?from=${from}&to=${to}${query}`);

  test('a blocked edge on the only corridor leaves no route at all', async () => {
    const { building, a, c, bc } = await seedCorridor();
    await prisma.closure.create({
      data: { buildingId: building.id, edgeIds: [bc.id], reason: 'Flood' },
    });

    const res = await askRoute(a.id, c.id);

    expect(res.status).toBe(404);
  });

  test('a penalized edge detours instead of blocking', async () => {
    const { building, a, c, b, d, ab } = await seedWithDetour();

    const before = await askRoute(a.id, c.id);
    expect(routeNodeIds(before.body.data.route)).toContain(b.id);

    await prisma.closure.create({
      data: { buildingId: building.id, edgeIds: [ab.id], costMultiplier: 10, reason: 'Crowded' },
    });
    clearAllClosures();

    const after = await askRoute(a.id, c.id);
    expect(after.status).toBe(200);
    const ids = routeNodeIds(after.body.data.route);
    expect(ids).toContain(d.id);
    expect(ids).not.toContain(b.id);
    expect(after.body.data.closures).toEqual([
      expect.objectContaining({ reason: 'Crowded', blocked: false, costMultiplier: 10 }),
    ]);
    // The wire contract puts them on the route too — the frontend normalizes
    // `route.closures`, and a route travels alone once it is embedded.
    expect(after.body.data.route.closures).toEqual(after.body.data.closures);
  });

  test('routing through an unavoidable penalty warns CLOSURE_ON_ROUTE', async () => {
    const { building, a, c, ab } = await seedCorridor();
    await prisma.closure.create({
      data: { buildingId: building.id, edgeIds: [ab.id], costMultiplier: 5, reason: 'Wet' },
    });

    const res = await askRoute(a.id, c.id);

    expect(res.status).toBe(200);
    expect(res.body.data.route.warnings.map((w) => w.code)).toContain('CLOSURE_ON_ROUTE');
  });

  test('a blocked node blocks the edges touching it — unless it is the origin', async () => {
    const { building, a, b, c } = await seedCorridor();
    await prisma.closure.create({
      data: { buildingId: building.id, nodeIds: [b.id], reason: 'Ceiling collapse' },
    });

    // Routed past: b is impassable, and b is the only way through.
    expect((await askRoute(a.id, c.id)).status).toBe(404);
    // Standing on it: the person who scanned the sticker still gets out.
    const fromB = await askRoute(b.id, c.id);
    expect(fromB.status).toBe(200);
    expect(routeNodeIds(fromB.body.data.route)).toEqual([b.id, c.id]);
  });

  test('a mixed node+edge closure still lets the person standing on the node out', async () => {
    const { building, a, b, c, ab } = await seedCorridor();
    await prisma.closure.create({
      data: {
        buildingId: building.id,
        nodeIds: [b.id],
        edgeIds: [ab.id],
        reason: 'Ceiling collapse',
      },
    });

    // Routed past b: the node is shut and it is the only way through.
    expect((await askRoute(a.id, c.id)).status).toBe(404);
    // Standing on b: naming an edge in the same closure must not have turned
    // b's own edges into blocks the exemption cannot lift.
    const fromB = await askRoute(b.id, c.id);
    expect(fromB.status).toBe(200);
    expect(routeNodeIds(fromB.body.data.route)).toEqual([b.id, c.id]);
  });

  test('evacuation honours a penalty even when a cost preference is layered on', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const origin = await createNode(building.id, floor.id, { x: 0, y: 0, label: 'Start' });
    const near = await createNode(building.id, floor.id, { x: 100, y: 0, label: 'Near' });
    const nearExit = await createNode(building.id, floor.id, {
      x: 200,
      y: 0,
      type: 'EMERGENCY_EXIT',
      label: 'Near exit',
    });
    const far = await createNode(building.id, floor.id, { x: 0, y: 300, label: 'Far' });
    const farExit = await createNode(building.id, floor.id, {
      x: 0,
      y: 600,
      type: 'EMERGENCY_EXIT',
      label: 'Far exit',
    });
    const toNear = await connectNodes(origin, near);
    await connectNodes(near, nearExit);
    await connectNodes(origin, far);
    await connectNodes(far, farExit);
    expect(cookie).toBeTruthy();

    const evacuate = (query = '') =>
      request(app).get(`/api/wayfinding/evacuate?from=${origin.id}${query}`);

    const before = await evacuate('&profile=min_floor_changes');
    expect(before.body.data.route.destination.nodeId).toBe(nearExit.id);

    await prisma.closure.create({
      data: { buildingId: building.id, edgeIds: [toNear.id], costMultiplier: 10, reason: 'Smoke' },
    });
    clearAllClosures();

    // This is the case the `/evacuate` cost-preference branch used to miss:
    // it rebuilt the cost function from the profile alone, so the closure's
    // penalty silently stopped applying.
    const after = await evacuate('&profile=min_floor_changes');
    expect(after.status).toBe(200);
    expect(after.body.data.route.destination.nodeId).toBe(farExit.id);
    expect(after.body.data.closures).toHaveLength(1);
  });

  test('a blocked evacuation edge is never traversed', async () => {
    const { building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const origin = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const exit = await createNode(building.id, floor.id, {
      x: 100,
      y: 0,
      type: 'EMERGENCY_EXIT',
    });
    const only = await connectNodes(origin, exit);
    await prisma.closure.create({
      data: { buildingId: building.id, edgeIds: [only.id], reason: 'Sealed' },
    });

    const res = await request(app).get(`/api/wayfinding/evacuate?from=${origin.id}`);

    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------ QR scan --- */

describe('the scan route respects closures', () => {
  beforeEach(() => {
    clearAllClosures();
    clearAll();
  });

  const seedScan = async () => {
    const { building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    const origin = await createNode(building.id, floor.id, { x: 0, y: 0 });
    const exit = await createNode(building.id, floor.id, {
      x: 100,
      y: 0,
      type: 'EMERGENCY_EXIT',
    });
    const edge = await connectNodes(origin, exit);
    return { building, floor, origin, exit, edge };
  };

  test('lists the active closures alongside the legacy payload', async () => {
    const { building, origin, edge } = await seedScan();
    await prisma.closure.create({
      data: {
        buildingId: building.id,
        edgeIds: [edge.id],
        costMultiplier: 2,
        reason: 'Debris',
      },
    });

    const res = await request(app).get(`/api/qr/scan/route/${qrIdFor(origin, 1)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.closures).toEqual([
      expect.objectContaining({ reason: 'Debris', blocked: false }),
    ]);
  });

  test('never routes an occupant through a blocked edge', async () => {
    const { building, origin, edge } = await seedScan();
    await prisma.closure.create({
      data: { buildingId: building.id, edgeIds: [edge.id], reason: 'Fire' },
    });

    const res = await request(app).get(`/api/qr/scan/route/${qrIdFor(origin, 1)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.emergencyRoute.found).toBe(false);
    expect(res.body.data.closures).toHaveLength(1);
  });
});
