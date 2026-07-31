import { assembleRoute } from './routeAssembler.js';

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

    expect(route.steps).toEqual([
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
    expect(route.steps).toEqual([{ kind: 'walk', segmentIndex: 0 }, { kind: 'arrive' }]);
    expect(route.destination.poi).toBeNull();
  });

  test('returns null for an empty path', () => {
    expect(assembleRoute(makeGraph(), [], {})).toBeNull();
  });
});
