import { assembleRoute, pathEdges } from './routeAssembler.js';
import { resolveProfile } from './costModel.js';
import { buildGraph } from '../../tests/graphFixtures.js';

/**
 * Two floors joined by a non-step-free escalator, shaped like
 * `graphService.loadBuildingGraph` output so the v2 fields (edge ids, lengths,
 * levels, accessibility) are all present.
 *
 * Floor 1: a --300px--> b --100px--> esc1   (400 px)
 * Floor 2: esc2 --200px--> shop             (200 px)
 *
 * `scale` is read from the first node seen on each floor.
 */
function twoFloorGraph({ scale = 10 } = {}) {
  return buildGraph({
    nodes: [
      { id: 'a', x: 0, y: 0, floorNumber: 1, scale, type: 'ENTRANCE', label: 'Main entrance' },
      { id: 'b', x: 300, y: 0, floorNumber: 1 },
      { id: 'esc1', x: 300, y: 100, floorNumber: 1, type: 'TRANSIT', label: 'Escalator A' },
      { id: 'esc2', x: 300, y: 100, floorNumber: 2, scale, type: 'TRANSIT', label: 'Escalator A' },
      { id: 'shop', x: 500, y: 100, floorNumber: 2, type: 'POI', label: 'LC Waikiki' },
    ],
    edges: [
      ['a', 'b'],
      ['b', 'esc1'],
      ['esc1', 'esc2', { transitType: 'ESCALATOR', accessible: false }],
      ['esc2', 'shop'],
    ],
  });
}

const FULL_PATH = ['a', 'b', 'esc1', 'esc2', 'shop'];

function makeGraph() {
  const floors = new Map([
    [
      'f1',
      { id: 'f1', floorNumber: 1, name: 'Ground Floor', mapImageUrl: 'https://x/f1.svg', width: 1000, height: 800, scalePixelsPerMeter: 10 },
    ],
    [
      'f4',
      { id: 'f4', floorNumber: 4, name: 'Level 4', mapImageUrl: 'https://x/f4.svg', width: 1000, height: 800, scalePixelsPerMeter: 10 },
    ],
  ]);
  const nodes = new Map([
    ['a', { id: 'a', x: 0, y: 0, type: 'ENTRANCE', label: 'Main entrance', floorId: 'f1', floorNumber: 1 }],
    ['b', { id: 'b', x: 300, y: 0, type: 'NORMAL', label: null, floorId: 'f1', floorNumber: 1 }],
    ['esc1', { id: 'esc1', x: 300, y: 100, type: 'TRANSIT', label: 'Escalator A', floorId: 'f1', floorNumber: 1 }],
    ['esc4', { id: 'esc4', x: 300, y: 100, type: 'TRANSIT', label: 'Escalator A', floorId: 'f4', floorNumber: 4 }],
    ['shop', { id: 'shop', x: 500, y: 100, type: 'POI', label: 'LC Waikiki', floorId: 'f4', floorNumber: 4 }],
  ]);
  const adj = new Map([
    ['a', [{ to: 'b', cost: 300, transitType: 'WALKWAY', accessible: true }]],
    ['b', [
      { to: 'a', cost: 300, transitType: 'WALKWAY', accessible: true },
      { to: 'esc1', cost: 100, transitType: 'WALKWAY', accessible: true },
    ]],
    ['esc1', [
      { to: 'b', cost: 100, transitType: 'WALKWAY', accessible: true },
      { to: 'esc4', cost: 350, transitType: 'ESCALATOR', accessible: false },
    ]],
    ['esc4', [
      { to: 'esc1', cost: 350, transitType: 'ESCALATOR', accessible: false },
      { to: 'shop', cost: 200, transitType: 'WALKWAY', accessible: true },
    ]],
    ['shop', [{ to: 'esc4', cost: 200, transitType: 'WALKWAY', accessible: true }]],
  ]);
  return { nodes, adj, floors };
}

describe('assembleRoute', () => {
  test('splits a multi-floor path into segments with a transition', () => {
    const graph = makeGraph();
    const route = assembleRoute(graph, ['a', 'b', 'esc1', 'esc4', 'shop'], {
      mode: 'WAYFINDING',
      destinationPoi: { id: 'p1', name: 'LC Waikiki', category: 'Apparel' },
    });

    expect(route.segments).toHaveLength(2);
    expect(route.segments[0].floor.floorNumber).toBe(1);
    expect(route.segments[0].nodes.map((n) => n.id)).toEqual(['a', 'b', 'esc1']);
    expect(route.segments[1].floor.floorNumber).toBe(4);
    expect(route.segments[1].nodes.map((n) => n.id)).toEqual(['esc4', 'shop']);

    expect(route.transitions).toHaveLength(1);
    expect(route.transitions[0]).toMatchObject({
      afterSegmentIndex: 0,
      transitType: 'ESCALATOR',
      fromFloorNumber: 1,
      toFloorNumber: 4,
      direction: 'up',
      label: 'Escalator A',
    });

    expect(route.steps).toMatchObject([
      { kind: 'walk', segmentIndex: 0 },
      { kind: 'transit', transitionIndex: 0 },
      { kind: 'walk', segmentIndex: 1 },
      { kind: 'arrive' },
    ]);

    expect(route.origin).toEqual({ nodeId: 'a', label: 'Main entrance', floorNumber: 1 });
    expect(route.destination.poi.name).toBe('LC Waikiki');
  });

  test('converts pixel distances to meters via floor scale', () => {
    const graph = makeGraph();
    const route = assembleRoute(graph, ['a', 'b', 'esc1', 'esc4', 'shop'], {});
    // Floor 1: 300 + 100 px at 10 px/m = 40 m; floor 4: 200 px = 20 m
    expect(route.segments[0].distancePx).toBe(400);
    expect(route.segments[0].distanceMeters).toBe(40);
    expect(route.segments[1].distanceMeters).toBe(20);
    expect(route.totalDistanceMeters).toBe(60);
  });

  test('meters are null when a floor has no scale', () => {
    const graph = makeGraph();
    graph.floors.get('f1').scalePixelsPerMeter = null;
    const route = assembleRoute(graph, ['a', 'b'], {});
    expect(route.segments[0].distanceMeters).toBeNull();
    expect(route.totalDistanceMeters).toBeNull();
    expect(route.totalDistancePx).toBe(300);
  });

  test('single-floor evacuation route has no transitions', () => {
    const graph = makeGraph();
    const route = assembleRoute(graph, ['a', 'b'], { mode: 'EVACUATION' });
    expect(route.mode).toBe('EVACUATION');
    expect(route.segments).toHaveLength(1);
    expect(route.transitions).toHaveLength(0);
    expect(route.steps).toMatchObject([{ kind: 'walk', segmentIndex: 0 }, { kind: 'arrive' }]);
    expect(route.destination.poi).toBeNull();
  });

  test('returns null for an empty path', () => {
    expect(assembleRoute(makeGraph(), [], {})).toBeNull();
  });

  test('cumulative step fields sum to the route totals', () => {
    const route = assembleRoute(twoFloorGraph(), FULL_PATH, {});

    // Floor 1: 400 px at 10 px/m = 40 m -> 40/1.4 = 28.6 s -> 29 s.
    // Escalator: 3 s entry + 8 m / 0.5 m/s = 19 s.
    // Floor 2: 200 px = 20 m -> 20/1.4 = 14.3 s -> 14 s.
    expect(route.segments.map((s) => s.distanceM)).toEqual([40, 20]);
    expect(route.segments.map((s) => s.durationSec)).toEqual([29, 14]);
    expect(route.totalDistanceM).toBe(60);
    expect(route.totalDurationSec).toBe(62);
    expect(route.profile).toBe('walk');
    expect(route.scaleAssumed).toBe(false);
    expect(route.tagConstraintsRelaxed).toBe(false);

    // Every step's cumulative fields are the running total BEFORE that step,
    // and the final `arrive` step carries the route totals.
    let metres = 0;
    let seconds = 0;
    for (const step of route.steps) {
      expect(step.distanceUntilM).toBe(metres);
      expect(step.timeUntilSec).toBe(seconds);
      metres = Math.round((metres + step.distanceM) * 10) / 10;
      seconds += step.durationSec;
    }
    expect(metres).toBe(route.totalDistanceM);
    expect(seconds).toBe(route.totalDurationSec);
    expect(route.steps.at(-1)).toMatchObject({
      kind: 'arrive',
      distanceUntilM: 60,
      timeUntilSec: 62,
    });

    // Segment distances alone account for the whole route: transitions add
    // time, never metres.
    expect(route.segments.reduce((sum, s) => sum + s.distanceM, 0)).toBe(
      route.totalDistanceM
    );
  });

  test('escalator transition duration follows the profile speeds and marks the step inaccessible', () => {
    const graph = twoFloorGraph();
    const route = assembleRoute(graph, FULL_PATH, {});

    const transition = route.transitions[0];
    expect(transition.transitType).toBe('ESCALATOR');
    expect(transition.level).toEqual({ from: 1, to: 2 });
    expect(transition.edgeId).toEqual(expect.any(String));
    // walk profile: escalatorEntrySec 3 + escalatorRunMPerFloor 8 / 0.5 m/s.
    expect(transition.durationSec).toBe(19);
    expect(transition.accessible).toBe(false);

    const transitStep = route.steps.find((s) => s.kind === 'transit');
    expect(transitStep).toMatchObject({
      transitionIndex: 0,
      distanceM: 0,
      durationSec: 19,
      accessible: false,
    });
    // The walking segments stay accessible — only the escalator is not.
    expect(route.segments.map((s) => s.accessible)).toEqual([true, true]);

    // elevator_first's ESCALATOR multiplier steers the *search* away from the
    // escalator; it is reluctance, not seconds, so the ETA must not move.
    const steered = assembleRoute(graph, FULL_PATH, {
      profile: resolveProfile(null, 'elevator_first'),
      profileName: 'elevator_first',
    });
    expect(steered.profile).toBe('elevator_first');
    expect(steered.transitions[0].durationSec).toBe(19);
    expect(steered.steps.find((s) => s.kind === 'transit').durationSec).toBe(19);
    expect(steered.totalDurationSec).toBe(route.totalDurationSec);
  });

  test('search penalties never reach the ETA, but building tuning does', () => {
    const graph = twoFloorGraph();
    const plain = assembleRoute(graph, FULL_PATH, {});

    // min_floor_changes prices a floor change at +600 s so Dijkstra avoids it.
    // Telling the visitor the escalator takes ten minutes would be a lie.
    const minFloorChanges = assembleRoute(graph, FULL_PATH, {
      profile: resolveProfile(null, 'min_floor_changes'),
      profileName: 'min_floor_changes',
    });
    expect(minFloorChanges.profile).toBe('min_floor_changes');
    expect(minFloorChanges.transitions[0].durationSec).toBe(19);
    expect(minFloorChanges.steps.find((s) => s.kind === 'transit').durationSec).toBe(19);
    expect(minFloorChanges.totalDurationSec).toBe(plain.totalDurationSec);
    expect(minFloorChanges.steps.at(-1).timeUntilSec).toBe(plain.totalDurationSec);

    // Real speeds are not penalties: a building that says its visitors walk
    // slowly gets a slower ETA.
    const slowGraph = twoFloorGraph();
    slowGraph.routingProfile = { walkSpeedMps: 0.7 };
    const slow = assembleRoute(slowGraph, FULL_PATH, {});
    expect(slow.segments[0].durationSec).toBe(57); // 40 m / 0.7 m/s
    expect(slow.totalDurationSec).toBeGreaterThan(plain.totalDurationSec);
  });

  test('wheelchair fallback annotates inaccessible steps with metres from start', () => {
    const graph = twoFloorGraph();
    const route = assembleRoute(graph, FULL_PATH, {
      accessible: true,
      accessibleRouteUnavailable: true,
      profile: resolveProfile(null, 'wheelchair'),
      profileName: 'wheelchair',
    });

    const inaccessible = route.warnings.filter((w) => w.code === 'INACCESSIBLE_STEP');
    expect(inaccessible).toHaveLength(1);
    expect(inaccessible[0]).toMatchObject({
      code: 'INACCESSIBLE_STEP',
      segmentIndex: 0,
      transitionIndex: 0,
      stepIndex: 1,
      // 40 m of floor-1 walking happen before the escalator.
      distanceFromStartM: 40,
    });
    expect(typeof inaccessible[0].message).toBe('string');

    // A plain walk over the same path is not a fallback and warns about nothing.
    expect(assembleRoute(graph, FULL_PATH, {}).warnings).toEqual([]);
    // Neither does wheelchair when the strict accessible route was found.
    expect(
      assembleRoute(graph, FULL_PATH, {
        accessible: true,
        profile: resolveProfile(null, 'wheelchair'),
        profileName: 'wheelchair',
      }).warnings
    ).toEqual([]);
  });

  test('legacy accessible callers get inaccessible-step warnings without a profile', () => {
    // Today's callers (scan, AI tools, evacuation brief) pass the two flags and
    // no profile at all; the warning must not depend on the profile name.
    const route = assembleRoute(twoFloorGraph(), FULL_PATH, {
      accessible: true,
      accessibleRouteUnavailable: true,
    });
    expect(route.profile).toBe('walk');

    const inaccessible = route.warnings.filter((w) => w.code === 'INACCESSIBLE_STEP');
    expect(inaccessible).toHaveLength(1);
    expect(inaccessible[0]).toMatchObject({
      segmentIndex: 0,
      transitionIndex: 0,
      stepIndex: 1,
      distanceFromStartM: 40,
    });

    // `accessible` alone is not a fallback — the route it asked for was found.
    expect(assembleRoute(twoFloorGraph(), FULL_PATH, { accessible: true }).warnings).toEqual(
      []
    );
  });

  test('a traversed closure raises CLOSURE_ON_ROUTE', () => {
    const graph = twoFloorGraph();
    const walked = pathEdges(graph, FULL_PATH);
    const overlayFor = (edgeId) => ({
      edgeMultiplier: new Map([[edgeId, 2]]),
      blockedEdgeIds: new Set(),
      blockedNodeIds: new Set(),
    });
    const closures = (overlay) =>
      assembleRoute(graph, FULL_PATH, { overlay }).warnings.filter(
        (w) => w.code === 'CLOSURE_ON_ROUTE'
      );

    // b -> esc1, 30 m into the walk, inside segment 0.
    const onSegment = closures(overlayFor(walked[1].edge.edgeId));
    expect(onSegment).toHaveLength(1);
    expect(onSegment[0]).toMatchObject({ segmentIndex: 0, distanceFromStartM: 30 });
    expect(onSegment[0].transitionIndex).toBeUndefined();
    expect(typeof onSegment[0].message).toBe('string');

    // esc1 -> esc2 is the cross-floor edge, so the warning points at the
    // transition as well as the segment it follows.
    const onTransition = closures(overlayFor(walked[2].edge.edgeId));
    expect(onTransition).toHaveLength(1);
    expect(onTransition[0]).toMatchObject({
      segmentIndex: 0,
      transitionIndex: 0,
      distanceFromStartM: 40,
    });

    // A closure that is not on this path, an empty overlay, and no overlay.
    expect(closures(overlayFor('not-on-this-route'))).toEqual([]);
    expect(closures(null)).toEqual([]);
    expect(assembleRoute(graph, FULL_PATH, {}).warnings).toEqual([]);
  });

  test('an unscaled floor sets scaleAssumed and warns while distanceMeters stays null', () => {
    const graph = twoFloorGraph({ scale: null });
    const route = assembleRoute(graph, ['a', 'b', 'esc1'], {});

    expect(route.scaleAssumed).toBe(true);
    expect(route.segments[0].scaleAssumed).toBe(true);
    // Today's null semantics are untouched...
    expect(route.segments[0].distanceMeters).toBeNull();
    expect(route.totalDistanceMeters).toBeNull();
    // ...while the new fields are always numbers, at the assumed 50 px/m.
    expect(route.segments[0].distancePx).toBe(400);
    expect(route.segments[0].distanceM).toBe(8);
    expect(route.totalDistanceM).toBe(8);

    const warning = route.warnings.find((w) => w.code === 'SCALE_ASSUMED');
    expect(warning).toBeDefined();
    expect(warning.floorIds).toEqual(['floor-1']);
    expect(typeof warning.message).toBe('string');

    // A scaled route never claims an assumption.
    expect(assembleRoute(twoFloorGraph(), FULL_PATH, {}).scaleAssumed).toBe(false);
  });

  test('segments carry points: unsmoothed node polyline when the floor has no wall/outline geometry', () => {
    const graph = makeGraph();
    const route = assembleRoute(graph, ['a', 'b', 'esc1', 'esc4', 'shop'], {});

    expect(route.segments[0].points).toEqual([
      { x: 0, y: 0, nodeId: 'a' },
      { x: 300, y: 0, nodeId: 'b' },
      { x: 300, y: 100, nodeId: 'esc1' },
    ]);
    expect(route.segments[1].points).toEqual([
      { x: 300, y: 100, nodeId: 'esc4' },
      { x: 500, y: 100, nodeId: 'shop' },
    ]);
    // Distances stay node-based: smoothing never touches them.
    expect(route.segments[0].distancePx).toBe(400);
  });

  test('segments carry points: a wall keeps the corner but distances stay node-based', () => {
    const graph = twoFloorGraph();
    // A wall crossing the diagonal from a (0,0) to esc1 (300,100) — but not
    // the vertical b (300,0) -> esc1 (300,100) leg — forces the corner at b
    // to survive smoothing; the drawing lives on floor-1, where segment 0
    // walks.
    graph.floors.get('floor-1').drawing = {
      shapes: [{ kind: 'wall', points: [150, -50, 150, 150], thickness: 4 }],
    };
    const route = assembleRoute(graph, FULL_PATH, {});

    // a -> esc1 direct is blocked by the wall at x=150, so the corner at b
    // must survive.
    expect(route.segments[0].points.map((p) => p.nodeId)).toEqual(['a', 'b', 'esc1']);
    // Segment 1 (floor-2) has no drawing, so it stays unsmoothed.
    expect(route.segments[1].points.map((p) => p.nodeId)).toEqual(['esc2', 'shop']);

    // Distances are unchanged by the drawing being present.
    expect(route.segments[0].distancePx).toBe(400);
    expect(route.segments[0].distanceM).toBe(40);
  });

  test('pathEdges resolves the traversed adjacency entries and lean drops the drawing', () => {
    const graph = twoFloorGraph();
    const walked = pathEdges(graph, FULL_PATH);
    expect(walked).toHaveLength(4);
    expect(walked.map(({ from, to }) => `${from.id}->${to.id}`)).toEqual([
      'a->b',
      'b->esc1',
      'esc1->esc2',
      'esc2->shop',
    ]);
    expect(walked.every(({ edge }) => typeof edge.edgeId === 'string')).toBe(true);
    expect(walked[2].edge.transitType).toBe('ESCALATOR');
    expect(pathEdges(graph, ['a'])).toEqual([]);

    graph.floors.get('floor-1').drawing = { shapes: [] };
    expect(assembleRoute(graph, FULL_PATH, {}).segments[0].floor.drawing).toEqual({
      shapes: [],
    });
    const leanRoute = assembleRoute(graph, FULL_PATH, { lean: true });
    expect('drawing' in leanRoute.segments[0].floor).toBe(false);
    expect('svgContent' in leanRoute.segments[0].floor).toBe(false);
  });
});
