import {
  orderStops,
  planMultiStop,
  planMultiStopWithFallbacks,
  estimateLegCost,
} from './multiStop.js';
import { buildGraph, ASSUMED_PIXELS_PER_METER } from '../../tests/graphFixtures.js';
import { findRoute } from './dijkstra.js';

describe('orderStops', () => {
  test('2-opt fixes a crossed nearest-neighbor order', () => {
    // A fixed start plus three stops laid out so that greedy
    // nearest-neighbor construction visits them in an order 2-opt can
    // provably shorten (verified against a brute-force optimum offline):
    //   NN:    0 -> 1 -> 2 -> 3   (cost ~18.60)
    //   2-opt: 0 -> 3 -> 1 -> 2   (cost ~16.95, the true optimum)
    // Index 0 is the visitor's fixed position; 1-3 are the stops.
    const points = [
      [14, 13], // 0: start
      [10, 8], // 1
      [10, 6], // 2
      [8, 16], // 3
    ];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const costMatrix = points.map((a) => points.map((b) => dist(a, b)));

    const nnOnlyCost =
      costMatrix[0][1] + costMatrix[1][2] + costMatrix[2][3]; // the raw NN order's cost

    const order = orderStops(costMatrix, { fixedStart: 0 });

    expect(order[0]).toBe(0);
    expect(order).toEqual([0, 3, 1, 2]);

    const orderedCost =
      costMatrix[order[0]][order[1]] +
      costMatrix[order[1]][order[2]] +
      costMatrix[order[2]][order[3]];
    expect(orderedCost).toBeLessThan(nnOnlyCost);
    expect(orderedCost).toBeCloseTo(16.954, 2);
  });

  test('keeps the fixed start first and returns every index exactly once', () => {
    const costMatrix = [
      [0, 5, 5, 5],
      [5, 0, 1, 9],
      [5, 1, 0, 1],
      [5, 9, 1, 0],
    ];
    const order = orderStops(costMatrix, { fixedStart: 0 });
    expect(order[0]).toBe(0);
    expect([...order].sort()).toEqual([0, 1, 2, 3]);
  });

  test('handles a single stop (no ordering decision to make)', () => {
    const costMatrix = [
      [0, 4],
      [4, 0],
    ];
    expect(orderStops(costMatrix, { fixedStart: 0 })).toEqual([0, 1]);
  });

  test('handles zero stops', () => {
    expect(orderStops([[0]], { fixedStart: 0 })).toEqual([0]);
  });
});

describe('planMultiStop', () => {
  /** Four points on a line: start at 0, stops at 100/200/300. */
  function lineGraph() {
    return buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'far', x: 300, y: 0 },
        { id: 'near', x: 100, y: 0 },
        { id: 'mid', x: 200, y: 0 },
      ],
      edges: [
        ['start', 'near'],
        ['near', 'mid'],
        ['mid', 'far'],
      ],
    });
  }

  test('bounds the search at one shortestPath run per stop, in the optimized order', () => {
    const graph = lineGraph();
    // Requested scrambled (far, near, mid); the sensible walk sweeps the
    // line in physical order (near, mid, far), not the request order.
    const result = planMultiStop(graph, 'start', ['far', 'near', 'mid'], {
      costFn: null,
      edgeFilter: null,
    });
    expect(result.ok).toBe(true);
    // 3 stops -> at most 3 shortestPath legs, never one per PAIR (which would
    // be 6 for 3 stops).
    expect(result.legs).toHaveLength(3);
    expect(result.legs.map((leg) => leg.toId)).toEqual(['near', 'mid', 'far']);
    expect(result.path[0]).toBe('start');
    expect(result.path.at(-1)).toBe('far');
  });

  test('reports which leg failed when a stop is unreachable, without abandoning the rest of the plan', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'reachable', x: 10, y: 0 },
        { id: 'island', x: 500, y: 0 }, // no edges at all: unreachable
      ],
      edges: [['start', 'reachable']],
    });
    const result = planMultiStop(graph, 'start', ['reachable', 'island'], {
      costFn: null,
      edgeFilter: null,
    });
    expect(result.ok).toBe(false);
    expect(result.failedNodeId).toBe('island');
  });

  test('uses the supplied costFn/edgeFilter for every leg, never a hand-rolled one', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      edges: [['start', 'b']],
    });
    // A filter that blocks the only edge outright: if planMultiStop ignored
    // it and searched with the default cost/filter instead, this leg would
    // still succeed.
    const blockEverything = () => false;

    const withFilter = planMultiStop(graph, 'start', ['b'], {
      costFn: null,
      edgeFilter: blockEverything,
    });
    expect(withFilter.ok).toBe(false);
    expect(withFilter.failedNodeId).toBe('b');

    const withoutFilter = planMultiStop(graph, 'start', ['b'], {
      costFn: null,
      edgeFilter: null,
    });
    expect(withoutFilter.ok).toBe(true);
  });

  test('single target still returns a one-leg plan (parity with point-to-point search)', () => {
    const graph = lineGraph();
    const viaMultiStop = planMultiStop(graph, 'start', ['mid'], { costFn: null, edgeFilter: null });
    const direct = findRoute(graph, 'start', 'mid', { costFn: null, edgeFilter: null });

    expect(viaMultiStop.ok).toBe(true);
    expect(viaMultiStop.path).toEqual(direct.path);
  });

  test('a duplicate destination (a round trip) is walked in REQUEST order, never optimized adjacent', () => {
    const graph = lineGraph();
    // Ask to visit far, then near, then far again — a genuine round trip
    // back through `far`. The geometric proxy sees two zero-distance copies
    // of `far` and would place them adjacent if it ran at all, silently
    // turning "go there, do something else, then go back" into "go there
    // twice in a row". A duplicate anywhere in the request disables
    // optimization entirely, so this must come back exactly as asked.
    const result = planMultiStop(graph, 'start', ['far', 'near', 'far'], {
      costFn: null,
      edgeFilter: null,
    });
    expect(result.ok).toBe(true);
    expect(result.legs.map((leg) => leg.toId)).toEqual(['far', 'near', 'far']);
  });
});

describe('estimateLegCost', () => {
  test('scales the floor-change penalty by each floor\'s own pixels-per-metre, not a fixed pixel constant', () => {
    const denseGraph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: 100 }, // 100 px/m
        { id: 'b', x: 0, y: 0, floorNumber: 2, scale: 100 },
      ],
      edges: [],
    });
    const sparseGraph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: 10 }, // 10 px/m
        { id: 'b', x: 0, y: 0, floorNumber: 2, scale: 10 },
      ],
      edges: [],
    });

    const denseCost = estimateLegCost(denseGraph.nodes.get('a'), denseGraph.nodes.get('b'), denseGraph);
    const sparseCost = estimateLegCost(sparseGraph.nodes.get('a'), sparseGraph.nodes.get('b'), sparseGraph);

    // Same physical floor change (one level), 10x the pixel density -> 10x
    // the pixel-space penalty: the penalty is worth the same PHYSICAL
    // distance regardless of how densely a given floor plan happens to be
    // drawn, which a fixed pixel constant could never guarantee.
    expect(denseCost).toBeCloseTo(sparseCost * 10, 5);
  });

  test('falls back to the assumed scale for an uncalibrated floor, same as the rest of routing', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1 }, // no `scale` -> uncalibrated
        { id: 'b', x: 0, y: 0, floorNumber: 2 },
      ],
      edges: [],
    });
    const cost = estimateLegCost(graph.nodes.get('a'), graph.nodes.get('b'), graph);
    expect(cost).toBeCloseTo(50 * ASSUMED_PIXELS_PER_METER, 5); // FLOOR_CHANGE_PENALTY_M * assumed scale
  });
});

describe('planMultiStopWithFallbacks', () => {
  test('replans the WHOLE tour on a fallback, never just the leg that failed', () => {
    const notBlocked = (edge) => !(edge.tags || []).includes('blocked');
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'a', x: 10, y: 0 },
        { id: 'd', x: 5, y: 5 }, // detour: the only start->a path under the strict filter
        { id: 'b', x: 20, y: 0 },
      ],
      edges: [
        ['start', 'a', { tags: ['blocked'] }], // direct: blocked under strict
        ['start', 'd'],
        ['d', 'a'],
        ['a', 'b', { tags: ['blocked'] }], // only connector to b: blocked under strict
      ],
    });

    const strictAttempt = { edgeFilter: notBlocked, costFn: null };
    const fallbacks = [{ label: 'tagConstraintsRelaxed', edgeFilter: null, costFn: null }];

    const { plan, tagConstraintsRelaxed, accessibleRouteUnavailable } = planMultiStopWithFallbacks(
      graph,
      'start',
      ['a', 'b'],
      null,
      strictAttempt,
      fallbacks
    );

    expect(plan.ok).toBe(true);
    expect(tagConstraintsRelaxed).toBe(true);
    expect(accessibleRouteUnavailable).toBe(false);
    // Leg 1 (start->a) is RE-SOLVED under the relaxed filter too: it now
    // takes the direct, formerly-blocked edge rather than the detour it
    // needed under the strict filter alone — proof the WHOLE plan replanned,
    // not just leg 2 (the one that actually failed strict).
    expect(plan.legs[0].path).toEqual(['start', 'a']);
    expect(plan.legs[1].path).toEqual(['a', 'b']);
  });

  test('succeeds strict without ever trying a fallback', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'a', x: 10, y: 0 },
      ],
      edges: [['start', 'a']],
    });
    const { plan, tagConstraintsRelaxed, accessibleRouteUnavailable } = planMultiStopWithFallbacks(
      graph,
      'start',
      ['a'],
      null,
      { edgeFilter: null, costFn: null },
      [{ label: 'tagConstraintsRelaxed', edgeFilter: () => false, costFn: null }]
    );
    expect(plan.ok).toBe(true);
    expect(tagConstraintsRelaxed).toBe(false);
    expect(accessibleRouteUnavailable).toBe(false);
  });

  test('reports the most-relaxed failure when nothing works at any level', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'island', x: 500, y: 0 }, // no edges at all: unreachable regardless of filter
      ],
      edges: [],
    });
    const { plan, tagConstraintsRelaxed, accessibleRouteUnavailable } = planMultiStopWithFallbacks(
      graph,
      'start',
      ['island'],
      null,
      { edgeFilter: null, costFn: null },
      [{ label: 'accessibleRouteUnavailable', edgeFilter: null, costFn: null }]
    );
    expect(plan.ok).toBe(false);
    expect(plan.failedNodeId).toBe('island');
    // Neither flag meaningfully describes "no plan exists at all".
    expect(tagConstraintsRelaxed).toBe(false);
    expect(accessibleRouteUnavailable).toBe(false);
  });
});
