import request from 'supertest';
import app from '../../server.js';
import { clearAll } from '../features/wayfinding/graphCache.js';
import {
  createOwnerWithBuilding,
  createFloor,
  createNode,
  connectNodes,
  qrIdFor,
} from './helpers.js';

/**
 * CONTRACT TEST (slice 1, task B17) for the wire contract documented in
 * `alertup_front/docs/superpowers/plans/2026-09-24-slice1-routing-quality.md`
 * ("Wire contract" section).
 *
 * This is NOT a snapshot of "whatever the assembler happens to emit today" —
 * that would pass against any payload, including one that quietly dropped or
 * mistyped a field. Every spec below is hand-pinned from the pre-slice-1
 * shape, read straight off `routeAssembler.js` as it stood at commit d6e2341
 * (the last commit before "route assembler v2" started this slice's
 * additive work):
 *
 *   git show d6e2341:src/features/wayfinding/routeAssembler.js
 *
 * The rule this file enforces: the current payload must be a SUPERSET of
 * that shape — same keys, same TYPES — per segment/transition/step. Sixteen
 * tasks (B1-B16) were free to ADD fields; none of them may have removed one
 * or silently changed one's type (a number turned into a string is exactly
 * as broken, for a frontend consumer, as the field being gone). A printed QR
 * sticker cannot be reissued when its endpoint changes meaning, so the
 * legacy scan envelope and the hop-count semantics of
 * `emergencyRoute.distance` are pinned the same way.
 *
 * Scope: this file exercises ONE fixture per surface — a single-destination
 * two-floor `/api/wayfinding/route` request (plus a small multi-stop check,
 * and the scan endpoint's own top-level envelope). It does not attempt to
 * re-verify the whole wire-contract table, the `/evacuate` route, or the
 * internal shape of the legacy scan envelope's nested objects — those are
 * out of scope here. In particular, the `transitType` domain check below
 * only ever sees `STAIRS` (this fixture's only transition); the other three
 * enum values are exercised by other tests (e.g.
 * `routeAssembler.test.js`'s `ESCALATOR` fixture), not by this file.
 */

// ---- pre-slice-1 ground truth (commit d6e2341) --------------------------
//
// Each pinned field carries its expected TYPE, not just its name. Presence
// alone would miss a field silently changing shape (a number turned into a
// string, say) — a frontend consumer misparses a stringified number exactly
// as badly as a missing one. Types are written as one or more `typeOf()`
// results joined by `|` for fields whose pre-slice-1 semantics were already
// nullable (e.g. `distanceMeters` is `null` on an unscaled floor).

const PRE_SLICE_ROUTE_TYPES = {
  mode: 'string',
  origin: 'object',
  destination: 'object',
  accessible: 'boolean',
  accessibleRouteUnavailable: 'boolean',
  totalDistancePx: 'number',
  totalDistanceMeters: 'number|null',
  segments: 'array',
  transitions: 'array',
  steps: 'array',
};

const PRE_SLICE_SEGMENT_TYPES = {
  index: 'number',
  floor: 'object|null',
  nodes: 'array',
  distancePx: 'number',
  distanceMeters: 'number|null',
};

const PRE_SLICE_TRANSITION_TYPES = {
  afterSegmentIndex: 'number',
  transitType: 'string',
  fromFloorNumber: 'number',
  toFloorNumber: 'number',
  fromNodeId: 'string',
  toNodeId: 'string',
  direction: 'string',
  label: 'string|null',
};

// Pre-slice-1 steps only ever carried `kind` plus the one index relevant to
// that kind — a `walk` step never had `transitionIndex`, a `transit` step
// never had `segmentIndex`, `arrive` had neither.
const PRE_SLICE_STEP_TYPES_BY_KIND = {
  walk: { kind: 'string', segmentIndex: 'number' },
  transit: { kind: 'string', transitionIndex: 'number' },
  arrive: { kind: 'string' },
};

const ALLOWED_STEP_KINDS = ['walk', 'transit', 'arrive'];
const ALLOWED_TRANSIT_TYPES = ['WALKWAY', 'ELEVATOR', 'ESCALATOR', 'STAIRS'];

/** `typeof`, but `null` and arrays get their own bucket instead of hiding
 *  inside `'object'` — otherwise a spec of `'object'` would silently accept
 *  `null` or `[]` for a field that is supposed to always be a real object. */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Fails naming the missing key, or the key whose VALUE has drifted off its
 * pinned type — a field silently turned into a string is exactly as broken
 * as a field removed outright, and both must be caught here.
 *
 * @param {object} obj
 * @param {Record<string, string>} spec key -> `typeOf()` result, or several
 *   joined by `|` (e.g. `'number|null'`)
 * @param {string} label
 */
function expectSuperset(obj, spec, label) {
  for (const [key, expectedType] of Object.entries(spec)) {
    if (!Object.hasOwn(obj, key)) {
      throw new Error(`${label} is missing contract field "${key}"`);
    }
    const allowed = expectedType.split('|');
    const actual = typeOf(obj[key]);
    if (!allowed.includes(actual)) {
      throw new Error(
        `${label}.${key} has the wrong type: expected ${expectedType}, got ${actual} (value: ${JSON.stringify(obj[key])})`
      );
    }
  }
}

beforeEach(() => clearAll());

/**
 * Two floors joined by a STAIRS transition, scaled, with a POI destination —
 * enough surface to exercise segments (2), a transition (1), and all three
 * step kinds (walk, transit, arrive).
 */
async function seedTwoFloorBuilding() {
  const seeded = await createOwnerWithBuilding();
  const { building } = seeded;
  const f1 = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
  const f2 = await createFloor(building.id, { floorNumber: 2, scalePixelsPerMeter: 10 });
  const entrance = await createNode(building.id, f1.id, { x: 0, y: 0, type: 'ENTRANCE' });
  const stairs1 = await createNode(building.id, f1.id, { x: 100, y: 0, type: 'TRANSIT', label: 'Stairs A' });
  const stairs2 = await createNode(building.id, f2.id, { x: 100, y: 0, type: 'TRANSIT', label: 'Stairs A' });
  const shopNode = await createNode(building.id, f2.id, { x: 300, y: 0, type: 'POI' });
  await connectNodes(entrance, stairs1);
  await connectNodes(stairs1, stairs2, { transitType: 'STAIRS', weight: 400, distance: 0 });
  await connectNodes(stairs2, shopNode);
  return { ...seeded, f1, f2, entrance, stairs1, stairs2, shopNode };
}

/** Three colinear stops, for the multi-stop legs/stops assertions. */
async function seedLine() {
  const seeded = await createOwnerWithBuilding();
  const { building } = seeded;
  const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
  const entrance = await createNode(building.id, floor.id, { x: 0, y: 0, type: 'ENTRANCE' });
  const near = await createNode(building.id, floor.id, { x: 50, y: 0, type: 'POI' });
  const far = await createNode(building.id, floor.id, { x: 200, y: 0, type: 'POI' });
  await connectNodes(entrance, near);
  await connectNodes(near, far);
  return { ...seeded, entrance, near, far };
}

describe('route contract — /api/wayfinding/route (single destination)', () => {
  test('route/segment/transition/step payload is a superset of the pre-slice-1 shape', async () => {
    const { entrance, shopNode } = await seedTwoFloorBuilding();

    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=${shopNode.id}`
    );
    expect(res.status).toBe(200);
    const route = res.body.data.route;

    // Sanity: this fixture actually exercises everything the assertions
    // below need — if this drifts, the superset checks below stop meaning
    // anything.
    expect(route.segments.length).toBeGreaterThanOrEqual(2);
    expect(route.transitions.length).toBeGreaterThanOrEqual(1);
    expect(route.steps.some((s) => s.kind === 'walk')).toBe(true);
    expect(route.steps.some((s) => s.kind === 'transit')).toBe(true);
    expect(route.steps.some((s) => s.kind === 'arrive')).toBe(true);

    expectSuperset(route, PRE_SLICE_ROUTE_TYPES, 'route');

    for (const segment of route.segments) {
      expectSuperset(segment, PRE_SLICE_SEGMENT_TYPES, `segment[${segment.index}]`);
    }

    for (const transition of route.transitions) {
      expectSuperset(
        transition,
        PRE_SLICE_TRANSITION_TYPES,
        `transition[${transition.afterSegmentIndex}]`
      );
    }

    route.steps.forEach((step, i) => {
      const expectedTypes = PRE_SLICE_STEP_TYPES_BY_KIND[step.kind];
      expect(expectedTypes).toBeDefined(); // kind itself must be a known one
      expectSuperset(step, expectedTypes, `steps[${i}] (kind=${step.kind})`);
    });
  });

  test('steps[].kind never escapes walk|transit|arrive', async () => {
    const { entrance, shopNode } = await seedTwoFloorBuilding();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=${shopNode.id}`
    );
    expect(res.status).toBe(200);
    const kinds = res.body.data.route.steps.map((s) => s.kind);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(ALLOWED_STEP_KINDS).toContain(kind);
    }
  });

  test('transitType never escapes WALKWAY|ELEVATOR|ESCALATOR|STAIRS', async () => {
    const { entrance, shopNode } = await seedTwoFloorBuilding();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=${shopNode.id}`
    );
    expect(res.status).toBe(200);
    const route = res.body.data.route;
    expect(route.transitions.length).toBeGreaterThan(0);
    for (const transition of route.transitions) {
      expect(ALLOWED_TRANSIT_TYPES).toContain(transition.transitType);
    }
  });

  test('a single-destination route has no legs, stops, or stopIndex — asserted per key, not combined', async () => {
    const { entrance, shopNode } = await seedTwoFloorBuilding();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=${shopNode.id}`
    );
    expect(res.status).toBe(200);
    const route = res.body.data.route;

    // Each key checked on its own: `arrayContaining`/`or`-style checks pass
    // the moment EITHER key is absent, which would hide a regression that
    // reintroduces only one of the two.
    expect(Object.hasOwn(route, 'legs')).toBe(false);
    expect(Object.hasOwn(route, 'stops')).toBe(false);
    for (const instruction of route.instructions) {
      expect(Object.hasOwn(instruction, 'stopIndex')).toBe(false);
    }
  });
});

describe('route contract — /api/wayfinding/route (multi-stop)', () => {
  test('a multi-destination route adds legs and stops', async () => {
    const { entrance, near, far } = await seedLine();
    const res = await request(app).get(
      `/api/wayfinding/route?from=${entrance.id}&to=${near.id}&to=${far.id}`
    );
    expect(res.status).toBe(200);
    const route = res.body.data.route;

    expect(Object.hasOwn(route, 'legs')).toBe(true);
    expect(Object.hasOwn(route, 'stops')).toBe(true);
    expect(route.legs).toHaveLength(2);
    expect(route.stops).toHaveLength(2);
  });
});

describe('route contract — GET /api/qr/scan/route/:qrId', () => {
  test('emergencyRoute.distance stays a hop count, never metres', async () => {
    const { building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 10 });
    // A long single hop (500 px = 50 m at scale 10) followed by two short
    // hops (10 px each): if `distance` were ever metres/px instead of hop
    // count, this fixture's numbers would not collide by accident.
    const start = await createNode(building.id, floor.id, { x: 0, y: 0, type: 'NORMAL', label: 'Start' });
    const mid1 = await createNode(building.id, floor.id, { x: 500, y: 0, type: 'NORMAL' });
    const mid2 = await createNode(building.id, floor.id, { x: 510, y: 0, type: 'NORMAL' });
    const exit = await createNode(building.id, floor.id, { x: 520, y: 0, type: 'EMERGENCY_EXIT' });
    await connectNodes(start, mid1);
    await connectNodes(mid1, mid2);
    await connectNodes(mid2, exit);

    const qrId = qrIdFor(start, floor.floorNumber);
    const res = await request(app).get(`/api/qr/scan/route/${qrId}`);
    expect(res.status).toBe(200);

    const data = res.body.data;
    // 3 hops (start->mid1->mid2->exit), 52 m walked.
    expect(data.emergencyRoute.distance).toBe(3);
    expect(data.emergencyRoute.distance).not.toBe(data.route.totalDistanceM);
    expect(data.route.totalDistanceM).toBeGreaterThan(3);
  });

  test('legacy scan envelope keys all survive alongside the new route fields', async () => {
    const { building } = await createOwnerWithBuilding();
    const floor = await createFloor(building.id, { floorNumber: 1 });
    const start = await createNode(building.id, floor.id, { x: 0, y: 0, type: 'NORMAL' });
    const exit = await createNode(building.id, floor.id, { x: 100, y: 0, type: 'EMERGENCY_EXIT' });
    await connectNodes(start, exit);

    const qrId = qrIdFor(start, floor.floorNumber);
    const res = await request(app).get(`/api/qr/scan/route/${qrId}`);
    expect(res.status).toBe(200);
    const data = res.body.data;

    for (const key of ['emergencyRoute', 'floorMap', 'allFloorNodes', 'routeNodes', 'floorTransitions']) {
      expect(Object.hasOwn(data, key)).toBe(true);
    }
  });
});
