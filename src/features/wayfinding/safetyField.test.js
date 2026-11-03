import { computeSafetyField, getSafetyField, pathFromField } from './safetyField.js';
import { shortestPath } from './dijkstra.js';
import { buildRoutingContext } from './profiles.js';
import { buildGraph } from '../../tests/graphFixtures.js';

/**
 * A deliberately DIRECTED fixture: `mid → west` is one-way, so a field built
 * on `adj` instead of `radj` (or one that forgets to re-orient the edge for
 * the filter/cost) gets a different answer than the forward search does.
 *
 *   start ──100── mid ──(FORWARD)──► west-exit            (floor 1)
 *     │            │
 *    150          stairs ── up ── north-exit              (floor 2)
 *     │
 *   south ──400── south-exit
 */
const directedFixture = () =>
  buildGraph({
    nodes: [
      { id: 'start', x: 0, y: 0, floorNumber: 1, scale: 10 },
      { id: 'mid', x: 100, y: 0, floorNumber: 1 },
      { id: 'west-exit', x: 160, y: 0, floorNumber: 1, type: 'EMERGENCY_EXIT', label: 'West exit' },
      { id: 'south', x: 0, y: 150, floorNumber: 1 },
      { id: 'south-exit', x: 0, y: 550, floorNumber: 1, type: 'EMERGENCY_EXIT', label: 'South exit' },
      { id: 'stairs1', x: 100, y: 40, floorNumber: 1, type: 'TRANSIT' },
      { id: 'stairs2', x: 100, y: 40, floorNumber: 2, type: 'TRANSIT' },
      { id: 'north-exit', x: 140, y: 40, floorNumber: 2, type: 'EMERGENCY_EXIT', label: 'North exit' },
    ],
    edges: [
      ['start', 'mid'],
      // Directed: only start→…→mid→west-exit is walkable, never back.
      ['mid', 'west-exit', { direction: 'FORWARD' }],
      ['start', 'south'],
      ['south', 'south-exit'],
      ['mid', 'stairs1'],
      ['stairs1', 'stairs2', { transitType: 'STAIRS' }],
      ['stairs2', 'north-exit'],
    ],
  });

const isExit = (node) => node.type === 'EMERGENCY_EXIT';

describe('computeSafetyField', () => {
  test('distTo equals the forward shortestPath cost for every node', () => {
    const graph = directedFixture();
    const ctx = buildRoutingContext(graph, { name: 'emergency' });
    const field = computeSafetyField(graph, {
      costFn: ctx.costFn,
      edgeFilter: ctx.edgeFilter,
    });

    for (const id of graph.nodes.keys()) {
      const forward = shortestPath(graph, id, {
        targetPredicate: isExit,
        costFn: ctx.costFn,
        edgeFilter: ctx.edgeFilter,
      });
      if (forward) {
        expect(field.distTo.get(id)).toBeCloseTo(forward.cost, 6);
      } else {
        expect(field.distTo.has(id)).toBe(false);
      }
    }
  });

  test('every EMERGENCY_EXIT seeds the field at cost 0 and is its own exit', () => {
    const graph = directedFixture();
    const ctx = buildRoutingContext(graph, { name: 'emergency' });
    const field = computeSafetyField(graph, {
      costFn: ctx.costFn,
      edgeFilter: ctx.edgeFilter,
    });

    for (const [id, node] of graph.nodes) {
      if (!isExit(node)) continue;
      expect(field.distTo.get(id)).toBe(0);
      expect(field.exitFor.get(id)).toBe(id);
      expect(field.nextHop.has(id)).toBe(false);
    }
  });

  test('a node with no route to any exit is absent from the field', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'island-a', x: 0, y: 0 },
        { id: 'island-b', x: 10, y: 0 },
        { id: 'exit', x: 900, y: 900, type: 'EMERGENCY_EXIT' },
      ],
      edges: [['island-a', 'island-b']],
    });
    const field = computeSafetyField(graph, {});
    expect(field.distTo.has('island-a')).toBe(false);
    expect(field.distTo.has('island-b')).toBe(false);
    expect(field.distTo.get('exit')).toBe(0);
  });

  test('edgeFilter is applied in the FORWARD orientation, not the reverse one', () => {
    // `mid → west-exit` is one-way. A filter that rejects the edge whose
    // forward `to` is the exit must make the exit unreachable; a field that
    // hands the filter the reversed entry would see `to === 'mid'` instead
    // and let the route through.
    const graph = directedFixture();
    const field = computeSafetyField(graph, {
      edgeFilter: (edge) => edge.to !== 'west-exit',
    });
    expect(field.exitFor.get('mid')).not.toBe('west-exit');
  });
});

describe('pathFromField', () => {
  test('reproduces the Dijkstra path node for node', () => {
    const graph = directedFixture();
    const ctx = buildRoutingContext(graph, { name: 'emergency' });
    const field = computeSafetyField(graph, {
      costFn: ctx.costFn,
      edgeFilter: ctx.edgeFilter,
    });

    for (const id of graph.nodes.keys()) {
      const forward = shortestPath(graph, id, {
        targetPredicate: isExit,
        costFn: ctx.costFn,
        edgeFilter: ctx.edgeFilter,
      });
      const followed = pathFromField(field, id);
      if (!forward) {
        expect(followed).toBeNull();
        continue;
      }
      expect(followed.path).toEqual(forward.path);
      expect(followed.cost).toBeCloseTo(forward.cost, 6);
      expect(followed.exitNodeId).toBe(forward.path[forward.path.length - 1]);
    }
  });

  test('a node standing on an exit walks nowhere', () => {
    const graph = directedFixture();
    const field = computeSafetyField(graph, {});
    expect(pathFromField(field, 'south-exit')).toEqual({
      path: ['south-exit'],
      cost: 0,
      exitNodeId: 'south-exit',
    });
  });

  test('an unreachable start returns null', () => {
    const graph = directedFixture();
    const field = computeSafetyField(graph, {});
    expect(pathFromField(field, 'not-a-node')).toBeNull();
  });
});

describe('getSafetyField caching', () => {
  const ctxFor = (graph, name = 'emergency') => {
    const built = buildRoutingContext(graph, { name });
    return { name, costFn: built.costFn, edgeFilter: built.edgeFilter };
  };

  test('the same graph object and key returns the identical field', () => {
    const graph = directedFixture();
    const ctx = ctxFor(graph);
    const first = getSafetyField(graph, ctx, { fingerprint: '' });
    const second = getSafetyField(graph, ctx, { fingerprint: '' });
    expect(second).toBe(first);
  });

  test('a different closure fingerprint builds a different field', () => {
    const graph = directedFixture();
    const ctx = ctxFor(graph);
    const clean = getSafetyField(graph, ctx, { fingerprint: '' });
    const closed = getSafetyField(graph, ctx, { fingerprint: 'e:some-edge' });
    expect(closed).not.toBe(clean);
    // …and the clean one is still cached, not evicted by the second key.
    expect(getSafetyField(graph, ctx, { fingerprint: '' })).toBe(clean);
  });

  test('a different profile name builds a different field', () => {
    const graph = directedFixture();
    const emergency = getSafetyField(graph, ctxFor(graph, 'emergency'), { fingerprint: '' });
    const walk = getSafetyField(graph, ctxFor(graph, 'walk'), { fingerprint: '' });
    expect(walk).not.toBe(emergency);
  });

  test('a reloaded graph object does not inherit the previous graph\'s field', () => {
    const graph = directedFixture();
    const ctx = ctxFor(graph);
    const before = getSafetyField(graph, ctx, { fingerprint: '' });

    // What `graphCache.getGraph` hands back after the TTL expires: a brand
    // new object built from the same building. The WeakMap is keyed by the
    // object, so the old field goes with the old graph.
    const reloaded = directedFixture();
    const after = getSafetyField(reloaded, ctxFor(reloaded), { fingerprint: '' });
    expect(after).not.toBe(before);
    expect(getSafetyField(graph, ctx, { fingerprint: '' })).toBe(before);
  });

  test('caps at 8 keys per graph, evicting the oldest', () => {
    const graph = directedFixture();
    const ctx = ctxFor(graph);
    const oldest = getSafetyField(graph, ctx, { fingerprint: 'k0' });
    for (let i = 1; i <= 8; i++) getSafetyField(graph, ctx, { fingerprint: `k${i}` });

    // k0 was pushed out by k8; asking again rebuilds it.
    expect(getSafetyField(graph, ctx, { fingerprint: 'k0' })).not.toBe(oldest);
    // …while the most recent key is still the cached instance.
    const newest = getSafetyField(graph, ctx, { fingerprint: 'k8' });
    expect(getSafetyField(graph, ctx, { fingerprint: 'k8' })).toBe(newest);
  });

  test('refuses a context with no variant name rather than filing it under one', () => {
    // A field built with whatever cost function came in, cached under a name
    // claiming a profile it was not built with, is the worst kind of cache
    // bug: every later request for that name silently gets the wrong field.
    const graph = directedFixture();
    expect(() => getSafetyField(graph, {}, { fingerprint: '' })).toThrow(/name/i);
    expect(() => getSafetyField(graph, null, { fingerprint: '' })).toThrow(/name/i);
    expect(() => getSafetyField(graph, { name: '' }, { fingerprint: '' })).toThrow(/name/i);
  });

  test('never mutates the shared graph object, at any depth', () => {
    // `graphCache` hands the SAME object to every concurrent request, so a
    // write anywhere inside it — a node, an adjacency entry, an edge row — is
    // a cross-request bug. Top-level keys alone would not notice any of those.
    const deepSnapshot = (g) =>
      JSON.stringify({
        keys: Object.keys(g).sort(),
        nodes: [...g.nodes],
        adj: [...g.adj],
        radj: [...g.radj],
        floors: [...g.floors],
        edgesById: [...g.edgesById],
        routingProfile: g.routingProfile,
        unscaledFloorIds: [...g.unscaledFloorIds],
      });

    const graph = directedFixture();
    const before = deepSnapshot(graph);
    getSafetyField(graph, ctxFor(graph), { fingerprint: '' });
    // A second variant, so the eviction path runs against the same object too.
    getSafetyField(graph, ctxFor(graph, 'walk'), { fingerprint: 'e:x' });
    expect(deepSnapshot(graph)).toBe(before);
  });
});
