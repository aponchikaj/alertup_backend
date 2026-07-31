import { validateGraph } from './graphValidation.js';

function graphFrom({ nodes, edges = [], floors = [] }) {
  const nodeMap = new Map(
    nodes.map((n) => [
      n.id,
      {
        id: n.id,
        x: n.x ?? 0,
        y: n.y ?? 0,
        type: n.type ?? 'NORMAL',
        label: n.label ?? null,
        floorId: n.floorId ?? 'f1',
        floorNumber: n.floorNumber ?? 1,
        hasPoi: n.hasPoi ?? false,
      },
    ])
  );
  const adj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  for (const [a, b] of edges) {
    adj.get(a).push({ to: b, cost: 1, transitType: 'WALKWAY', accessible: true });
    adj.get(b).push({ to: a, cost: 1, transitType: 'WALKWAY', accessible: true });
  }
  const floorMap = new Map(
    (floors.length ? floors : [{ id: 'f1', floorNumber: 1 }]).map((f) => [f.id, f])
  );
  return { nodes: nodeMap, adj, floors: floorMap };
}

const codes = (result) => result.issues.map((i) => i.code);

describe('validateGraph', () => {
  test('empty graph is an error', () => {
    const result = validateGraph(graphFrom({ nodes: [] }));
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['EMPTY_GRAPH']);
  });

  test('healthy graph passes', () => {
    const result = validateGraph(
      graphFrom({
        nodes: [
          { id: 'a' },
          { id: 'exit', type: 'EMERGENCY_EXIT' },
        ],
        edges: [['a', 'exit']],
      })
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('flags orphans, missing exits, disconnected components', () => {
    const result = validateGraph(
      graphFrom({
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'lonely' }],
        edges: [['a', 'b']],
      })
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(
      expect.arrayContaining(['ORPHAN_NODE', 'DISCONNECTED_COMPONENTS', 'NO_EXIT'])
    );
  });

  test('flags nodes that cannot reach any exit', () => {
    const result = validateGraph(
      graphFrom({
        nodes: [
          { id: 'a' },
          { id: 'exit', type: 'EMERGENCY_EXIT' },
          { id: 'islandA' },
          { id: 'islandB' },
        ],
        edges: [
          ['a', 'exit'],
          ['islandA', 'islandB'],
        ],
      })
    );
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'NODE_WITHOUT_REACHABLE_EXIT');
    expect(issue.nodeIds.sort()).toEqual(['islandA', 'islandB']);
  });

  test('flags transit nodes with no cross-floor edge', () => {
    const result = validateGraph(
      graphFrom({
        nodes: [
          { id: 'a', floorId: 'f1' },
          { id: 't', type: 'TRANSIT', floorId: 'f1' },
          { id: 'exit', type: 'EMERGENCY_EXIT', floorId: 'f1' },
        ],
        edges: [
          ['a', 't'],
          ['t', 'exit'],
        ],
      })
    );
    const issue = result.issues.find((i) => i.code === 'TRANSIT_WITHOUT_CROSS_FLOOR_EDGE');
    expect(issue.nodeIds).toEqual(['t']);
    expect(result.ok).toBe(true); // warning, not error
  });

  test('flags POI nodes without shop details', () => {
    const result = validateGraph(
      graphFrom({
        nodes: [
          { id: 'p', type: 'POI', hasPoi: false },
          { id: 'exit', type: 'EMERGENCY_EXIT' },
        ],
        edges: [['p', 'exit']],
      })
    );
    const issue = result.issues.find((i) => i.code === 'POI_NODE_WITHOUT_DETAILS');
    expect(issue.nodeIds).toEqual(['p']);
  });

  test('info issue for floors without their own exit', () => {
    const result = validateGraph(
      graphFrom({
        nodes: [
          { id: 'a', floorId: 'f1', floorNumber: 1 },
          { id: 'exit', type: 'EMERGENCY_EXIT', floorId: 'f1', floorNumber: 1 },
          { id: 't1', type: 'TRANSIT', floorId: 'f1', floorNumber: 1 },
          { id: 't2', type: 'TRANSIT', floorId: 'f2', floorNumber: 2 },
          { id: 'b', floorId: 'f2', floorNumber: 2 },
        ],
        edges: [
          ['a', 'exit'],
          ['a', 't1'],
          ['t1', 't2'],
          ['t2', 'b'],
        ],
        floors: [
          { id: 'f1', floorNumber: 1 },
          { id: 'f2', floorNumber: 2 },
        ],
      })
    );
    const issue = result.issues.find((i) => i.code === 'FLOOR_WITHOUT_EXIT');
    expect(issue.severity).toBe('info');
    expect(result.ok).toBe(true);
  });
});
