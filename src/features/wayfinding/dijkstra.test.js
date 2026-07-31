import {
  shortestPath,
  findEvacuationRoute,
  findRoute,
  calculateDistance,
  DEFAULT_TRANSIT_COST,
} from './dijkstra.js';
import MinHeap from './minHeap.js';

// ---- graph builder -------------------------------------------------------
// spec: { nodes: [{id, x, y, type, floorNumber}], edges: [[a, b, opts?]] }
// Floors get synthetic ids `floor-<n>`; edges are expanded symmetrically the
// way graphService does against the Edge table.

function buildGraph({ nodes, edges }) {
  const nodeMap = new Map();
  const floors = new Map();
  for (const n of nodes) {
    const floorNumber = n.floorNumber ?? 1;
    const floorId = `floor-${floorNumber}`;
    if (!floors.has(floorId)) {
      floors.set(floorId, {
        id: floorId,
        floorNumber,
        name: `Floor ${floorNumber}`,
        scalePixelsPerMeter: n.scale ?? null,
      });
    }
    nodeMap.set(n.id, {
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      type: n.type ?? 'NORMAL',
      label: n.label ?? null,
      floorId,
      floorNumber,
    });
  }

  const adj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  for (const [a, b, opts = {}] of edges) {
    const na = nodeMap.get(a);
    const nb = nodeMap.get(b);
    const crossFloor = na.floorNumber !== nb.floorNumber;
    const transitType = opts.transitType ?? (crossFloor ? 'STAIRS' : 'WALKWAY');
    const cost =
      opts.weight ??
      (crossFloor
        ? DEFAULT_TRANSIT_COST[transitType]
        : calculateDistance(na.x, na.y, nb.x, nb.y));
    const accessible =
      opts.accessible ?? (!crossFloor || transitType === 'ELEVATOR');
    adj.get(a).push({ to: b, cost, transitType, accessible });
    adj.get(b).push({ to: a, cost, transitType, accessible });
  }

  return { nodes: nodeMap, adj, floors };
}

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
