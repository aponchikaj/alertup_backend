import { assembleMultiStopRoute } from './multiStopRouteAssembler.js';
import { planMultiStop } from './multiStop.js';
import { buildGraph } from '../../tests/graphFixtures.js';

describe('assembleMultiStopRoute', () => {
  function lineGraph() {
    return buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0, scale: 10 },
        { id: 'near', x: 100, y: 0, scale: 10 },
        { id: 'far', x: 300, y: 0, scale: 10 },
      ],
      edges: [
        ['start', 'near'],
        ['near', 'far'],
      ],
    });
  }

  test('shapes a successful plan into legs[]/stops[] without going through HTTP', () => {
    const graph = lineGraph();
    const plan = planMultiStop(graph, 'start', ['near', 'far'], { costFn: null, edgeFilter: null });
    expect(plan.ok).toBe(true);

    const route = assembleMultiStopRoute(graph, plan, {
      resolvedStops: [{ poi: null }, { poi: null }],
    });

    expect(route.mode).toBe('WAYFINDING');
    expect(route.destination.nodeId).toBe('far');

    expect(route.legs).toHaveLength(2);
    expect(route.legs.map((leg) => leg.toNodeId)).toEqual(['near', 'far']);
    expect(route.legs[0].index).toBe(0);
    expect(route.legs[1].index).toBe(1);

    expect(route.stops).toHaveLength(2);
    expect(route.stops[0].stopIndex).toBe(0);
    expect(route.stops[1].stopIndex).toBe(1);
    // Cumulative: the second stop is farther from the start than the first.
    expect(route.stops[1].distanceFromStartM).toBeGreaterThan(route.stops[0].distanceFromStartM);
  });

  test('a stop\'s POI comes from the graph node when the resolver found none', () => {
    const graph = lineGraph();
    const nearNode = graph.nodes.get('near');
    nearNode.poi = { id: 'poi-1', name: 'Near Shop', category: null };

    const plan = planMultiStop(graph, 'start', ['near', 'far'], { costFn: null, edgeFilter: null });
    const route = assembleMultiStopRoute(graph, plan, {
      resolvedStops: [{ poi: null }, { poi: null }], // no poi: token used
    });

    expect(route.legs[0].poi).toMatchObject({ id: 'poi-1', name: 'Near Shop' });
  });
});
