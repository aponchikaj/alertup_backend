import { alternativeExits } from './alternatives.js';
import { buildRoutingContext } from './profiles.js';
import { buildGraph } from '../../tests/graphFixtures.js';

/** Four exits at increasing walking distance, all reachable from `start`. */
const fanOut = ({ exits = 4 } = {}) => {
  const distances = [100, 300, 600, 900].slice(0, exits);
  return buildGraph({
    nodes: [
      { id: 'start', x: 0, y: 0, floorNumber: 1, scale: 10 },
      ...distances.map((d, i) => ({
        id: `exit-${i}`,
        x: d,
        y: 0,
        floorNumber: 1,
        type: 'EMERGENCY_EXIT',
        label: `Exit ${i}`,
      })),
    ],
    edges: distances.map((_, i) => ['start', `exit-${i}`]),
  });
};

const ctxFor = (graph) => {
  const built = buildRoutingContext(graph, { name: 'emergency' });
  return {
    profile: built.profile,
    profileName: 'emergency',
    costFn: built.costFn,
    edgeFilter: built.edgeFilter,
  };
};

describe('alternativeExits', () => {
  test('returns two DIFFERENT exits, neither of them the primary', () => {
    const graph = fanOut();
    const alts = alternativeExits(graph, 'start', ctxFor(graph), {
      primaryExitId: 'exit-0',
    });

    expect(alts).toHaveLength(2);
    const ids = alts.map((a) => a.exitNodeId);
    expect(ids).not.toContain('exit-0');
    expect(new Set(ids).size).toBe(2);
  });

  test('orders by durationSec, nearest first', () => {
    const graph = fanOut();
    const alts = alternativeExits(graph, 'start', ctxFor(graph), {
      primaryExitId: 'exit-0',
    });
    expect(alts.map((a) => a.exitNodeId)).toEqual(['exit-1', 'exit-2']);
    expect(alts[0].durationSec).toBeLessThan(alts[1].durationSec);
  });

  test('each entry carries the wire-contract fields', () => {
    const graph = fanOut();
    const [first] = alternativeExits(graph, 'start', ctxFor(graph), {
      primaryExitId: 'exit-0',
    });

    expect(first.exitNodeId).toBe('exit-1');
    expect(first.label).toBe('Exit 1');
    expect(first.floorNumber).toBe(1);
    // 300 px at 10 px/m.
    expect(first.distanceM).toBe(30);
    expect(first.durationSec).toBe(first.route.totalDurationSec);
    expect(first.route.mode).toBe('EVACUATION');
    expect(first.route.destination.nodeId).toBe('exit-1');
  });

  test('the embedded route is LEAN — no floor drawing', () => {
    const graph = fanOut();
    const [first] = alternativeExits(graph, 'start', ctxFor(graph), {
      primaryExitId: 'exit-0',
    });
    for (const segment of first.route.segments) {
      expect(Object.hasOwn(segment.floor, 'drawing')).toBe(false);
    }
  });

  test('honours `max`', () => {
    const graph = fanOut();
    const alts = alternativeExits(graph, 'start', ctxFor(graph), {
      primaryExitId: 'exit-0',
      max: 3,
    });
    expect(alts.map((a) => a.exitNodeId)).toEqual(['exit-1', 'exit-2', 'exit-3']);
  });

  test('a building with a single exit has no alternatives', () => {
    const graph = fanOut({ exits: 1 });
    expect(
      alternativeExits(graph, 'start', ctxFor(graph), { primaryExitId: 'exit-0' })
    ).toEqual([]);
  });

  test('stops early when only one other exit is reachable', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0, floorNumber: 1, scale: 10 },
        { id: 'exit-0', x: 100, y: 0, floorNumber: 1, type: 'EMERGENCY_EXIT' },
        { id: 'exit-1', x: 300, y: 0, floorNumber: 1, type: 'EMERGENCY_EXIT' },
        // Wired to nothing: it exists, but nobody can walk to it.
        { id: 'island-exit', x: 900, y: 900, floorNumber: 1, type: 'EMERGENCY_EXIT' },
      ],
      edges: [
        ['start', 'exit-0'],
        ['start', 'exit-1'],
      ],
    });
    const alts = alternativeExits(graph, 'start', ctxFor(graph), {
      primaryExitId: 'exit-0',
    });
    expect(alts.map((a) => a.exitNodeId)).toEqual(['exit-1']);
  });

  test('respects the edge filter it is given', () => {
    const graph = fanOut();
    const ctx = ctxFor(graph);
    const alts = alternativeExits(
      graph,
      'start',
      { ...ctx, edgeFilter: (edge) => edge.to !== 'exit-1' && edge.to !== 'exit-2' },
      { primaryExitId: 'exit-0' }
    );
    expect(alts.map((a) => a.exitNodeId)).toEqual(['exit-3']);
  });
});
