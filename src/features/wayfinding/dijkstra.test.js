import {
  shortestPath,
  findEvacuationRoute,
  findRoute,
  DEFAULT_TRANSIT_COST,
} from './dijkstra.js';
import MinHeap from './minHeap.js';
import { resolveProfile } from './costModel.js';
import { buildGraph } from '../../tests/graphFixtures.js';

describe('MinHeap', () => {
  test('pops in priority order', () => {
    const heap = new MinHeap();
    [5, 1, 4, 2, 3].forEach((p) => heap.push(p, `v${p}`));
    const out = [];
    while (heap.size) out.push(heap.pop().priority);
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });

  test('handles duplicates and empty pops', () => {
    const heap = new MinHeap();
    expect(heap.pop()).toBeUndefined();
    heap.push(1, 'a');
    heap.push(1, 'b');
    expect(heap.pop().priority).toBe(1);
    expect(heap.pop().priority).toBe(1);
    expect(heap.pop()).toBeUndefined();
  });
});

describe('shortestPath — ported routingService scenarios', () => {
  test('simple corridor start -> exit', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
        { id: 'exit', x: 200, y: 0, type: 'EMERGENCY_EXIT' },
      ],
      edges: [
        ['a', 'b'],
        ['b', 'exit'],
      ],
    });
    const result = shortestPath(graph, 'a', {
      targetPredicate: (n) => n.type === 'EMERGENCY_EXIT',
    });
    expect(result.path).toEqual(['a', 'b', 'exit']);
    expect(result.cost).toBe(200);
  });

  test('prefers physically shorter route over fewer hops', () => {
    // Direct edge is 1000 long; the 3-hop detour totals 300.
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'far', x: 1000, y: 0, type: 'EMERGENCY_EXIT' },
        { id: 'm1', x: 100, y: 0 },
        { id: 'm2', x: 200, y: 0 },
      ],
      edges: [
        ['start', 'far', { weight: 1000 }],
        ['start', 'm1'],
        ['m1', 'm2'],
        ['m2', 'far', { weight: 100 }],
      ],
    });
    const result = shortestPath(graph, 'start', {
      targetPredicate: (n) => n.type === 'EMERGENCY_EXIT',
    });
    expect(result.path).toEqual(['start', 'm1', 'm2', 'far']);
    expect(result.cost).toBe(300);
  });

  test('already standing on an exit returns a single-node path', () => {
    const graph = buildGraph({
      nodes: [{ id: 'exit', type: 'EMERGENCY_EXIT' }],
      edges: [],
    });
    const result = shortestPath(graph, 'exit', {
      targetPredicate: (n) => n.type === 'EMERGENCY_EXIT',
    });
    expect(result).toEqual({ path: ['exit'], cost: 0 });
  });

  test('no reachable exit returns null', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 10, y: 0 },
        { id: 'island-exit', x: 500, y: 500, type: 'EMERGENCY_EXIT' },
      ],
      edges: [['a', 'b']],
    });
    expect(
      shortestPath(graph, 'a', {
        targetPredicate: (n) => n.type === 'EMERGENCY_EXIT',
      })
    ).toBeNull();
  });

  test('unknown start returns null', () => {
    const graph = buildGraph({ nodes: [{ id: 'a' }], edges: [] });
    expect(shortestPath(graph, 'ghost', { targetId: 'a' })).toBeNull();
  });

  test('floor-change penalty keeps route on current floor when possible', () => {
    // Same-floor exit is 350 away; upstairs exit is 10 + STAIRS(400) away.
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0, floorNumber: 1 },
        { id: 'exit1', x: 350, y: 0, floorNumber: 1, type: 'EMERGENCY_EXIT' },
        { id: 'stairs1', x: 10, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 'exit2', x: 10, y: 0, floorNumber: 2, type: 'EMERGENCY_EXIT' },
      ],
      edges: [
        ['start', 'exit1'],
        ['start', 'stairs1'],
        ['stairs1', 'exit2'],
      ],
    });
    const result = shortestPath(graph, 'start', {
      targetPredicate: (n) => n.type === 'EMERGENCY_EXIT',
    });
    expect(result.path).toEqual(['start', 'exit1']);
  });

  test('routes across floors when target is upstairs (Mode A)', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0, floorNumber: 1 },
        { id: 'esc1', x: 50, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 'esc2', x: 50, y: 0, floorNumber: 2, type: 'TRANSIT' },
        { id: 'shop', x: 150, y: 0, floorNumber: 2, type: 'POI' },
      ],
      edges: [
        ['start', 'esc1'],
        ['esc1', 'esc2', { transitType: 'ESCALATOR' }],
        ['esc2', 'shop'],
      ],
    });
    const result = shortestPath(graph, 'start', { targetId: 'shop' });
    expect(result.path).toEqual(['start', 'esc1', 'esc2', 'shop']);
    expect(result.cost).toBe(50 + DEFAULT_TRANSIT_COST.ESCALATOR + 100);
  });

  test('elevator is preferred over stairs by default costs', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0, floorNumber: 1 },
        { id: 'stairsA', x: 10, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 'stairsB', x: 10, y: 0, floorNumber: 2, type: 'TRANSIT' },
        { id: 'liftA', x: 10, y: 5, floorNumber: 1, type: 'TRANSIT' },
        { id: 'liftB', x: 10, y: 5, floorNumber: 2, type: 'TRANSIT' },
        { id: 'goal', x: 20, y: 0, floorNumber: 2, type: 'POI' },
      ],
      edges: [
        ['start', 'stairsA'],
        ['stairsA', 'stairsB', { transitType: 'STAIRS' }],
        ['stairsB', 'goal'],
        ['start', 'liftA'],
        ['liftA', 'liftB', { transitType: 'ELEVATOR' }],
        ['liftB', 'goal'],
      ],
    });
    const result = shortestPath(graph, 'start', { targetId: 'goal' });
    expect(result.path).toContain('liftA');
    expect(result.path).toContain('liftB');
  });

  test('dangling adjacency entries are skipped', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'exit', x: 100, y: 0, type: 'EMERGENCY_EXIT' },
      ],
      edges: [['a', 'exit']],
    });
    graph.adj.get('a').push({ to: 'deleted-node', cost: 1, transitType: 'WALKWAY', accessible: true });
    const result = shortestPath(graph, 'a', {
      targetPredicate: (n) => n.type === 'EMERGENCY_EXIT',
    });
    expect(result.path).toEqual(['a', 'exit']);
  });
});

describe('accessibility filtering', () => {
  const accessGraph = () =>
    buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0, floorNumber: 1 },
        { id: 'stairsA', x: 10, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 'stairsB', x: 10, y: 0, floorNumber: 2, type: 'TRANSIT' },
        { id: 'liftA', x: 400, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 'liftB', x: 400, y: 0, floorNumber: 2, type: 'TRANSIT' },
        { id: 'exit', x: 10, y: 10, floorNumber: 2, type: 'EMERGENCY_EXIT' },
      ],
      edges: [
        ['start', 'stairsA'],
        ['stairsA', 'stairsB', { transitType: 'STAIRS', accessible: false }],
        ['stairsB', 'exit'],
        ['start', 'liftA'],
        ['liftA', 'liftB', { transitType: 'ELEVATOR', accessible: true }],
        ['liftB', 'exit', { weight: 400 }],
      ],
    });

  test('accessible route avoids non-accessible edges', () => {
    const result = findEvacuationRoute(accessGraph(), 'start', { accessible: true });
    expect(result.path).toContain('liftA');
    expect(result.accessibleRouteUnavailable).toBe(false);
  });

  test('falls back to any route when no accessible route exists, with flag', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0, floorNumber: 1 },
        { id: 'stairsA', x: 10, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 'exit', x: 10, y: 0, floorNumber: 2, type: 'EMERGENCY_EXIT' },
      ],
      edges: [
        ['start', 'stairsA'],
        ['stairsA', 'exit', { transitType: 'STAIRS', accessible: false }],
      ],
    });
    const result = findEvacuationRoute(graph, 'start', { accessible: true });
    expect(result).not.toBeNull();
    expect(result.accessibleRouteUnavailable).toBe(true);
    expect(result.path).toEqual(['start', 'stairsA', 'exit']);
  });

  test('findRoute point-to-point honors accessibility', () => {
    const result = findRoute(accessGraph(), 'start', 'exit', { accessible: true });
    expect(result.path).toContain('liftB');
  });
});

describe('costFn, exclusions and one-way edges', () => {
  const twoRoutes = () =>
    buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'direct', x: 10, y: 0 },
        { id: 'detour', x: 500, y: 0 },
        { id: 'goal', x: 20, y: 0, type: 'POI' },
      ],
      edges: [
        ['start', 'direct', { edgeId: 'e-direct-in', weight: 10 }],
        ['direct', 'goal', { edgeId: 'e-direct-out', weight: 10 }],
        ['start', 'detour', { edgeId: 'e-detour-in', weight: 500 }],
        ['detour', 'goal', { edgeId: 'e-detour-out', weight: 500 }],
      ],
    });

  test('costFn replaces pixel costs and an Infinity result prunes the edge', () => {
    const graph = twoRoutes();

    // No options: still the legacy pixel weights.
    expect(shortestPath(graph, 'start', { targetId: 'goal' }).cost).toBe(20);

    // Flat cost per edge: the two-hop path is still cheapest, but priced in hops.
    expect(
      shortestPath(graph, 'start', { targetId: 'goal', costFn: () => 1 }).cost
    ).toBe(2);

    // costFn sees the edge plus both endpoint nodes.
    const seen = [];
    shortestPath(graph, 'start', {
      targetId: 'goal',
      costFn: (edge, from, to) => {
        seen.push([edge.edgeId, from.id, to.id]);
        return edge.cost;
      },
    });
    expect(seen).toContainEqual(['e-direct-in', 'start', 'direct']);

    // Infinity on the cheap edge forces the long way round.
    const pruned = shortestPath(graph, 'start', {
      targetId: 'goal',
      costFn: (edge) => (edge.edgeId === 'e-direct-in' ? Infinity : edge.cost),
    });
    expect(pruned.path).toEqual(['start', 'detour', 'goal']);
    expect(pruned.cost).toBe(1000);

    // NaN prunes too, so a bad cost can never poison the heap.
    expect(
      shortestPath(graph, 'start', { targetId: 'goal', costFn: () => NaN })
    ).toBeNull();
  });

  test('excludeNodeIds are never expanded nor targeted, but the start is exempt', () => {
    const graph = twoRoutes();

    const around = shortestPath(graph, 'start', {
      targetId: 'goal',
      excludeNodeIds: new Set(['direct']),
    });
    expect(around.path).toEqual(['start', 'detour', 'goal']);

    // An array works as well as a Set.
    expect(
      shortestPath(graph, 'start', { targetId: 'goal', excludeNodeIds: ['direct'] }).path
    ).toEqual(['start', 'detour', 'goal']);

    // Excluding the target makes it unreachable.
    expect(
      shortestPath(graph, 'start', { targetId: 'goal', excludeNodeIds: ['goal'] })
    ).toBeNull();

    // Excluding a node that is the start does not strand the traveller.
    expect(
      shortestPath(graph, 'start', { targetId: 'goal', excludeNodeIds: ['start'] }).path
    ).toEqual(['start', 'direct', 'goal']);
  });

  test('a FORWARD edge is traversable source -> target only', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      edges: [['a', 'b', { edgeId: 'one-way', direction: 'FORWARD' }]],
    });

    expect(shortestPath(graph, 'a', { targetId: 'b' }).path).toEqual(['a', 'b']);
    expect(shortestPath(graph, 'b', { targetId: 'a' })).toBeNull();

    expect(graph.adj.get('a').map((e) => e.to)).toEqual(['b']);
    expect(graph.adj.get('b')).toEqual([]);
    // The reverse index still knows how b was reached.
    expect(graph.radj.get('b').map((e) => e.to)).toEqual(['a']);
    expect(graph.adj.get('a')[0].forward).toBe(true);
  });
});

describe('profile-driven routing', () => {
  test('findRoute with a profile prices the route in seconds', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0, scale: 10 },
        { id: 'goal', x: 140, y: 0, type: 'POI' },
      ],
      edges: [['start', 'goal']],
    });

    // 140 px / 10 px per m = 14 m; 14 m / 1.4 m/s = 10 s.
    const result = findRoute(graph, 'start', 'goal', {
      profile: resolveProfile(null, 'walk'),
    });
    expect(result.cost).toBeCloseTo(10, 6);
    expect(result.accessibleRouteUnavailable).toBe(false);

    // An explicit costFn wins over the profile.
    expect(
      findRoute(graph, 'start', 'goal', {
        profile: resolveProfile(null, 'walk'),
        costFn: () => 7,
      }).cost
    ).toBe(7);
  });

  test('findRoute applies a caller edgeFilter alongside accessibility', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'service', x: 10, y: 0 },
        { id: 'public', x: 200, y: 100 },
        { id: 'goal', x: 400, y: 0, type: 'POI' },
      ],
      edges: [
        ['start', 'service', { tags: ['staff'] }],
        ['service', 'goal', { tags: ['staff'] }],
        ['start', 'public'],
        ['public', 'goal'],
      ],
    });

    const result = findRoute(graph, 'start', 'goal', {
      edgeFilter: (edge) => !edge.tags.includes('staff'),
    });
    expect(result.path).toEqual(['start', 'public', 'goal']);
  });

  test('evacuation reports the exit it chose and can skip excluded exits', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'near', x: 100, y: 0, type: 'EMERGENCY_EXIT' },
        { id: 'far', x: 400, y: 0, type: 'EMERGENCY_EXIT' },
      ],
      edges: [
        ['start', 'near'],
        ['near', 'far'],
      ],
    });

    const first = findEvacuationRoute(graph, 'start');
    expect(first.exitNodeId).toBe('near');
    expect(first.accessibleRouteUnavailable).toBe(false);

    const alternative = findEvacuationRoute(graph, 'start', {
      excludeExitIds: ['near'],
    });
    expect(alternative.exitNodeId).toBe('far');
    expect(alternative.path).toEqual(['start', 'near', 'far']);

    expect(
      findEvacuationRoute(graph, 'start', { excludeExitIds: ['near', 'far'] })
    ).toBeNull();
  });

  test('the emergency profile routes evacuees away from lifts', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0, floorNumber: 2 },
        { id: 'liftA', x: 10, y: 0, floorNumber: 2, type: 'TRANSIT' },
        { id: 'liftB', x: 10, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 'stairA', x: 3000, y: 0, floorNumber: 2, type: 'TRANSIT' },
        { id: 'stairB', x: 3000, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 'exit', x: 20, y: 0, floorNumber: 1, type: 'EMERGENCY_EXIT' },
      ],
      edges: [
        ['start', 'liftA'],
        ['liftA', 'liftB', { transitType: 'ELEVATOR' }],
        ['liftB', 'exit'],
        ['start', 'stairA'],
        ['stairA', 'stairB', { transitType: 'STAIRS' }],
        ['stairB', 'exit'],
      ],
    });

    const emergency = resolveProfile(null, 'emergency');
    const result = findEvacuationRoute(graph, 'start', { profile: emergency });
    expect(result.path).toEqual(['start', 'stairA', 'stairB', 'exit']);

    const rated = resolveProfile({ elevatorEvacuationRated: true }, 'emergency');
    expect(
      findEvacuationRoute(graph, 'start', { profile: rated }).path
    ).toContain('liftB');
  });
});
