// Pure graph-quality checks the editor surfaces before an owner prints QR
// codes. Works on the same in-memory graph shape the router uses.

/**
 * @param {{nodes: Map, adj: Map, floors: Map}} graph
 * @returns {{ok: boolean, issues: Array<{code, severity, message, nodeIds?}>}}
 */
export function validateGraph(graph) {
  const { nodes, adj, floors } = graph;
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

  const degree = (id) => (adj.get(id) || []).length;

  // Orphan nodes (no edges at all)
  const orphans = [...nodes.keys()].filter((id) => degree(id) === 0);
  if (orphans.length > 0) {
    issues.push({
      code: 'ORPHAN_NODE',
      severity: 'warning',
      message: `${orphans.length} node(s) have no connections.`,
      nodeIds: orphans,
    });
  }

  // Connected components via BFS
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
      for (const edge of adj.get(current) || []) {
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
    // Multi-source BFS from all exits; adjacency is symmetric so forward
    // reachability equals reverse reachability.
    const reached = new Set(exitIds);
    const queue = [...exitIds];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of adj.get(current) || []) {
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

  // Transit nodes that never leave their floor
  const badTransit = [...nodes.values()]
    .filter((n) => n.type === 'TRANSIT')
    .filter((n) =>
      (adj.get(n.id) || []).every((edge) => {
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
