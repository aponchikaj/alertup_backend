import mongoose from 'mongoose';
import Node from '../models/node.model.js';
import BUILDINGS from '../models/building.model.js';
import { findShortestRoute, validateRoute, routeDistance, calculateDistance } from './routingService.js';

/**
 * These cover the single most safety-critical function in the app: given the
 * node someone scanned, produce the route they should walk.
 */

const buildingId = new mongoose.Types.ObjectId();

/** Create nodes from a compact spec and wire up bidirectional connections. */
const seedGraph = async (specs) => {
  const created = new Map();

  for (const spec of specs) {
    const node = await Node.create({
      buildingId,
      floorNumber: spec.floor ?? 1,
      x: spec.x,
      y: spec.y,
      type: spec.type,
      label: spec.id,
      connections: [],
    });
    created.set(spec.id, node);
  }

  for (const spec of specs) {
    const node = created.get(spec.id);
    node.connections = (spec.to || []).map((id) => created.get(id)._id);
    await node.save();
  }

  return created;
};

const labels = (route) => route.map((p) => p.label).join(' -> ');

beforeEach(async () => {
  await BUILDINGS.create({ _id: buildingId, buildingName: 'Test Tower', floors: 2 });
});

describe('findShortestRoute', () => {
  test('returns just the node when the scan point is already an exit', async () => {
    const nodes = await seedGraph([{ id: 'E', x: 0, y: 0, type: 'exit' }]);

    const route = await findShortestRoute(nodes.get('E')._id);

    expect(route).toHaveLength(1);
    expect(route[0].type).toBe('exit');
  });

  test('walks a simple corridor to the exit', async () => {
    const nodes = await seedGraph([
      { id: 'A', x: 0, y: 0, type: 'path', to: ['B'] },
      { id: 'B', x: 10, y: 0, type: 'path', to: ['A', 'E'] },
      { id: 'E', x: 20, y: 0, type: 'exit', to: ['B'] },
    ]);

    const route = await findShortestRoute(nodes.get('A')._id);

    expect(labels(route)).toBe('A -> B -> E');
  });

  test('prefers the physically shorter route over the one with fewer hops', async () => {
    // A->B->E is 2 hops but 1000 units of walking.
    // A->C->D->E is 3 hops but only 300 units.
    // A hop-counting BFS picks the wrong one here.
    const nodes = await seedGraph([
      { id: 'A', x: 0, y: 0, type: 'path', to: ['B', 'C'] },
      { id: 'B', x: 500, y: 0, type: 'path', to: ['A', 'E'] },
      { id: 'C', x: 100, y: 0, type: 'path', to: ['A', 'D'] },
      { id: 'D', x: 200, y: 0, type: 'path', to: ['C', 'E'] },
      { id: 'E', x: 300, y: 0, type: 'exit', to: ['B', 'D'] },
    ]);

    const route = await findShortestRoute(nodes.get('A')._id);

    expect(labels(route)).toBe('A -> C -> D -> E');
  });

  test('chooses the nearer of two exits', async () => {
    const nodes = await seedGraph([
      { id: 'S', x: 0, y: 0, type: 'path', to: ['near', 'far'] },
      { id: 'near', x: 50, y: 0, type: 'exit', to: ['S'] },
      { id: 'far', x: 900, y: 0, type: 'exit', to: ['S'] },
    ]);

    const route = await findShortestRoute(nodes.get('S')._id);

    expect(labels(route)).toBe('S -> near');
  });

  test('routes across floors through stairs', async () => {
    const nodes = await seedGraph([
      { id: 'up', x: 0, y: 0, floor: 2, type: 'path', to: ['stairs2'] },
      { id: 'stairs2', x: 10, y: 0, floor: 2, type: 'stairs', to: ['up', 'stairs1'] },
      { id: 'stairs1', x: 10, y: 0, floor: 1, type: 'stairs', to: ['stairs2', 'exit1'] },
      { id: 'exit1', x: 20, y: 0, floor: 1, type: 'exit', to: ['stairs1'] },
    ]);

    const route = await findShortestRoute(nodes.get('up')._id);

    expect(labels(route)).toBe('up -> stairs2 -> stairs1 -> exit1');
    expect(route[0].floor).toBe(2);
    expect(route[route.length - 1].floor).toBe(1);
  });

  test('prefers an exit on the current floor over going downstairs', async () => {
    const nodes = await seedGraph([
      { id: 'P', x: 0, y: 0, floor: 2, type: 'path', to: ['sameFloorExit', 'stairs2'] },
      { id: 'sameFloorExit', x: 200, y: 0, floor: 2, type: 'exit', to: ['P'] },
      { id: 'stairs2', x: 5, y: 0, floor: 2, type: 'stairs', to: ['P', 'stairs1'] },
      { id: 'stairs1', x: 5, y: 0, floor: 1, type: 'stairs', to: ['stairs2', 'downExit'] },
      { id: 'downExit', x: 10, y: 0, floor: 1, type: 'exit', to: ['stairs1'] },
    ]);

    const route = await findShortestRoute(nodes.get('P')._id);

    expect(labels(route)).toBe('P -> sameFloorExit');
  });

  test('throws when no exit is reachable', async () => {
    const nodes = await seedGraph([
      { id: 'A', x: 0, y: 0, type: 'path', to: ['B'] },
      { id: 'B', x: 10, y: 0, type: 'path', to: ['A'] },
    ]);

    await expect(findShortestRoute(nodes.get('A')._id)).rejects.toThrow(
      'No exit route found from this location'
    );
  });

  test('throws when the exit exists but is not connected', async () => {
    const nodes = await seedGraph([
      { id: 'A', x: 0, y: 0, type: 'path', to: [] },
      { id: 'E', x: 10, y: 0, type: 'exit', to: [] },
    ]);

    await expect(findShortestRoute(nodes.get('A')._id)).rejects.toThrow(
      'No exit route found from this location'
    );
  });

  test('terminates on a cyclic graph', async () => {
    const nodes = await seedGraph([
      { id: 'A', x: 0, y: 0, type: 'path', to: ['B', 'C'] },
      { id: 'B', x: 10, y: 0, type: 'path', to: ['A', 'C'] },
      { id: 'C', x: 20, y: 0, type: 'path', to: ['A', 'B', 'E'] },
      { id: 'E', x: 30, y: 0, type: 'exit', to: ['C'] },
    ]);

    const route = await findShortestRoute(nodes.get('A')._id);

    expect(labels(route)).toBe('A -> C -> E');
  });

  test('ignores connections pointing at deleted nodes', async () => {
    const nodes = await seedGraph([
      { id: 'A', x: 0, y: 0, type: 'path', to: ['ghost', 'E'] },
      { id: 'ghost', x: 5, y: 5, type: 'path', to: ['A'] },
      { id: 'E', x: 10, y: 0, type: 'exit', to: ['A'] },
    ]);

    await Node.findByIdAndDelete(nodes.get('ghost')._id);

    const route = await findShortestRoute(nodes.get('A')._id);
    expect(labels(route)).toBe('A -> E');
  });

  test('rejects a missing start node', async () => {
    await expect(findShortestRoute(new mongoose.Types.ObjectId())).rejects.toThrow(
      'Start node not found'
    );
  });

  test('rejects an empty start node id', async () => {
    await expect(findShortestRoute(null)).rejects.toThrow('Start node ID is required');
  });
});

describe('validateRoute', () => {
  test('reports no floor changes for a single-floor route', () => {
    const result = validateRoute([
      { x: 0, y: 0, floor: 1, type: 'path' },
      { x: 1, y: 0, floor: 1, type: 'exit' },
    ]);

    expect(result.valid).toBe(true);
    expect(result.hasStairs).toBe(false);
    expect(result.floorChanges).toHaveLength(0);
  });

  test('describes each floor transition', () => {
    const result = validateRoute([
      { x: 0, y: 0, floor: 3, type: 'path' },
      { x: 1, y: 0, floor: 2, type: 'stairs' },
      { x: 2, y: 0, floor: 1, type: 'stairs' },
      { x: 3, y: 0, floor: 1, type: 'exit' },
    ]);

    expect(result.hasStairs).toBe(true);
    expect(result.floorChanges).toEqual([
      { from: 3, to: 2, atStep: 1, nodeType: 'stairs' },
      { from: 2, to: 1, atStep: 2, nodeType: 'stairs' },
    ]);
  });

  test('flags an empty route as invalid', () => {
    expect(validateRoute([]).valid).toBe(false);
  });
});

describe('routeDistance', () => {
  test('sums same-floor segments only', () => {
    const distance = routeDistance([
      { x: 0, y: 0, floor: 1 },
      { x: 30, y: 40, floor: 1 }, // 50 units
      { x: 30, y: 40, floor: 2 }, // floor change, not counted
      { x: 30, y: 50, floor: 2 }, // 10 units
    ]);

    expect(distance).toBe(60);
  });

  test('is zero for a single point', () => {
    expect(routeDistance([{ x: 5, y: 5, floor: 1 }])).toBe(0);
  });
});

describe('calculateDistance', () => {
  test('computes euclidean distance', () => {
    expect(calculateDistance(0, 0, 3, 4)).toBe(5);
  });
});
