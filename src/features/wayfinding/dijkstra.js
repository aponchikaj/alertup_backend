import MinHeap from './minHeap.js';
import { makeCostFn, normalizeProfile } from './costModel.js';

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
 *   nodes: Map<id, {id, x, y, type, label, floorId, floorNumber, level}>
 *   adj:   Map<id, Array<{edgeId, to, cost, transitType, accessible, ...}>>
 * @param {string} startId
 * @param {object} opts
 *   - targetId:        route to one specific node (Mode A wayfinding)
 *   - targetPredicate: node => bool; first settled match wins (Mode B: nearest
 *                      EMERGENCY_EXIT)
 *   - edgeFilter:      edge => bool; e.g. accessibility filtering
 *   - costFn:          (edge, fromNode, toNode) => number. Defaults to the
 *                      stored pixel weight, which is what every pre-profile
 *                      caller expects. Infinity or NaN skips the edge, so a
 *                      profile can forbid a transit type without a second
 *                      filter pass.
 *   - excludeNodeIds:  Set|Array of ids that are neither expanded nor accepted
 *                      as a target (closures, alternative-route generation).
 *                      The start is exempt — never strand the traveller.
 * @returns {{path: string[], cost: number} | null} null when unreachable
 */
export function shortestPath(graph, startId, opts = {}) {
  const {
    targetId = null,
    targetPredicate = null,
    edgeFilter = null,
    costFn = null,
    excludeNodeIds = null,
  } = opts;
  const { nodes, adj } = graph;

  const start = nodes.get(startId);
  if (!start) return null;

  const weightOf = costFn || ((edge) => edge.cost);
  const excluded =
    excludeNodeIds instanceof Set
      ? excludeNodeIds
      : Array.isArray(excludeNodeIds) && excludeNodeIds.length > 0
        ? new Set(excludeNodeIds)
        : null;
  const isExcluded = (id) => Boolean(excluded) && id !== startId && excluded.has(id);

  const matchesTarget = targetId
    ? (node) => node.id === targetId
    : targetPredicate || (() => false);
  const isTarget = (node) => !isExcluded(node.id) && matchesTarget(node);

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
      if (isExcluded(edge.to)) continue;
      const next = nodes.get(edge.to);
      if (!next) continue; // dangling reference
      if (edgeFilter && !edgeFilter(edge, current, next)) continue;

      const weight = weightOf(edge, current, next);
      if (!Number.isFinite(weight)) continue; // Infinity/NaN: edge is forbidden

      const candidate = priority + weight;
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
 * Accessibility is an additional constraint on top of whatever the caller
 * already asked for (tag rules, closures), so the two filters compose.
 */
const withAccessibility = (edgeFilter) => (edge, from, to) =>
  edge.accessible !== false && (!edgeFilter || edgeFilter(edge, from, to));

/**
 * Evacuation route: nearest EMERGENCY_EXIT. When accessible routing is
 * requested but no accessible route exists, falls back to the unrestricted
 * graph and flags it — never strand someone during an emergency.
 *
 * `excludeExitIds` removes exits from the *target* set without making their
 * nodes untraversable, which is how alternative routes are generated: the
 * second-nearest exit may well be reached by walking past the nearest one.
 */
export function findEvacuationRoute(
  graph,
  startId,
  {
    accessible = false,
    profile = null,
    costFn = null,
    edgeFilter = null,
    excludeExitIds = [],
    targetPredicate = null,
  } = {}
) {
  const resolved = normalizeProfile(profile);
  const weight = costFn || (resolved ? makeCostFn(resolved) : null);
  const skipped = new Set(excludeExitIds || []);
  const isExit = targetPredicate || ((node) => node.type === 'EMERGENCY_EXIT');
  const wanted = (node) => isExit(node) && !skipped.has(node.id);

  const search = (filter) =>
    shortestPath(graph, startId, {
      targetPredicate: wanted,
      costFn: weight,
      edgeFilter: filter,
    });

  const finish = (result, accessibleRouteUnavailable) =>
    result
      ? {
          ...result,
          accessibleRouteUnavailable,
          exitNodeId: result.path[result.path.length - 1],
        }
      : null;

  if (accessible) {
    const filtered = search(withAccessibility(edgeFilter));
    if (filtered) return finish(filtered, false);
    return finish(search(edgeFilter), true);
  }

  return finish(search(edgeFilter), false);
}

/** Point-to-point route with the same accessibility fallback semantics. */
export function findRoute(
  graph,
  startId,
  targetId,
  {
    accessible = false,
    profile = null,
    costFn = null,
    edgeFilter = null,
    excludeNodeIds = null,
  } = {}
) {
  const resolved = normalizeProfile(profile);
  const weight = costFn || (resolved ? makeCostFn(resolved) : null);

  const search = (filter) =>
    shortestPath(graph, startId, {
      targetId,
      costFn: weight,
      edgeFilter: filter,
      excludeNodeIds,
    });

  if (accessible) {
    const filtered = search(withAccessibility(edgeFilter));
    if (filtered) return { ...filtered, accessibleRouteUnavailable: false };

    const fallback = search(edgeFilter);
    return fallback ? { ...fallback, accessibleRouteUnavailable: true } : null;
  }

  const result = search(edgeFilter);
  return result ? { ...result, accessibleRouteUnavailable: false } : null;
}
