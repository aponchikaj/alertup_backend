/**
 * Turns a `planMultiStop`/`planMultiStopWithFallbacks` result into the
 * multi-stop wire payload: the same route shape `assembleRoute` already
 * produces for one destination, plus `legs[]` and `stops[]`.
 *
 * Split out of `wayfinding.routes.js` (which only wires HTTP: parsing the
 * query, resolving destinations, building the routing context) so this pure
 * payload-shaping logic is reachable from a unit test without a request.
 */

import { assembleRoute } from './routeAssembler.js';

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {{nodes: Map, floors: Map}} graph
 * @param {{ok:true, legs:Array<object>, path:string[]}} plan a SUCCESSFUL
 *   `planMultiStop`/`planMultiStopWithFallbacks` result
 * @param {object} opts
 *   - resolvedStops: the array `wayfinding.routes.js` built by resolving
 *     every `to` token — `resolvedStops[leg.targetIndex].poi` is the POI
 *     summary from `resolveDestination`, if any (`null` for a raw node id)
 *   - accessible / accessibleRouteUnavailable / tagConstraintsRelaxed: the
 *     flags the winning search attempt produced — see
 *     `planMultiStopWithFallbacks`
 *   - profile / profileName: the resolved routing profile and its name
 *   - overlay: the closure overlay the search ran under
 *   - heading: the visitor's compass bearing, if any (applied to the
 *     FIRST leg's opening instruction only, same as a single-destination
 *     route)
 * @returns {object} an `assembleRoute`-shaped route, plus `legs[]`/`stops[]`
 */
export function assembleMultiStopRoute(
  graph,
  plan,
  {
    resolvedStops = [],
    accessible = false,
    accessibleRouteUnavailable = false,
    tagConstraintsRelaxed = false,
    profile = null,
    profileName = null,
    overlay = null,
    heading = null,
  } = {}
) {
  const poiFor = (nodeId, resolvedPoi) => {
    if (resolvedPoi) return resolvedPoi;
    const node = graph.nodes.get(nodeId);
    return node?.poi ? { id: node.poi.id, name: node.poi.name, category: node.poi.category } : null;
  };

  // Each leg is assembled exactly the way a single-destination request
  // assembles ITS route (same function, same overlay, same profile) — just
  // once per leg, lean, purely to read off the numbers a stop card needs
  // (distance/time/POI). This is what guarantees every stop has a REAL,
  // localized "arrive" moment behind it rather than a hand-rolled estimate.
  const legRoutes = plan.legs.map((leg) => {
    const poi = poiFor(leg.toId, resolvedStops[leg.targetIndex]?.poi);
    return assembleRoute(graph, leg.path, {
      mode: 'WAYFINDING',
      destinationPoi: poi,
      accessible,
      accessibleRouteUnavailable,
      profile,
      profileName,
      tagConstraintsRelaxed,
      overlay,
      lean: true,
    });
  });

  // The trip actually shown on the map — segments, transitions, steps,
  // instructions, totals — is assembled ONCE over the full concatenated
  // path, the exact same call a single-destination route makes, just over a
  // longer path. That is what keeps a multi-stop route rendering identically
  // to any other route rather than inventing a second payload shape for it.
  const lastLeg = plan.legs[plan.legs.length - 1];
  const finalPoi = poiFor(lastLeg.toId, resolvedStops[lastLeg.targetIndex]?.poi);
  const route = assembleRoute(graph, plan.path, {
    mode: 'WAYFINDING',
    destinationPoi: finalPoi,
    accessible,
    accessibleRouteUnavailable,
    profile,
    profileName,
    tagConstraintsRelaxed,
    overlay,
    heading,
  });

  route.legs = legRoutes.map((legRoute, i) => ({
    index: i,
    fromNodeId: plan.legs[i].fromId,
    toNodeId: plan.legs[i].toId,
    poi: legRoute.destination.poi,
    distanceM: legRoute.totalDistanceM,
    durationSec: legRoute.totalDurationSec,
  }));

  let distanceSoFar = 0;
  let durationSoFar = 0;
  route.stops = route.legs.map((leg) => {
    distanceSoFar = round1(distanceSoFar + leg.distanceM);
    durationSoFar += leg.durationSec;
    return {
      stopIndex: leg.index,
      nodeId: leg.toNodeId,
      poi: leg.poi,
      distanceFromStartM: distanceSoFar,
      durationFromStartSec: durationSoFar,
    };
  });

  // `stops[]` above is the ONLY reliable source of stop order/ETA — this
  // loop is a pure convenience on top of it, for a stepper that wants an
  // inline "stop 2 of 3" without cross-referencing two arrays. It only fires
  // when the full-path geometry happens to produce a maneuver exactly at a
  // stop's node; a stop that is a straight pass-through gets no matching
  // instruction at all. A consumer MUST read `stops[]` for stop positions
  // and must never assume every stop has one — `stopIndex` on an
  // instruction is a bonus when present, not a contract.
  for (const stop of route.stops) {
    const instruction = route.instructions.find((i) => i.atNodeId === stop.nodeId);
    if (instruction) instruction.stopIndex = stop.stopIndex;
  }

  return route;
}
