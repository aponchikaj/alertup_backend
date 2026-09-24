/**
 * Pure query parsing and Dijkstra filter/cost assembly for named routing
 * profiles, tag preferences and visibility rules.
 *
 * No I/O, no Prisma: `parseRoutingQuery` only ever sees `req.query` (already
 * parsed by Express), and `buildRoutingContext` only ever sees an in-memory
 * graph (`graphService.loadBuildingGraph` output, or the `buildGraph` test
 * fixture) plus plain option objects. Both are safe to unit test directly and
 * safe to call once per request.
 *
 * ## Overlay shape (produced by B7's closures feature)
 *
 * `buildRoutingContext`'s `overlay` option is `null` (no active closures) or:
 *
 *   {
 *     edgeMultiplier:  Map<edgeId, number>,  // cost is multiplied by this
 *     blockedEdgeIds:  Set<edgeId>,          // edge is never traversable
 *     blockedNodeIds:  Set<nodeId>,          // node is never traversable
 *   }
 *
 * The multiplier is folded into `costFn` (and every fallback's `costFn`,
 * since they all share the same one); the two block sets are folded into
 * `edgeFilter`/`strictEdgeFilter` (and every fallback's `edgeFilter`, via the
 * shared `baseFilter` below) so closures apply no matter which fallback in
 * the chain ends up finding a route.
 *
 * ## Fallback chain
 *
 * A request's constraints are tried strictest first, relaxing one layer at a
 * time until a route is found:
 *
 *   1. strict            — tags (include/exclude) + accessibility + visibility + overlay
 *   2. tagConstraintsRelaxed   — drop tag constraints, keep accessibility + visibility + overlay
 *   3. accessibleRouteUnavailable — drop accessibility too, keep visibility + overlay
 *
 * Visibility and the overlay's closures are never relaxed at any step — a
 * STAFF-only corridor or a closed edge stays off-limits even when nothing
 * else can be found.
 */

import { PROFILE_NAMES, resolveProfile, makeCostFn } from './costModel.js';

const DEFAULT_PROFILE_NAME = PROFILE_NAMES[0];
const VALID_SRC = new Set(['sticker', 'kiosk', 'web', 'scan', 'ai']);
const DEFAULT_SRC = 'web';

const isTruthyFlag = (raw) => raw === true || raw === 'true' || raw === '1' || raw === 1;

/** Comma-separated and/or repeated query params, both -> a flat, trimmed list. */
function parseTagList(raw) {
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((v) => String(v).split(','))
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseHeading(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const heading = Math.trunc(n);
  if (heading < 0 || heading > 359) return null;
  return heading;
}

function parseSrc(raw) {
  return typeof raw === 'string' && VALID_SRC.has(raw) ? raw : DEFAULT_SRC;
}

/**
 * Parse `/api/wayfinding/route` (and `/evacuate`, and the QR scan route)
 * query params into a validated, typed shape.
 *
 * @param {object} query `req.query`
 * @returns {{ok:true, status:null, name:string, includeTags:string[],
 *             excludeTags:string[], heading:number|null, src:string, error:null}
 *           | {ok:false, status:400, name:null, includeTags:[], excludeTags:[],
 *              heading:null, src:string, error:string}}
 */
export function parseRoutingQuery(query = {}) {
  const q = query || {};
  const accessible = isTruthyFlag(q.accessible);
  const requestedName = accessible
    ? 'wheelchair'
    : typeof q.profile === 'string' && q.profile
      ? q.profile
      : DEFAULT_PROFILE_NAME;

  if (!PROFILE_NAMES.includes(requestedName)) {
    return {
      ok: false,
      status: 400,
      name: null,
      includeTags: [],
      excludeTags: [],
      heading: null,
      src: parseSrc(q.src),
      error: `Unknown routing profile "${requestedName}".`,
    };
  }

  return {
    ok: true,
    status: null,
    name: requestedName,
    includeTags: parseTagList(q.includeTags),
    excludeTags: parseTagList(q.excludeTags),
    heading: parseHeading(q.heading),
    src: parseSrc(q.src),
    error: null,
  };
}

/**
 * `PUBLIC` is visible to everyone; `EMERGENCY_ONLY` only surfaces for the
 * `emergency` profile; `STAFF` only surfaces for the staff audience. Any
 * other/missing value (a corrupt row, a future enum member) is treated as
 * `PUBLIC` rather than silently stranding a route on unrecognised data.
 *
 * @param {'PUBLIC'|'STAFF'|'EMERGENCY_ONLY'|null|undefined} visibility
 * @param {{name:string, audience?:'public'|'staff'}} ctx
 */
export function visibilityAllowed(visibility, { name, audience = 'public' } = {}) {
  switch (visibility) {
    case 'EMERGENCY_ONLY':
      return name === 'emergency';
    case 'STAFF':
      return audience === 'staff';
    default:
      return true;
  }
}

/**
 * AND-combine any number of Dijkstra edgeFilters, skipping falsy ones.
 * Returns `null` (meaning "no filter") when nothing is left to combine, so
 * the result can be handed straight to `shortestPath`/`findRoute`.
 */
export function composeFilters(...filters) {
  const active = filters.filter(Boolean);
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];
  return (edge, from, to) => active.every((filter) => filter(edge, from, to));
}

/** Visibility must hold for both the edge itself and the node it leads to. */
function makeVisibilityFilter(graph, { name, audience }) {
  return (edge) => {
    if (!visibilityAllowed(edge.visibility, { name, audience })) return false;
    const targetNode = graph.nodes.get(edge.to);
    return visibilityAllowed(targetNode?.visibility, { name, audience });
  };
}

/** `includeTags`/`excludeTags` as a single edge predicate, or `null` if unused. */
function makeTagFilter(includeTags, excludeTags) {
  const include = includeTags || [];
  const exclude = excludeTags || [];
  if (include.length === 0 && exclude.length === 0) return null;

  return (edge) => {
    const tags = edge.tags || [];
    if (exclude.length > 0 && tags.some((tag) => exclude.includes(tag))) return false;
    if (include.length > 0 && !include.some((tag) => tags.includes(tag))) return false;
    return true;
  };
}

/** Mirrors dijkstra.js's accessibility rule, gated on the resolved profile. */
function makeAccessibilityFilter(profile) {
  if (!profile.requireAccessible) return null;
  return (edge) => edge.accessible !== false;
}

/** Closures (B7): block specific edges/nodes outright. `null` if no overlay. */
function makeOverlayFilter(overlay) {
  const blockedEdgeIds = overlay?.blockedEdgeIds;
  const blockedNodeIds = overlay?.blockedNodeIds;
  const hasBlockedEdges = Boolean(blockedEdgeIds?.size);
  const hasBlockedNodes = Boolean(blockedNodeIds?.size);
  if (!hasBlockedEdges && !hasBlockedNodes) return null;

  return (edge, from) => {
    if (hasBlockedEdges && blockedEdgeIds.has(edge.edgeId)) return false;
    if (hasBlockedNodes && blockedNodeIds.has(edge.to)) return false;
    if (hasBlockedNodes && from && blockedNodeIds.has(from.id)) return false;
    return true;
  };
}

/** Closures (B7): scale an edge's cost. Identity function if no overlay. */
function makeOverlayCostFn(baseCostFn, overlay) {
  const multipliers = overlay?.edgeMultiplier;
  if (!multipliers || multipliers.size === 0) return baseCostFn;

  return (edge, from, to) => {
    const base = baseCostFn(edge, from, to);
    if (!Number.isFinite(base)) return base;
    const multiplier = multipliers.get(edge.edgeId);
    return Number.isFinite(multiplier) && multiplier > 0 ? base * multiplier : base;
  };
}

/**
 * Assemble everything a route search needs for a named profile: the cost
 * function, the strict edge filter, and a fallback chain to walk through
 * when the strict search finds nothing.
 *
 * @param {{nodes:Map, routingProfile:object|null}} graph
 * @param {{name:string, includeTags?:string[], excludeTags?:string[],
 *          audience?:'public'|'staff', overlay?:object|null}} options
 * @returns {{ok:true, status:null, name:string, profile:object, costFn:Function,
 *             edgeFilter:Function|null, strictEdgeFilter:Function|null,
 *             fallbacks:Array<{label:string, edgeFilter:Function|null, costFn:Function}>}
 *           | {ok:false, status:400, error:string}}
 */
export function buildRoutingContext(
  graph,
  { name, includeTags = [], excludeTags = [], audience = 'public', overlay = null } = {}
) {
  if (!PROFILE_NAMES.includes(name)) {
    return { ok: false, status: 400, error: `Unknown routing profile "${name}".` };
  }

  const profile = resolveProfile(graph.routingProfile, name);
  const costFn = makeOverlayCostFn(makeCostFn(profile), overlay);

  // Visibility and closures apply at every relaxation step — they are never
  // part of what gets relaxed.
  const baseFilter = composeFilters(
    makeVisibilityFilter(graph, { name, audience }),
    makeOverlayFilter(overlay)
  );

  const tagFilter = makeTagFilter(includeTags, excludeTags);
  const accessibilityFilter = makeAccessibilityFilter(profile);

  const strictEdgeFilter = composeFilters(baseFilter, tagFilter, accessibilityFilter);

  const fallbacks = [];
  if (tagFilter) {
    fallbacks.push({
      label: 'tagConstraintsRelaxed',
      edgeFilter: composeFilters(baseFilter, accessibilityFilter),
      costFn,
    });
  }
  if (accessibilityFilter) {
    fallbacks.push({
      label: 'accessibleRouteUnavailable',
      edgeFilter: baseFilter,
      costFn,
    });
  }

  return {
    ok: true,
    status: null,
    name,
    profile,
    costFn,
    edgeFilter: strictEdgeFilter,
    strictEdgeFilter,
    fallbacks,
  };
}
