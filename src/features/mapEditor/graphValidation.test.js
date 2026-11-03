import { validateGraph } from './graphValidation.js';

function nodesOf(nodes) {
  return new Map(
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
}

function floorsOf(floors) {
  return new Map(
    (floors.length ? floors : [{ id: 'f1', floorNumber: 1 }]).map((f) => [f.id, f])
  );
}

/**
 * Mirrors `graphService.loadBuildingGraph`: edges are stored once and expanded
 * into `adj` (outgoing) and `radj` (incoming, `to` pointing back at the
 * predecessor) according to `direction`. An edge is `[source, target]` or
 * `[source, target, 'FORWARD'|'REVERSE'|'BOTH']`.
 */
function graphFrom({ nodes, edges = [], floors = [] }) {
  const nodeMap = nodesOf(nodes);
  const adj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  const radj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  const entry = { cost: 1, transitType: 'WALKWAY', accessible: true };
  const push = (from, to) => {
    adj.get(from).push({ ...entry, to });
    radj.get(to).push({ ...entry, to: from });
  };
  for (const [a, b, direction = 'BOTH'] of edges) {
    if (direction === 'BOTH' || direction === 'FORWARD') push(a, b);
    if (direction === 'BOTH' || direction === 'REVERSE') push(b, a);
  }
  return { nodes: nodeMap, adj, radj, floors: floorsOf(floors) };
}

/** A pre-B2 caller: symmetric `adj`, no `radj` at all. */
function legacyGraphFrom({ nodes, edges = [], floors = [] }) {
  const { nodes: nodeMap, adj, floors: floorMap } = graphFrom({ nodes, edges, floors });
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

  test('exit reachability walks edges backwards, not both ways', () => {
    // The only edge is one-way *away* from the exit: you can walk exit → a,
    // but standing on `a` there is no way back. A symmetric BFS would call
    // this healthy.
    const result = validateGraph(
      graphFrom({
        nodes: [{ id: 'a' }, { id: 'exit', type: 'EMERGENCY_EXIT' }],
        edges: [['exit', 'a', 'FORWARD']],
      })
    );
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'NODE_WITHOUT_REACHABLE_EXIT');
    expect(issue.nodeIds).toEqual(['a']);
  });

  test('flags a node that can only be left against a one-way edge', () => {
    const result = validateGraph(
      graphFrom({
        nodes: [
          { id: 'hub' },
          { id: 'pocket' },
          { id: 'exit', type: 'EMERGENCY_EXIT' },
        ],
        edges: [
          ['hub', 'exit'],
          ['hub', 'pocket', 'FORWARD'],
        ],
      })
    );
    const issue = result.issues.find((i) => i.code === 'EDGE_ONE_WAY_DEAD_END');
    expect(issue.severity).toBe('warning');
    expect(issue.nodeIds).toEqual(['pocket']);
    // It is reachable and has an edge, so it is neither an orphan nor a
    // disconnected section.
    expect(codes(result)).not.toContain('ORPHAN_NODE');
    expect(codes(result)).not.toContain('DISCONNECTED_COMPONENTS');
  });

  test('a one-way door into an exit is correct modelling, not a dead end', () => {
    const result = validateGraph(
      graphFrom({
        nodes: [{ id: 'hall' }, { id: 'exit', type: 'EMERGENCY_EXIT' }],
        edges: [['hall', 'exit', 'FORWARD']],
      })
    );
    expect(codes(result)).not.toContain('EDGE_ONE_WAY_DEAD_END');
  });

  test('two-way edges never look like one-way dead ends', () => {
    const result = validateGraph(
      graphFrom({
        nodes: [{ id: 'a' }, { id: 'exit', type: 'EMERGENCY_EXIT' }],
        edges: [['a', 'exit']],
      })
    );
    expect(codes(result)).not.toContain('EDGE_ONE_WAY_DEAD_END');
  });

  test('a graph without radj still validates (pre-B2 callers)', () => {
    const result = validateGraph(
      legacyGraphFrom({
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
    const issue = result.issues.find((i) => i.code === 'NODE_WITHOUT_REACHABLE_EXIT');
    expect(issue.nodeIds.sort()).toEqual(['islandA', 'islandB']);
    expect(codes(result)).not.toContain('EDGE_ONE_WAY_DEAD_END');
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
