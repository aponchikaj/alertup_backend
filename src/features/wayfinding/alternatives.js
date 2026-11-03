/**
 * Alternative evacuation exits: "the nearest way out is that way — but if it
 * is on fire, here are the next two."
 *
 * ## Why a second and third search rather than k-shortest paths
 *
 * What an occupant needs is not the second-best PATH to the same door (which
 * is usually the same corridor with one detour, and useless when the problem
 * is the door). It is a different DOOR. So each round re-runs the evacuation
 * search with the exits already offered removed from the TARGET set — not from
 * the graph. `findEvacuationRoute`'s `excludeExitIds` does exactly that, which
 * matters: the second-nearest exit is often reached by walking straight past
 * the nearest one, and blocking that node would hide the honest route.
 *
 * Two rounds, so at most two extra Dijkstras per `/evacuate` request. The
 * primary route itself comes from the distance-to-safety field and costs
 * nothing after the first build (`safetyField.js`).
 *
 * ## Why the routes are assembled here
 *
 * The wire contract is `{exitNodeId, label, floorNumber, distanceM,
 * durationSec, route}`, and `distanceM`/`durationSec` are the assembled
 * route's totals — the numbers the occupant is shown next to the button — not
 * the search's internal cost, which carries reluctance penalties that are not
 * time that passes (see `etaProfileOf` in `routeAssembler.js`). Assembling
 * here is what lets the list be ordered by the duration the UI actually
 * displays.
 *
 * Every embedded route is LEAN: `floor.drawing` is the one unbounded field on
 * a route, and an evacuation response would otherwise carry three copies of
 * every floor plan the routes touch.
 */

import { findEvacuationRoute, isEmergencyExit } from './dijkstra.js';
import { assembleRoute } from './routeAssembler.js';

/**
 * Up to `max` evacuation routes to exits OTHER than the primary one.
 *
 * @param {{nodes: Map, adj: Map, floors: Map}} graph
 * @param {string} startId the occupant's node
 * @param {object} ctx the SAME cost function and edge filter that found the
 *   primary route, plus what `assembleRoute` needs to describe it:
 *   `{profile, profileName, preference, costFn, edgeFilter, overlay,
 *     accessible, accessibleRouteUnavailable, tagConstraintsRelaxed}`.
 *   Reusing the winning attempt's filter matters: an alternative found under
 *   stricter constraints than the primary would be a route the occupant is
 *   told exists under rules the primary already proved impossible.
 * @param {{primaryExitId?: string|null, max?: number}} options
 * @returns {Array<{exitNodeId, label, floorNumber, distanceM, durationSec, route}>}
 *   ordered by `durationSec`, nearest first. Empty when the building has only
 *   one reachable exit.
 */
export function alternativeExits(graph, startId, ctx = {}, { primaryExitId = null, max = 2 } = {}) {
  const {
    profile = null,
    profileName = 'emergency',
    preference = null,
    costFn = null,
    edgeFilter = null,
    overlay = null,
    accessible = false,
    accessibleRouteUnavailable = false,
    tagConstraintsRelaxed = false,
  } = ctx;

  // A building with exactly one exit is the common case, and asking Dijkstra
  // for a second door there costs a FULL graph exploration to return nothing.
  // One O(nodes) scan settles it first.
  let hasOtherExit = false;
  for (const node of graph.nodes.values()) {
    if (isEmergencyExit(node) && node.id !== primaryExitId) {
      hasOtherExit = true;
      break;
    }
  }
  if (!hasOtherExit) return [];

  const excludeExitIds = primaryExitId ? [primaryExitId] : [];
  const offered = [];

  while (offered.length < max) {
    const result = findEvacuationRoute(graph, startId, {
      // Relaxation was already resolved by the caller's fallback chain; this
      // search runs under the winning attempt's filter, nothing looser.
      accessible: false,
      profile,
      costFn,
      edgeFilter,
      excludeExitIds,
    });
    if (!result) break;

    const { exitNodeId } = result;
    // Defensive: a target predicate that ignored the exclusions would
    // otherwise loop forever offering the same door.
    if (!exitNodeId || excludeExitIds.includes(exitNodeId)) break;
    excludeExitIds.push(exitNodeId);

    const route = assembleRoute(graph, result.path, {
      mode: 'EVACUATION',
      accessible,
      accessibleRouteUnavailable,
      profile,
      profileName,
      preference,
      tagConstraintsRelaxed,
      overlay,
      lean: true,
    });
    if (!route) continue; // unresolvable path; the exit stays excluded

    const exitNode = graph.nodes.get(exitNodeId) || null;
    offered.push({
      exitNodeId,
      label: exitNode?.label ?? null,
      floorNumber: exitNode?.floorNumber ?? null,
      distanceM: route.totalDistanceM,
      durationSec: route.totalDurationSec,
      route,
    });
  }

  return offered.sort((a, b) => a.durationSec - b.durationSec);
}

export default alternativeExits;
