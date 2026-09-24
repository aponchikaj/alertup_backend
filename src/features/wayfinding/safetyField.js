/**
 * Distance-to-safety field: "how far is the nearest way out" for EVERY node in
 * a building, from one search.
 *
 * ## Why a field instead of N searches
 *
 * `findEvacuationRoute` answers one question — "where do I go from here" — with
 * a forward Dijkstra that stops at the first settled exit. During an actual
 * evacuation every occupant asks that question at once, from a different node,
 * and each answer costs its own search over the same graph with the same cost
 * function.
 *
 * Reversing it collapses all of them into one. Imagine a virtual "super-exit"
 * node joined to every EMERGENCY_EXIT by a zero-cost edge; the distance from
 * any node `v` to that super-exit IS `min over exits e of dist(v → e)`, which
 * is exactly what the per-occupant search computes. A single Dijkstra over the
 * REVERSED graph (`graph.radj`), seeded with every exit at cost 0, produces
 * that distance for every node at once — and, by remembering which neighbour
 * each relaxation came from, the first hop of the route too. After the field
 * is built, an occupant's route is a pointer walk (`pathFromField`), not a
 * search.
 *
 * ## Why the reverse adjacency, and why edges are re-oriented
 *
 * The graph is directed (`Edge.direction` = BOTH | FORWARD | REVERSE): a
 * one-way corridor that leads OUT of a wing is not a corridor that leads INTO
 * it. Seeding a forward search at the exits would walk those one-ways
 * backwards and promise routes nobody can take. `graph.radj` holds the
 * incoming traversals with `to` pointing back at the PREDECESSOR, so a plain
 * Dijkstra over it is a correct reverse search.
 *
 * That flip has one consequence the search must undo before it consults the
 * caller's `edgeFilter`/`costFn`: those predicates were written for a forward
 * traversal and read `edge.to` (visibility of the node being entered, closure
 * blocks) and the `(from, to)` node pair. Expanding a `radj` entry at node `u`
 * to its predecessor `v` represents the forward traversal `v → u`, so the
 * entry is handed over with `to` restored to `u` and the nodes passed as
 * `(v, u)`. Without that, a STAFF-only or closed node would be checked on the
 * wrong end and the field would quietly disagree with the forward router.
 *
 * ## Why the cache is a WeakMap keyed by the graph OBJECT
 *
 * `graphCache.getGraph` hands the same mutable graph object to every caller
 * for 60 s and builds a brand-new object on reload. Keying the field cache on
 * that object means (a) a reload drops every field derived from the old graph
 * with no invalidation call to forget, and (b) nothing is ever written onto
 * the shared graph, which several requests read concurrently.
 *
 * The per-graph key is `${ctx.name}|${fingerprint}`: the field depends on the
 * cost function and edge filter, which depend on the routing variant and on
 * the active closure overlay. `buildOverlay`'s `fingerprint` is derived from
 * the RESOLVED restrictions, so two different closure rows that restrict the
 * graph identically share one field, and a closure that changes anything
 * produces a different key (see the note on staleness in `getSafetyField`).
 */

import MinHeap from './minHeap.js';
import { isEmergencyExit } from './dijkstra.js';

/** Fields per graph object. More variants than this in flight at once means
 *  something is generating keys, not using them. */
const MAX_FIELDS_PER_GRAPH = 8;

const fieldCache = new WeakMap(); // graph object -> Map<key, field>

/**
 * One multi-source reverse Dijkstra from the virtual super-exit.
 *
 * @param {{nodes: Map, radj: Map}} graph
 * @param {object} opts
 *   - costFn:     (edge, fromNode, toNode) => number, in FORWARD orientation.
 *                 Defaults to the stored pixel weight, matching `shortestPath`.
 *   - edgeFilter: (edge, fromNode, toNode) => bool, in FORWARD orientation.
 * @returns {{distTo: Map<string, number>, nextHop: Map<string, string>,
 *            exitFor: Map<string, string>, computedAt: number}}
 *   distTo:  cost from the node to its nearest exit. Absent = no route out.
 *   nextHop: the next node on that route. Absent = the node IS an exit.
 *   exitFor: which exit the route ends at.
 */
export function computeSafetyField(graph, { costFn = null, edgeFilter = null } = {}) {
  const { nodes, radj } = graph;
  const weightOf = costFn || ((edge) => edge.cost);

  const distTo = new Map();
  const nextHop = new Map();
  const exitFor = new Map();
  const settled = new Set();
  const heap = new MinHeap();

  for (const [id, node] of nodes) {
    if (!isEmergencyExit(node)) continue;
    distTo.set(id, 0);
    exitFor.set(id, id);
    heap.push(0, id);
  }

  while (heap.size > 0) {
    const { priority, value: currentId } = heap.pop();
    if (settled.has(currentId)) continue; // stale duplicate
    settled.add(currentId);

    const current = nodes.get(currentId);
    if (!current) continue; // dangling reference

    for (const entry of radj.get(currentId) || []) {
      const predecessorId = entry.to; // `radj` points back at the predecessor
      if (settled.has(predecessorId)) continue;
      const predecessor = nodes.get(predecessorId);
      if (!predecessor) continue;

      // Restore the forward orientation before consulting the caller's
      // predicates: the traversal being priced is `predecessor -> current`.
      const forwardEdge = { ...entry, to: currentId };
      if (edgeFilter && !edgeFilter(forwardEdge, predecessor, current)) continue;

      const weight = weightOf(forwardEdge, predecessor, current);
      if (!Number.isFinite(weight)) continue; // Infinity/NaN: edge is forbidden

      const candidate = priority + weight;
      if (candidate < (distTo.get(predecessorId) ?? Infinity)) {
        distTo.set(predecessorId, candidate);
        nextHop.set(predecessorId, currentId);
        // `current` is settled, so its own exit is final.
        exitFor.set(predecessorId, exitFor.get(currentId));
        heap.push(candidate, predecessorId);
      }
    }
  }

  return { distTo, nextHop, exitFor, computedAt: Date.now() };
}

/**
 * The route out of `startId`, read off the field by following `nextHop`.
 *
 * Shaped like `findEvacuationRoute`'s result (minus the accessibility flag the
 * caller owns) so `/evacuate` can hand either to `assembleRoute` unchanged.
 *
 * @returns {{path: string[], cost: number, exitNodeId: string} | null}
 *   null when the node has no route to any exit (or is not in the graph).
 */
export function pathFromField(field, startId) {
  if (!field?.distTo.has(startId)) return null;

  const path = [startId];
  let cursor = startId;
  // `nextHop` is a shortest-path tree, so it cannot cycle; the visited guard
  // is there so a corrupted field fails loudly instead of hanging a request.
  const seen = new Set([startId]);
  while (field.nextHop.has(cursor)) {
    cursor = field.nextHop.get(cursor);
    if (seen.has(cursor)) {
      throw new Error(`Safety field cycles at node ${cursor}.`);
    }
    seen.add(cursor);
    path.push(cursor);
  }

  return {
    path,
    cost: field.distTo.get(startId),
    exitNodeId: field.exitFor.get(startId) ?? cursor,
  };
}

/**
 * The cached field for one routing variant over one loaded graph.
 *
 * @param {object} graph the object `graphCache.getGraph` returned — the cache
 *   key itself, so never a copy of it.
 * @param {{name: string, costFn?: Function, edgeFilter?: Function}} ctx
 *   `name` must distinguish every variant that changes the field (profile,
 *   layered preference, accessibility, tag constraints) — it is half the key,
 *   and it is REQUIRED. Defaulting it would file a field built with whatever
 *   cost function came in under a name claiming a profile it was not built
 *   with, and every later request for that name would silently get the wrong
 *   field. A caller that cannot name its variant cannot safely share a cache.
 * @param {{fingerprint?: string}} options `buildOverlay(...).fingerprint`.
 *
 * STALENESS: the fingerprint changes the key, so a closure created or lifted
 * mid-emergency routes against a NEW field from the next request onward; the
 * old field stays cached under its old key until the graph reloads (60 s) and
 * the WeakMap drops it, and is never served to a request whose overlay no
 * longer matches. Closure rows themselves are re-read per request with a 15 s
 * TTL, which bounds how long a new closure takes to reach the fingerprint.
 */
export function getSafetyField(graph, ctx, { fingerprint = '' } = {}) {
  const name = ctx?.name;
  if (typeof name !== 'string' || name === '') {
    throw new TypeError(
      'getSafetyField requires ctx.name: a non-empty variant name identifying the cost function and edge filter the field is built with.'
    );
  }
  const key = `${name}|${fingerprint}`;

  let fields = fieldCache.get(graph);
  if (!fields) {
    fields = new Map();
    fieldCache.set(graph, fields);
  }

  const cached = fields.get(key);
  if (cached) {
    fields.delete(key); // refresh LRU position
    fields.set(key, cached);
    return cached;
  }

  const field = computeSafetyField(graph, {
    costFn: ctx?.costFn ?? null,
    edgeFilter: ctx?.edgeFilter ?? null,
  });
  fields.set(key, field);
  while (fields.size > MAX_FIELDS_PER_GRAPH) {
    fields.delete(fields.keys().next().value);
  }
  return field;
}

export default computeSafetyField;
