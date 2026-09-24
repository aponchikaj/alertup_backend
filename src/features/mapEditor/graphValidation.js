// Pure graph-quality checks the editor surfaces before an owner prints QR
// codes. Works on the same in-memory graph shape the router uses.

/**
 * @param {{nodes: Map, adj: Map, radj?: Map, floors: Map}} graph `radj` is the
 *   reverse adjacency the graph loader builds (incoming traversals, each
 *   entry's `to` pointing back at the predecessor). It is optional: a caller
 *   that predates it hands in a symmetric `adj`, and every directed check
 *   below then degrades to the two-way behaviour it used to have.
 * @returns {{ok: boolean, issues: Array<{code, severity, message, nodeIds?}>}}
 */
export function validateGraph(graph) {
  const { nodes, adj, radj, floors } = graph;
  const issues = [];

  if (nodes.size === 0) {
    return {
      ok: false,
      issues: [
        {
          code: 'EMPTY_GRAPH',
          severity: 'error',
          message: 'No nodes have been placed yet.',
        },
      ],
    };
  }

  // Directed graph, three views of it:
  //   out      — traversals leaving a node
  //   incoming — traversals arriving at it (`to` is the predecessor)
  //   incident — either direction, for the questions that are about wiring
  //              rather than about walking (orphans, floor links, sections)
  const out = (id) => adj.get(id) || [];
  const incoming = (id) => (radj ? radj.get(id) || [] : out(id));
  const incident = (id) => (radj ? [...out(id), ...incoming(id)] : out(id));

  // Orphan nodes (no edges at all, in either direction)
  const orphans = [...nodes.keys()].filter((id) => incident(id).length === 0);
  if (orphans.length > 0) {
    issues.push({
      code: 'ORPHAN_NODE',
      severity: 'warning',
      message: `${orphans.length} node(s) have no connections.`,
      nodeIds: orphans,
    });
  }

  // Weakly connected components via BFS — "can these two points be wired
  // together at all", so it ignores one-way arrows and walks both directions.
  const seen = new Set();
  const components = [];
  for (const id of nodes.keys()) {
    if (seen.has(id)) continue;
    const component = [];
    const queue = [id];
    seen.add(id);
    while (queue.length) {
      const current = queue.shift();
      component.push(current);
      for (const edge of incident(current)) {
        if (nodes.has(edge.to) && !seen.has(edge.to)) {
          seen.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    components.push(component);
  }
  if (components.length > 1) {
    issues.push({
      code: 'DISCONNECTED_COMPONENTS',
      severity: 'warning',
      message: `The graph has ${components.length} disconnected sections; routes cannot cross between them.`,
      nodeIds: components.slice(1).flat(),
    });
  }

  // Exits
  const exitIds = [...nodes.values()]
    .filter((n) => n.type === 'EMERGENCY_EXIT')
    .map((n) => n.id);
  if (exitIds.length === 0) {
    issues.push({
      code: 'NO_EXIT',
      severity: 'error',
      message: 'No emergency exits are marked. Evacuation routing cannot work.',
    });
  } else {
    // Multi-source BFS from all exits over the REVERSE adjacency: the
    // question is "who can reach an exit", which is the set of nodes an exit
    // is reachable *from*. With one-way edges that is no longer the same as
    // what an exit can reach — a corridor you may only walk away from an exit
    // strands everyone on it, and a forward BFS would call it healthy.
    const reached = new Set(exitIds);
    const queue = [...exitIds];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of incoming(current)) {
        if (nodes.has(edge.to) && !reached.has(edge.to)) {
          reached.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    const stranded = [...nodes.keys()].filter((id) => !reached.has(id));
    if (stranded.length > 0) {
      issues.push({
        code: 'NODE_WITHOUT_REACHABLE_EXIT',
        severity: 'error',
        message: `${stranded.length} node(s) cannot reach any emergency exit.`,
        nodeIds: stranded,
      });
    }
  }

  // One-way pockets: a node you can walk into but not out of. Its only way
  // out is against the arrow, which is exactly the mistake a freshly drawn
  // one-way corridor makes.
  //
  // Exits are exempt: a one-way door that only admits people into an exit is
  // correct modelling, not a defect — leaving it is the whole point.
  const oneWayDeadEnds = [...nodes.values()]
    .filter((n) => n.type !== 'EMERGENCY_EXIT')
    .map((n) => n.id)
    .filter((id) => out(id).length === 0 && incoming(id).length > 0);
  if (oneWayDeadEnds.length > 0) {
    issues.push({
      code: 'EDGE_ONE_WAY_DEAD_END',
      severity: 'warning',
      message: `${oneWayDeadEnds.length} node(s) can only be left against a one-way edge.`,
      nodeIds: oneWayDeadEnds,
    });
  }

  // Transit nodes that never leave their floor
  const badTransit = [...nodes.values()]
    .filter((n) => n.type === 'TRANSIT')
    .filter((n) =>
      incident(n.id).every((edge) => {
        const other = nodes.get(edge.to);
        return !other || other.floorId === n.floorId;
      })
    )
    .map((n) => n.id);
  if (badTransit.length > 0) {
    issues.push({
      code: 'TRANSIT_WITHOUT_CROSS_FLOOR_EDGE',
      severity: 'warning',
      message: `${badTransit.length} transit node(s) are not linked to another floor.`,
      nodeIds: badTransit,
    });
  }

  // Floors with no exit (informational — exits are usually on the ground floor)
  if (floors && floors.size > 1 && exitIds.length > 0) {
    const floorsWithExit = new Set(
      exitIds.map((id) => nodes.get(id)?.floorId).filter(Boolean)
    );
    const withoutExit = [...floors.values()]
      .filter((f) => !floorsWithExit.has(f.id))
      .map((f) => f.floorNumber);
    if (withoutExit.length > 0) {
      issues.push({
        code: 'FLOOR_WITHOUT_EXIT',
        severity: 'info',
        message: `Floor(s) ${withoutExit.join(', ')} have no emergency exit of their own; occupants will be routed through transit.`,
      });
    }
  }

  // POI-typed nodes missing their POI record
  const poiless = [...nodes.values()]
    .filter((n) => n.type === 'POI' && !n.hasPoi)
    .map((n) => n.id);
  if (poiless.length > 0) {
    issues.push({
      code: 'POI_NODE_WITHOUT_DETAILS',
      severity: 'warning',
      message: `${poiless.length} POI node(s) have no shop details assigned.`,
      nodeIds: poiless,
    });
  }

  const ok = !issues.some((issue) => issue.severity === 'error');
  return { ok, issues };
}
