/**
 * Multi-stop routing (B12): a visitor asks for several destinations at once
 * and gets ONE route that visits them in a sensible order, rather than the
 * order they happened to type them in.
 *
 * ## Decision: ordering runs on a geometric proxy, never on `shortestPath`
 *
 * This is a decision, not a shortcut awaiting a follow-up. A real ordering
 * decision needs to know how far every stop is from every other — a full
 * `n x n` distance matrix. Building that matrix with REAL graph searches
 * costs `n*(n-1)` Dijkstra runs: 72 of them at the 8-destination cap (9
 * nodes including the start), on `GET /api/wayfinding/route`, an anonymous,
 * unauthenticated, public endpoint. That is a denial-of-service surface, not
 * an implementation detail — a handful of callers hitting the rate limit
 * with 8-stop requests would multiply into thousands of Dijkstra runs a
 * minute for no benefit codepath users would ever notice.
 *
 * So ordering runs on a cheap PROXY instead — straight-line pixel distance,
 * scaled through each floor's own metres-per-pixel, plus a flat penalty per
 * floor crossed (`estimateLegCost` below) — computed purely from node
 * coordinates and floor metadata, no graph traversal, no closures, no
 * accessibility, no tags. That proxy decides the VISITING ORDER ONLY; once
 * the order is fixed, the actual walk between each consecutive pair is a
 * real `shortestPath` run (via `findRoute`, using the caller's own cost
 * function and edge filter — see below), so the distances, times and
 * reachability the visitor is finally shown are exact, never estimated.
 *
 * The accepted consequence: with an active closure, a wheelchair filter, or
 * a tag exclusion in effect, the proxy can optimise the visiting ORDER
 * against a walk the visitor will not actually take (it has no idea a
 * corridor is closed), so the chosen order may not be the shortest order
 * once real constraints apply. This is acceptable because it only ever
 * affects which order is chosen — EVERY leg still searches under the
 * caller's real `costFn`/`edgeFilter` (via `planMultiStop`/
 * `planMultiStopWithFallbacks` below), so the resulting route is always
 * correct with respect to closures, tags, visibility and accessibility. Only
 * its order might, rarely, be a stop worse than optimal. A route that is
 * occasionally non-optimally ordered is a far smaller problem than a public
 * endpoint whose cost scales quadratically with how many stops a caller asks
 * for.
 *
 * ## Why the ordering never touches costFn/edgeFilter
 *
 * `orderStops` is pure arithmetic over a matrix of numbers; it has no idea
 * what a closure, a tag filter or an accessibility rule is, and does not
 * need to — those all apply where they always have, inside the real
 * `findRoute` call for each leg. Handing `orderStops` anything routing-aware
 * would only tempt a future change to reach for it, which is exactly the
 * mistake this module exists to avoid: a multi-stop route MUST search under
 * the SAME `costFn`/`edgeFilter` a single-destination route would, or it
 * quietly stops respecting closures, tag filters and visibility rules.
 *
 * ## Real cost per request
 *
 * Bounded, but not as small as "one search per stop" once fallbacks are
 * counted. `planMultiStop` itself costs exactly one `findRoute` call per
 * requested stop (<= 8, never one per pair). `planMultiStopWithFallbacks`
 * (used by every HTTP caller) can invoke `planMultiStop` up to THREE times —
 * strict, tags relaxed, accessibility dropped — because a route-level
 * fallback replans the WHOLE tour, not just the leg that failed (see that
 * function's own header for why). Worst case: 3 attempts x 8 legs = 24
 * Dijkstra searches for a single request. At `publicReadLimiter`'s 120
 * requests/minute per key, one caller sustaining worst-case requests could
 * drive on the order of 2,880 searches/minute against a single-machine
 * deployment. Accepted for now — write this down again if this endpoint's
 * limits ever need revisiting.
 */

import { calculateDistance, findRoute } from './dijkstra.js';
import { ASSUMED_PIXELS_PER_METER } from './costModel.js';

/** Guard against a pathological caller; the HTTP layer enforces its own,
 *  user-facing cap (422) well below this — this is just a last-resort floor. */
const MAX_STOPS = 64;

/**
 * Order a set of points into a sensible open-path visiting sequence:
 * nearest-neighbor construction from the fixed start, refined by 2-opt
 * segment reversals.
 *
 * This is the OPEN-path variant — there is no edge closing the tour back to
 * `fixedStart` (a visitor does not walk back to where they began), so the
 * last node in the tour has no "next" edge to weigh a reversal against.
 *
 * Pure and synchronous: `costMatrix` can be any n x n matrix of
 * non-negative numbers (Euclidean pixel distance, a precomputed graph
 * distance, anything) — this function never looks at a graph, which is what
 * keeps it cheap enough to call on every request.
 *
 * @param {number[][]} costMatrix costMatrix[i][j] = cost of going from i to j
 * @param {{fixedStart?: number}} [opts] the index that must stay first in the
 *   returned order — the visitor's actual position, never reordered away
 * @returns {number[]} a permutation of `0..costMatrix.length-1`, starting
 *   with `fixedStart`
 */
export function orderStops(costMatrix, { fixedStart = 0 } = {}) {
  const n = costMatrix?.length ?? 0;
  if (n === 0) return [];
  if (n === 1) return [fixedStart];

  const nnOrder = nearestNeighborOrder(costMatrix, fixedStart, n);
  return twoOpt(nnOrder, costMatrix);
}

/** Greedy construction: always step to the nearest unvisited node. */
function nearestNeighborOrder(costMatrix, start, n) {
  const visited = new Set([start]);
  const order = [start];
  let current = start;

  while (order.length < n) {
    let best = null;
    let bestCost = Infinity;
    for (let j = 0; j < n; j += 1) {
      if (visited.has(j)) continue;
      const cost = costMatrix[current][j];
      if (Number.isFinite(cost) && cost < bestCost) {
        bestCost = cost;
        best = j;
      }
    }
    // Defensive: a matrix with Infinity/NaN gaps (a disconnected proxy) would
    // otherwise loop forever. Fall back to visiting whatever is left in
    // index order rather than stalling.
    if (best === null) {
      for (let j = 0; j < n; j += 1) {
        if (!visited.has(j)) {
          best = j;
          break;
        }
      }
    }
    visited.add(best);
    order.push(best);
    current = best;
  }

  return order;
}

/**
 * 2-opt local search over an OPEN path: repeatedly reverse a segment
 * `tour[i..j]` (`i >= 1`, so the fixed start at index 0 is never disturbed)
 * whenever doing so shortens the tour, until a full pass finds no
 * improvement.
 */
function twoOpt(tour, costMatrix) {
  const n = tour.length;
  const result = tour.slice();
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const prevEdge = costMatrix[result[i - 1]][result[i]];
        let delta;
        if (j + 1 < n) {
          const nextEdge = costMatrix[result[j]][result[j + 1]];
          const newFirst = costMatrix[result[i - 1]][result[j]];
          const newSecond = costMatrix[result[i]][result[j + 1]];
          delta = newFirst + newSecond - (prevEdge + nextEdge);
        } else {
          // Reversing all the way to the last node only changes the ONE
          // edge feeding into the segment — there is no edge after the last
          // node in an open path to weigh against.
          const newFirst = costMatrix[result[i - 1]][result[j]];
          delta = newFirst - prevEdge;
        }
        if (delta < -1e-9) {
          reverseInPlace(result, i, j);
          improved = true;
        }
      }
    }
  }

  return result;
}

function reverseInPlace(arr, lo, hi) {
  let a = lo;
  let b = hi;
  while (a < b) {
    const tmp = arr[a];
    arr[a] = arr[b];
    arr[b] = tmp;
    a += 1;
    b -= 1;
  }
}

/** A node's vertical position, for the cross-floor cost penalty below. */
const levelOf = (node) => (Number.isFinite(node?.level) ? node.level : (node?.floorNumber ?? 0));

/** A floor's pixels-per-metre, falling back to the same assumed scale the
 *  rest of routing uses for an uncalibrated floor (`costModel.js`'s
 *  `ASSUMED_PIXELS_PER_METER`, also `routeAssembler.js`'s `scaleOf`) — the
 *  graph loader flags an unscaled floor via `unscaledFloorIds`, but every
 *  other consumer of scale in this codebase reads straight off
 *  `scalePixelsPerMeter` with this same fallback rather than consulting that
 *  set directly, so this does too. */
function pixelsPerMeter(node, graph) {
  const floor = graph?.floors?.get(node?.floorId);
  const scale = floor?.scalePixelsPerMeter;
  return scale > 0 ? scale : ASSUMED_PIXELS_PER_METER;
}

/**
 * A floor change is treated, for ORDERING purposes only, as equivalent to
 * this many METRES of walking — deliberately large so the heuristic prefers
 * finishing one floor before crossing to another, without needing to know
 * the real transit cost (that is exactly what the per-leg `findRoute` call
 * finds out for real).
 *
 * Expressed in METRES and converted through each floor's own
 * `scalePixelsPerMeter`, not as a raw pixel constant: a fixed pixel number
 * means something completely different on a 1,000px floorplan than on a
 * 20,000px one, which would make the ordering behave inconsistently from one
 * building to the next — nearly free on a large plan, dominant on a small
 * one. Scaling it through metres keeps its WEIGHT relative to a same-floor
 * walk consistent regardless of how a given floor happens to be drawn.
 */
const FLOOR_CHANGE_PENALTY_M = 50;

/**
 * Cheap, graph-free proxy for "how far apart are these two stops": plain
 * pixel distance on the same floor, or a scaled per-floor penalty when they
 * are not. Exported for direct testing of the scaling behaviour; not part of
 * the routing contract (`orderStops`/`planMultiStop` are).
 */
export function estimateLegCost(a, b, graph) {
  if (!a || !b) return Infinity;
  if (a.floorId === b.floorId) return calculateDistance(a.x, a.y, b.x, b.y);
  const levelDiff = Math.max(1, Math.abs(levelOf(a) - levelOf(b)));
  const scale = (pixelsPerMeter(a, graph) + pixelsPerMeter(b, graph)) / 2;
  return FLOOR_CHANGE_PENALTY_M * levelDiff * scale;
}

/**
 * Plan a multi-stop route: pick a sensible order to visit `targetIds` from
 * `fromId`, then walk it leg by leg with real searches.
 *
 * ## Duplicate destinations
 *
 * `destinations.js`'s `parseDestinations` deliberately preserves a
 * non-adjacent repeat (`to=A&to=B&to=A`) as a genuine round trip back
 * through an earlier stop. The geometric ordering proxy above has no notion
 * of IDENTITY, only distance: two occurrences of the same node are zero
 * distance apart, so nearest-neighbor always places them adjacent —
 * silently turning "go there, do something else, then go back" into "go
 * there twice in a row", which defeats the point of asking for it twice.
 * Building a constrained-TSP variant to keep repeats apart is more machinery
 * than this narrow case is worth. Instead: **a request containing ANY
 * duplicate destination is walked in exactly the order it was requested,
 * with no optimization at all.** That is the one ordering guaranteed to mean
 * what the visitor actually asked for, and duplicate-destination requests
 * are rare enough that giving up optimization for that request only is a
 * fair trade against the alternative of silently breaking round trips.
 *
 * @param {{nodes: Map, floors: Map}} graph read-only; never mutated
 * @param {string} fromId the visitor's current node
 * @param {string[]} targetIds destination node ids, in the order the visitor
 *   asked for them (NOT necessarily the order they will be visited, unless
 *   `targetIds` contains a duplicate — see above)
 * @param {{costFn?: Function|null, edgeFilter?: Function|null, profile?: object|null}} ctx
 *   the SAME cost function and edge filter a single-destination search would
 *   use for this request — see the module header for why this must never be
 *   built fresh here.
 * @returns {{ok:true, order:number[], legs:Array<{fromId:string, toId:string,
 *             targetIndex:number, path:string[], cost:number}>, path:string[]}
 *           | {ok:false, failedIndex:number, failedNodeId:string, legIndex:number}}
 *   `order`/`legs` are in VISITING order; `legs[i].targetIndex` maps back to
 *   `targetIds` so the caller can report which requested destination each
 *   leg reaches. On failure, `failedIndex`/`failedNodeId` name the first
 *   requested destination the router could not reach continuing from
 *   wherever the walk got to; `legIndex` is its position in the visiting
 *   order, in case the caller wants to describe how many stops were
 *   reachable before it.
 */
export function planMultiStop(graph, fromId, targetIds, ctx = {}) {
  const { costFn = null, edgeFilter = null, profile = null } = ctx;
  const stops = (targetIds || []).slice(0, MAX_STOPS);

  const startNode = graph.nodes.get(fromId);
  const allNodes = [startNode, ...stops.map((id) => graph.nodes.get(id))];

  const hasDuplicateStop = new Set(stops).size !== stops.length;
  let visitOrder;
  if (hasDuplicateStop) {
    // Skip the optimizer entirely — see the duplicate-destinations note
    // above. Request order is the only order that cannot silently collapse
    // a deliberate round trip.
    visitOrder = stops.map((_, i) => i);
  } else {
    const n = allNodes.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        matrix[i][j] = estimateLegCost(allNodes[i], allNodes[j], graph);
      }
    }
    // Indices into `allNodes` (0 = start, 1..n-1 = stops[0..]); visitOrder
    // drops the leading start and re-bases back to indices into `targetIds`.
    const order = orderStops(matrix, { fixedStart: 0 });
    visitOrder = order.slice(1).map((idx) => idx - 1);
  }

  const legs = [];
  let cursorId = fromId;
  for (let i = 0; i < visitOrder.length; i += 1) {
    const targetIndex = visitOrder[i];
    const toId = stops[targetIndex];
    const result = findRoute(graph, cursorId, toId, {
      accessible: false, // relaxation, if any, is the caller's fallback chain
      profile,
      costFn,
      edgeFilter,
    });
    if (!result) {
      return { ok: false, failedIndex: targetIndex, failedNodeId: toId, legIndex: i };
    }
    legs.push({
      fromId: cursorId,
      toId,
      targetIndex,
      path: result.path,
      cost: result.cost,
    });
    cursorId = toId;
  }

  const path = legs.reduce(
    (acc, leg, i) => (i === 0 ? leg.path.slice() : [...acc, ...leg.path.slice(1)]),
    []
  );

  return { ok: true, order: visitOrder, legs, path };
}

/**
 * Multi-stop analogue of `wayfinding.routes.js`'s `searchWithFallbacks`:
 * replans the WHOLE tour under successively relaxed constraints (tags, then
 * accessibility — the same strictest-first order `buildRoutingContext` hands
 * back in `fallbacks`), never just the one leg that failed.
 *
 * Per-leg relaxation was rejected on purpose: a route where leg 1 and leg 3
 * are step-free and leg 2 is not has no single honest value for
 * `accessibleRouteUnavailable`, and a warning generated for leg 2 alone has
 * no way to say which part of a multi-leg journey it belongs to once the
 * legs are spliced into one path. Replanning the whole tour keeps
 * `accessibleRouteUnavailable`/`tagConstraintsRelaxed` meaning exactly what
 * they mean for a single destination, and keeps every warning's
 * `segmentIndex` honest, because it is computed once, over the one path the
 * whole trip actually walks under the winning attempt.
 *
 * Pure routing policy — no `req`/`res`, no I/O — so it is reachable from a
 * unit test without going through HTTP. See the module header for the real
 * worst-case request cost this introduces (up to 3 full replans).
 *
 * @param {{nodes: Map, floors: Map}} graph
 * @param {string} from
 * @param {string[]} targetIds
 * @param {object|null} profile
 * @param {{edgeFilter: Function|null, costFn: Function}} strictAttempt
 * @param {Array<{label?: string, edgeFilter: Function|null, costFn: Function}>} fallbackAttempts
 *   ordered strictest-relaxation-first
 * @returns {{plan: object, tagConstraintsRelaxed: boolean,
 *            accessibleRouteUnavailable: boolean}} `plan` is whichever
 *   attempt succeeded (or the LAST, most-relaxed attempt's failure, if none
 *   did — the best information available about what actually blocked it).
 */
export function planMultiStopWithFallbacks(graph, from, targetIds, profile, strictAttempt, fallbackAttempts) {
  const attempt = (edgeFilter, costFn) =>
    planMultiStop(graph, from, targetIds, { profile, costFn, edgeFilter });

  let plan = attempt(strictAttempt.edgeFilter, strictAttempt.costFn);
  if (plan.ok) {
    return { plan, tagConstraintsRelaxed: false, accessibleRouteUnavailable: false };
  }

  let tagConstraintsRelaxed = false;
  let accessibleRouteUnavailable = false;
  for (const fallback of fallbackAttempts || []) {
    if (fallback.label === 'tagConstraintsRelaxed') tagConstraintsRelaxed = true;
    if (fallback.label === 'accessibleRouteUnavailable') accessibleRouteUnavailable = true;
    plan = attempt(fallback.edgeFilter, fallback.costFn);
    if (plan.ok) {
      return { plan, tagConstraintsRelaxed, accessibleRouteUnavailable };
    }
  }

  // Nothing worked at any relaxation level: neither flag meaningfully
  // applies to "no plan exists", same convention `searchWithFallbacks` uses.
  return { plan, tagConstraintsRelaxed: false, accessibleRouteUnavailable: false };
}
