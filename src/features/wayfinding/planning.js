import { findRoute, findEvacuationRoute } from './dijkstra.js';
import { getSafetyField, pathFromField } from './safetyField.js';
import { alternativeExits } from './alternatives.js';
import { assembleRoute } from './routeAssembler.js';
import { composeFilters, makeOverlayCostFn } from './profiles.js';
import { buildOverlay, applyOverlay, publicClosure } from './closures.js';
import { resolveProfile, makeCostFn } from './costModel.js';

/* ============================================================================
   Route planning shared by every surface that answers "how do I get there"
   or "how do I get out".

   FX-002/FX-010: `/evacuate` and the QR scan route each carried their own
   copy of the evacuation logic, and the AI wayfinder tools and the
   evacuation brief carried none of it — they searched with no closures and
   no visibility rules, so during an incident the AI could name an exit
   behind a closed corridor while the red line on screen led elsewhere. One
   function per question now, and every surface calls it.
   ========================================================================= */

/**
 * Try the strict attempt first, then each fallback attempt in order, until
 * `search` finds a route.
 *
 * The chain relaxes CUMULATIVELY — the constraint order must go from
 * strictest to most relaxed, tags before accessibility, so a fallback never
 * re-imposes something an earlier one already dropped. Because of that, a
 * route found at fallback N has had every constraint dropped by fallbacks
 * 1..N, not just fallback N's own — so the returned flags are the union of
 * every `label` seen at or before the winning attempt, not just the winning
 * one's. Reporting only the winning label under-reports: a route that only
 * succeeds once BOTH tags and accessibility are gone must say so on both
 * flags, or the visitor is told a constraint held when it didn't.
 *
 * @param {{edgeFilter:Function|null, costFn:Function}} strictAttempt
 * @param {Array<{label?:'tagConstraintsRelaxed'|'accessibleRouteUnavailable',
 *                 edgeFilter:Function|null, costFn:Function}>} fallbackAttempts
 *   ordered strictest-relaxation-first
 * @param {(edgeFilter:Function|null, costFn:Function) => object|null} search
 * @returns {{result:object|null, tagConstraintsRelaxed:boolean,
 *            accessibleRouteUnavailable:boolean, edgeFilter:Function|null,
 *            costFn:Function}}
 *   `edgeFilter`/`costFn` are the WINNING attempt's, so a follow-up search
 *   for the same request (alternative exits) runs under the constraints the
 *   route was actually found under — searching an alternative under stricter
 *   rules than the primary would offer a door the primary already proved
 *   unreachable under those rules.
 */
export function searchWithFallbacks(strictAttempt, fallbackAttempts, search) {
  const strictResult = search(strictAttempt.edgeFilter, strictAttempt.costFn);
  if (strictResult) {
    return {
      result: strictResult,
      tagConstraintsRelaxed: false,
      accessibleRouteUnavailable: false,
      edgeFilter: strictAttempt.edgeFilter,
      costFn: strictAttempt.costFn,
    };
  }

  let tagConstraintsRelaxed = false;
  let accessibleRouteUnavailable = false;
  for (const attempt of fallbackAttempts) {
    if (attempt.label === 'tagConstraintsRelaxed') tagConstraintsRelaxed = true;
    if (attempt.label === 'accessibleRouteUnavailable') accessibleRouteUnavailable = true;
    const result = search(attempt.edgeFilter, attempt.costFn);
    if (result) {
      return {
        result,
        tagConstraintsRelaxed,
        accessibleRouteUnavailable,
        edgeFilter: attempt.edgeFilter,
        costFn: attempt.costFn,
      };
    }
  }
  return {
    result: null,
    tagConstraintsRelaxed: false,
    accessibleRouteUnavailable: false,
    edgeFilter: strictAttempt.edgeFilter,
    costFn: strictAttempt.costFn,
  };
}

const NO_TAGS = Object.freeze([]);

/**
 * D14 / FX-045 (founder decision 2026-11-03): the cost multiplier a blocked
 * closure carries in the last-resort search. High enough that the route
 * crosses as few closed areas as it can (one closed corridor beats any
 * plausible open detour of up to ~100x its length), finite so a way out
 * still exists.
 */
export const LAST_RESORT_CLOSURE_PENALTY = 100;

export const ROUTE_THROUGH_CLOSURE_WARNING = Object.freeze({
  code: 'ROUTE_THROUGH_CLOSURE',
  message:
    'Every exit is behind a closed area. This is the least-blocked way out: move with caution and follow staff instructions.',
});

/**
 * The same overlay with every hard block turned into a heavy penalty. A
 * blocked node becomes a penalty on each edge touching it (a penalty has no
 * node channel). Existing penalties compound on top.
 */
function softenOverlay(overlay, graph) {
  const edgeMultiplier = new Map(overlay?.edgeMultiplier ?? []);
  const penalize = (edgeId) =>
    edgeMultiplier.set(edgeId, (edgeMultiplier.get(edgeId) ?? 1) * LAST_RESORT_CLOSURE_PENALTY);

  for (const edgeId of overlay?.blockedEdgeIds ?? []) penalize(edgeId);
  const blockedNodeIds = overlay?.blockedNodeIds ?? new Set();
  if (blockedNodeIds.size > 0) {
    for (const edge of graph.edgesById?.values() ?? []) {
      if (blockedNodeIds.has(edge.sourceNodeId) || blockedNodeIds.has(edge.targetNodeId)) {
        penalize(edge.edgeId);
      }
    }
  }
  const fingerprint = `soft|${[...edgeMultiplier].map(([id, m]) => `${id}:${m}`).sort().join('|')}`;
  return { edgeMultiplier, blockedEdgeIds: new Set(), blockedNodeIds: new Set(), fingerprint };
}

/**
 * Last resort when closures leave no exit at all: route under the emergency
 * profile's visibility and lift block with every closure softened into a
 * heavy penalty, tags and accessibility dropped. Never used when anything
 * else found a route.
 */
function lastResortEvacuation(graph, overlay, originId) {
  const hasBlocks = (overlay?.blockedEdgeIds?.size ?? 0) > 0 || (overlay?.blockedNodeIds?.size ?? 0) > 0;
  if (!hasBlocks) return null;

  const softened = softenOverlay(overlay, graph);
  const context = applyOverlay({ graph, name: 'emergency' }, softened, { originId });
  if (!context.ok) return null;

  const result = findEvacuationRoute(graph, originId, {
    accessible: false,
    profile: context.profile,
    costFn: context.costFn,
    edgeFilter: context.strictEdgeFilter,
  });
  return result ? { result, context } : null;
}

/**
 * The evacuation route for one occupant right now.
 *
 * LIFE-SAFETY RULE: visibility (EMERGENCY_ONLY edges) and blocking
 * (elevators, unless the building says its cars are evacuation rated) always
 * come from the `emergency` profile — never from a requested profile.
 * `wheelchair` layers an accessibility REQUIREMENT on top, with its own
 * last-resort fallback that drops it; any other named profile contributes its
 * COST preferences only (`transitMultiplier`, `floorChangePenaltySec`), so it
 * can steer between two legal routes but never open a blocked or hidden one.
 *
 * @param {object} args
 * @param {object} args.graph            building graph from `getGraph`
 * @param {Array}  args.activeClosures   rows from `getActiveClosures`
 * @param {string} args.originId         node the occupant is standing at
 * @param {object} [args.query]
 * @param {string|null} [args.query.name]        parsed profile name ('wheelchair', 'walk', …)
 * @param {boolean} [args.query.explicitProfile] true when the caller named a profile outright
 * @param {string[]} [args.query.includeTags]
 * @param {string[]} [args.query.excludeTags]
 * @param {number|null} [args.query.heading]
 * @param {boolean} [args.withAlternatives=true]
 * @returns {{ok:false, status:number, error:string} |
 *           {ok:true, found:boolean, result:object|null, route:object|null,
 *            closures:Array, profileName:'wheelchair'|'emergency',
 *            wheelchairRequested:boolean, costOverlayName:string|null}}
 */
export function planEvacuation({ graph, activeClosures, originId, query = {}, withAlternatives = true }) {
  const includeTags = query.includeTags ?? NO_TAGS;
  const excludeTags = query.excludeTags ?? NO_TAGS;
  const closures = activeClosures.map(publicClosure);
  const overlay = buildOverlay(activeClosures, graph);

  // `name` is always 'emergency': visibility, blockedTransit and the fallback
  // chain all come from it. The occupant's own node stays reachable even if a
  // closure covers it — someone standing in the area that was just closed
  // must still get an exit, not a dead end.
  const context = applyOverlay(
    { graph, name: 'emergency', includeTags, excludeTags },
    overlay,
    { originId }
  );
  if (!context.ok) return { ok: false, status: context.status, error: context.error };

  const wheelchairRequested = query.name === 'wheelchair';
  const profileName = wheelchairRequested ? 'wheelchair' : 'emergency';
  const explicitProfileName = query.explicitProfile && query.name ? query.name : null;
  // Anything other than wheelchair/emergency contributes cost knobs only —
  // never its own visibility or blockedTransit.
  const costOverlayName =
    explicitProfileName && explicitProfileName !== 'wheelchair' && explicitProfileName !== 'emergency'
      ? explicitProfileName
      : null;

  let effectiveProfile = context.profile;
  let effectiveCostFn = context.costFn;
  if (costOverlayName) {
    const requestedProfile = resolveProfile(graph.routingProfile, costOverlayName);
    effectiveProfile = {
      ...context.profile,
      transitMultiplier: requestedProfile.transitMultiplier,
      floorChangePenaltySec: requestedProfile.floorChangePenaltySec,
    };
    // Rebuilt from the layered profile, then re-wrapped with the overlay:
    // `makeCostFn` alone knows nothing about closures, so without the re-wrap
    // a closure's penalty would silently stop applying the moment anyone
    // passed a profile. (Its hard block holds either way — that lives in the
    // edge filter, not the cost.)
    effectiveCostFn = makeOverlayCostFn(makeCostFn(effectiveProfile), context.overlay);
  }

  // Layered on top of `emergency`'s strict filter/fallbacks, strictest
  // relaxation first: tags before accessibility, so an evacuating wheelchair
  // user only loses the accessibility requirement as an absolute last resort.
  // `context.fallbacks` alone (emergency has no accessibility filter of its
  // own) only ever represents "tags dropped" here, so when wheelchair is
  // requested it's composed with `requireAccessible` to keep accessibility in
  // force through that step; the accessibility-drop step is appended strictly
  // after it, built from whichever filter that step would have used.
  const requireAccessible = (edge) => edge.accessible !== false;
  const strictEdgeFilter = wheelchairRequested
    ? composeFilters(context.strictEdgeFilter, requireAccessible)
    : context.strictEdgeFilter;
  const tagRelaxedFallbacks = context.fallbacks.map((fb) => ({
    label: fb.label,
    edgeFilter: wheelchairRequested ? composeFilters(fb.edgeFilter, requireAccessible) : fb.edgeFilter,
    costFn: effectiveCostFn,
  }));
  const bottomEdgeFilter =
    context.fallbacks.length > 0
      ? context.fallbacks[context.fallbacks.length - 1].edgeFilter
      : context.strictEdgeFilter;
  const accessibilityDroppedFallback = wheelchairRequested
    ? [{ label: 'accessibleRouteUnavailable', edgeFilter: bottomEdgeFilter, costFn: effectiveCostFn }]
    : [];
  const fallbacks = [...tagRelaxedFallbacks, ...accessibilityDroppedFallback];

  // B9: the primary route comes from the distance-to-safety field — ONE
  // reverse Dijkstra from the virtual super-exit, cached per (graph object,
  // variant, closure fingerprint), after which every occupant's route is a
  // pointer walk. During a real incident hundreds of people ask this question
  // within seconds over the same graph; the field turns that from N searches
  // into one.
  //
  // Two cases still go through the forward Dijkstra chain:
  //   - `wheelchair`, whose strict attempt and accessibility-drop fallback are
  //     a relaxation LADDER, not a single cost function;
  //   - an origin whose own node is closed. `applyOverlay` lifts that block
  //     for this occupant only, which changes the edge filter WITHOUT changing
  //     the overlay fingerprint, so sharing the cache key would hand the next
  //     occupant a field built under an exemption that is not theirs.
  const originExempted = Boolean(overlay?.blockedNodeIds?.has(originId));
  const useField = !wheelchairRequested && !originExempted;
  // Everything that changes the field: the emergency profile, any layered cost
  // preference, and the tag constraints folded into the strict filter. Same
  // key on every surface, so equivalent requests share one cached field.
  const fieldVariant = ['emergency', costOverlayName ?? '', includeTags.join(','), excludeTags.join(',')].join(
    '#'
  );

  let result = useField
    ? pathFromField(
        getSafetyField(
          graph,
          { name: fieldVariant, costFn: effectiveCostFn, edgeFilter: strictEdgeFilter },
          { fingerprint: context.overlay?.fingerprint ?? '' }
        ),
        originId
      )
    : null;
  // A field hit IS the strict attempt: same cost function, same filter, so
  // nothing was relaxed to find it.
  let tagConstraintsRelaxed = false;
  let accessibleRouteUnavailable = false;
  let searchEdgeFilter = strictEdgeFilter;
  let searchCostFn = effectiveCostFn;

  if (!result) {
    const attempt = searchWithFallbacks(
      { edgeFilter: strictEdgeFilter, costFn: effectiveCostFn },
      fallbacks,
      (edgeFilter, costFn) =>
        findEvacuationRoute(graph, originId, {
          accessible: false, // relaxation is driven by the fallback chain above
          profile: effectiveProfile,
          costFn,
          edgeFilter,
        })
    );
    result = attempt.result;
    tagConstraintsRelaxed = attempt.tagConstraintsRelaxed;
    accessibleRouteUnavailable = attempt.accessibleRouteUnavailable;
    searchEdgeFilter = attempt.edgeFilter;
    searchCostFn = attempt.costFn;
  }

  const base = { ok: true, closures, profileName, wheelchairRequested, costOverlayName };
  if (!result) {
    // D14: closures leave no way out. Offer the least-closed one, flagged.
    const lastResort = lastResortEvacuation(graph, overlay, originId);
    if (!lastResort) return { ...base, found: false, result: null, route: null };

    const route = assembleRoute(graph, lastResort.result.path, {
      mode: 'EVACUATION',
      accessible: wheelchairRequested,
      accessibleRouteUnavailable: wheelchairRequested,
      profile: lastResort.context.profile,
      profileName,
      tagConstraintsRelaxed: includeTags.length > 0 || excludeTags.length > 0,
      // The softened overlay, so every closed edge on the path gets its own
      // CLOSURE_ON_ROUTE warning at the right distance.
      overlay: lastResort.context.overlay,
      heading: query.heading,
    });
    if (!route) return { ...base, found: false, result: null, route: null };
    route.closuresIgnored = true;
    route.warnings = [{ ...ROUTE_THROUGH_CLOSURE_WARNING }, ...(route.warnings ?? [])];
    route.closures = closures;
    // No alternatives: every other door is just as blocked.
    if (withAlternatives) route.alternatives = [];
    return { ...base, found: true, closuresIgnored: true, result: lastResort.result, route };
  }

  const route = assembleRoute(graph, result.path, {
    mode: 'EVACUATION',
    accessible: wheelchairRequested,
    accessibleRouteUnavailable,
    profile: effectiveProfile,
    // Stays inside the closed RouteProfile union the frontend switches on
    // (the emergency banner's danger framing keys off `profile ===
    // 'emergency'`); the layered cost preference rides `preference` instead.
    profileName,
    preference: costOverlayName,
    tagConstraintsRelaxed,
    overlay: context.overlay,
    heading: query.heading,
  });
  if (!route) return { ...base, found: false, result: null, route: null };
  route.closures = closures;

  if (withAlternatives) {
    // B9: "if that door is blocked, try these". Searched under the SAME
    // constraints that found the primary (the winning attempt's filter and
    // cost), so an alternative can never be a door the primary was already
    // told it could not use.
    route.alternatives = alternativeExits(
      graph,
      originId,
      {
        profile: effectiveProfile,
        profileName,
        preference: costOverlayName,
        costFn: searchCostFn,
        edgeFilter: searchEdgeFilter,
        overlay: context.overlay,
        accessible: wheelchairRequested,
        accessibleRouteUnavailable,
        tagConstraintsRelaxed,
      },
      { primaryExitId: result.exitNodeId, max: 2 }
    );
    // An embedded route travels alone — the frontend normalizes each one on
    // its own, so it carries the same closure list the primary does.
    for (const alternative of route.alternatives) {
      alternative.route.closures = closures;
    }
  }

  return { ...base, found: true, result, route };
}

/**
 * The single-destination A→B route under a named profile, with closures and
 * the profile's own visibility rules and fallback chain applied.
 *
 * @param {object} args
 * @param {object} args.graph
 * @param {Array}  args.activeClosures
 * @param {string} args.originId
 * @param {string} args.targetId
 * @param {object} [args.query]  `{ name, includeTags, excludeTags, heading }`
 * @param {object|null} [args.destinationPoi]
 * @returns {{ok:false, status:number, error:string, profileName:string} |
 *           {ok:true, found:boolean, result:object|null, route:object|null,
 *            closures:Array, profileName:string}}
 */
export function planRoute({ graph, activeClosures, originId, targetId, query = {}, destinationPoi = null }) {
  const closures = activeClosures.map(publicClosure);
  const overlay = buildOverlay(activeClosures, graph);

  const context = applyOverlay(
    {
      graph,
      name: query.name,
      includeTags: query.includeTags ?? NO_TAGS,
      excludeTags: query.excludeTags ?? NO_TAGS,
    },
    overlay,
    { originId }
  );
  if (!context.ok) {
    return { ok: false, status: context.status, error: context.error, profileName: query.name };
  }

  const accessible = context.name === 'wheelchair';

  // `context.fallbacks` is already ordered strictest-relaxation-first (tags
  // before accessibility — see `buildRoutingContext`), which is exactly what
  // cumulative flag tracking requires.
  const { result, tagConstraintsRelaxed, accessibleRouteUnavailable } = searchWithFallbacks(
    { edgeFilter: context.strictEdgeFilter, costFn: context.costFn },
    context.fallbacks,
    (edgeFilter, costFn) =>
      findRoute(graph, originId, targetId, {
        accessible: false, // relaxation is driven by the fallback chain above
        profile: context.profile,
        costFn,
        edgeFilter,
      })
  );

  const base = { ok: true, closures, profileName: context.name };
  if (!result) return { ...base, found: false, result: null, route: null };

  const route = assembleRoute(graph, result.path, {
    mode: 'WAYFINDING',
    destinationPoi,
    accessible,
    accessibleRouteUnavailable,
    profile: context.profile,
    profileName: context.name,
    tagConstraintsRelaxed,
    // The ORIGIN-ADJUSTED overlay, so the warnings describe the same
    // restrictions the search actually ran under.
    overlay: context.overlay,
    // Which way the visitor's phone says they are pointing, so the opening
    // instruction can be "turn right, then go 20 m".
    heading: query.heading,
  });
  if (!route) return { ...base, found: false, result: null, route: null };
  // Also on the route itself: the frontend normalizes `route.closures`, and a
  // route handed to the AI or embedded as an alternative travels alone.
  route.closures = closures;

  return { ...base, found: true, result, route };
}
