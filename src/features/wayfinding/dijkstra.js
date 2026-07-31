import MinHeap from './minHeap.js';

// Fixed traversal costs (in SVG coordinate units) for cross-floor edges,
// which have no meaningful Euclidean length. STAIRS keeps the historical
// FLOOR_CHANGE_COST=400 so existing route preferences are preserved; powered
// transit is cheaper so the router prefers escalators/elevators when present.
export const DEFAULT_TRANSIT_COST = Object.freeze({
  STAIRS: 400,
  ESCALATOR: 350,
  ELEVATOR: 300,
  WALKWAY: 400,
});

/** Guard against pathological graphs. */
export const MAX_NODES = 20000;

export const calculateDistance = (x1, y1, x2, y2) =>
  Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

/**
 * Binary-heap Dijkstra over a pre-built graph.
 *
 * Dijkstra rather than BFS: BFS minimises hops, not walked distance — two long
 * corridors beat three short ones on hop count while being physically further.
 * Dijkstra rather than A*: evacuation mode is multi-target (nearest of all
 * exits), which has no single goal for a heuristic, and building graphs are
 * small enough that A* buys nothing for point-to-point routes.
 *
 * @param {{nodes: Map, adj: Map}} graph
 *   nodes: Map<id, {id, x, y, type, label, floorId, floorNumber}>
 *   adj:   Map<id, Array<{to, cost, transitType, accessible}>>
 * @param {string} startId
 * @param {object} opts
 *   - targetId:        route to one specific node (Mode A wayfinding)
 *   - targetPredicate: node => bool; first settled match wins (Mode B: nearest
 *                      EMERGENCY_EXIT)
 *   - edgeFilter:      edge => bool; e.g. accessibility filtering
 * @returns {{path: string[], cost: number} | null} null when unreachable
 */
export function shortestPath(graph, startId, opts = {}) {
  const { targetId = null, targetPredicate = null, edgeFilter = null } = opts;
  const { nodes, adj } = graph;

  const start = nodes.get(startId);
  if (!start) return null;

  const isTarget = targetId
    ? (node) => node.id === targetId
    : targetPredicate || (() => false);

  if (isTarget(start)) {
    return { path: [startId], cost: 0 };
  }

  const dist = new Map([[startId, 0]]);
  const prev = new Map();
  const settled = new Set();
  const heap = new MinHeap();
  heap.push(0, startId);

  while (heap.size > 0) {
    const { priority, value: currentId } = heap.pop();
    if (settled.has(currentId)) continue; // stale duplicate
    settled.add(currentId);

    const current = nodes.get(currentId);
    if (!current) continue; // dangling reference

    if (isTarget(current)) {
      const path = [];
      let cursor = currentId;
      while (cursor !== undefined) {
        path.unshift(cursor);
        cursor = prev.get(cursor);
      }
      return { path, cost: priority };
    }

    const edges = adj.get(currentId) || [];
    for (const edge of edges) {
      if (settled.has(edge.to)) continue;
      if (edgeFilter && !edgeFilter(edge)) continue;
      if (!nodes.has(edge.to)) continue;

      const candidate = priority + edge.cost;
      if (candidate < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, candidate);
        prev.set(edge.to, currentId);
        heap.push(candidate, edge.to);
      }
    }
  }

  return null;
}

/**
 * Evacuation route: nearest EMERGENCY_EXIT. When accessible routing is
 * requested but no accessible route exists, falls back to the unrestricted
 * graph and flags it — never strand someone during an emergency.
 */
export function findEvacuationRoute(graph, startId, { accessible = false } = {}) {
  const targetPredicate = (node) => node.type === 'EMERGENCY_EXIT';

  if (accessible) {
    const filtered = shortestPath(graph, startId, {
      targetPredicate,
      edgeFilter: (edge) => edge.accessible !== false,
    });
    if (filtered) return { ...filtered, accessibleRouteUnavailable: false };

    const fallback = shortestPath(graph, startId, { targetPredicate });
    return fallback ? { ...fallback, accessibleRouteUnavailable: true } : null;
  }

  const result = shortestPath(graph, startId, { targetPredicate });
  return result ? { ...result, accessibleRouteUnavailable: false } : null;
}

/** Point-to-point route with the same accessibility fallback semantics. */
export function findRoute(graph, startId, targetId, { accessible = false } = {}) {
  if (accessible) {
    const filtered = shortestPath(graph, startId, {
      targetId,
      edgeFilter: (edge) => edge.accessible !== false,
    });
    if (filtered) return { ...filtered, accessibleRouteUnavailable: false };

    const fallback = shortestPath(graph, startId, { targetId });
    return fallback ? { ...fallback, accessibleRouteUnavailable: true } : null;
  }

  const result = shortestPath(graph, startId, { targetId });
  return result ? { ...result, accessibleRouteUnavailable: false } : null;
}
