import prisma from '../../db/prisma.js';
import { buildRoutingContext } from './profiles.js';

/**
 * Route-time closures: temporary restrictions an owner puts on part of the
 * graph during an incident — a flooded corridor, a lift out of service, a
 * floor the fire service has sealed.
 *
 * ## Why this cache is separate from `graphCache`
 *
 * The graph changes when someone edits the map: rarely, deliberately, and
 * always through a write that can invalidate it. Closures change on an
 * incident cadence — someone types a reason on their phone while standing in
 * front of the problem — and, unlike the graph, what counts as "active"
 * depends on `now`: a closure can expire with no write at all.
 *
 * So the two are cached separately and differently:
 *
 *   - 15 s TTL (vs the graph's 60 s), plus explicit `invalidateClosures` on
 *     every write, so a new closure reaches the router immediately and a
 *     closure created on another process still lands within seconds.
 *   - The cache holds ROWS, not the active subset. Filtering by `now` happens
 *     on every read, outside the cache, so a closure that expires mid-TTL
 *     stops applying the moment it expires without anyone flushing anything.
 *
 * Two shape-level caveats are INHERITED from `graphCache.js` and are
 * deliberately not solved differently here, so that one fix can land in both:
 *
 *   - Read/write race: an `invalidateClosures` that lands while a fetch is in
 *     flight is overwritten when that fetch resolves, leaving a stale entry
 *     for up to the TTL. Bounded at 15 s here vs the graph's 60 s.
 *   - No in-flight dedup: N concurrent misses for one building issue N
 *     queries rather than sharing one promise.
 *
 * Both want the same fix (store the in-flight promise and stamp it with an
 * invalidation epoch); doing it in one module and not the other is how the
 * two drift apart.
 */

const TTL_MS = 15 * 1000;
const MAX_ENTRIES = 50;
/** Per building. A real incident has a handful of closures, not hundreds. */
const MAX_ROWS = 500;

const cache = new Map(); // buildingId -> { rows, loadedAt }

const asDate = (value) => (value instanceof Date ? value : new Date(value));

/**
 * Every closure for the building that is in force at `now`.
 *
 * The DB query fetches everything not already expired at fetch time (future
 * starts included — a closure scheduled to begin inside the TTL window must
 * not need a flush either); `now` then selects the active subset.
 *
 * @param {string} buildingId
 * @param {Date} [now]
 * @returns {Promise<Array<object>>} Closure rows, oldest start first
 */
export async function getActiveClosures(buildingId, now = new Date()) {
  const id = String(buildingId);
  const entry = cache.get(id);

  let rows;
  if (entry && Date.now() - entry.loadedAt < TTL_MS) {
    cache.delete(id); // refresh LRU position
    cache.set(id, entry);
    rows = entry.rows;
  } else {
    const fetchedAt = new Date();
    rows = await prisma.closure.findMany({
      where: {
        buildingId: id,
        OR: [{ endsAt: null }, { endsAt: { gt: fetchedAt } }],
      },
      orderBy: { startsAt: 'asc' },
      // Bounded like every other public read: a building with a runaway
      // closure list must not turn one route request into an unbounded load.
      take: MAX_ROWS,
    });
    cache.delete(id);
    cache.set(id, { rows, loadedAt: Date.now() });
    while (cache.size > MAX_ENTRIES) {
      cache.delete(cache.keys().next().value);
    }
  }

  const at = asDate(now);
  return rows.filter(
    (row) => asDate(row.startsAt) <= at && (row.endsAt === null || asDate(row.endsAt) > at)
  );
}

/** Drop a building's cached closure rows. Every closure write calls this. */
export function invalidateClosures(buildingId) {
  cache.delete(String(buildingId));
}

/** Test seam, mirroring `graphCache.clearAll`. */
export function clearAllClosures() {
  cache.clear();
}

/**
 * Resolve closure rows against a loaded graph into the overlay shape
 * `profiles.buildRoutingContext` folds into its cost function and edge
 * filters: `{edgeMultiplier, blockedEdgeIds, blockedNodeIds, fingerprint}`.
 *
 * Scoping, narrowest first:
 *   - `edgeIds` / `nodeIds` — exactly those, when either is non-empty.
 *   - `floorId` alone — every edge with BOTH ends on that floor. An edge with
 *     one end elsewhere (the staircase off the floor) stays open: closing a
 *     floor must not seal the people on it in.
 *
 * `costMultiplier === null` means blocked outright; a number scales the
 * edge's cost. A block always beats a penalty on the same edge, and two
 * penalties on one edge compound — two independent restrictions on the same
 * corridor are worse than either alone.
 *
 * Blocked NODES stay in `blockedNodeIds` and are never expanded into their
 * edges — not even when the same closure also names edge ids — because that
 * is the only form `applyOverlay` can exempt the origin from. A PENALIZED
 * node is expanded (there is no node channel in `edgeMultiplier`), which is
 * safe because a penalty can slow a route but never strand anyone.
 *
 * Scope is decided by the ids the author NAMED, never by the ones that
 * survive in the graph: a closure scoped to an edge that has since been
 * deleted restricts nothing, rather than widening to the floor it also
 * carries.
 *
 * Ids that are not in the graph are ignored — a stale closure naming a
 * deleted edge must not become an overlay nobody can explain.
 *
 * @param {Array<object>} closures
 * @param {{nodes:Map, edgesById:Map}} graph
 */
export function buildOverlay(closures, graph) {
  const edgeMultiplier = new Map();
  const blockedEdgeIds = new Set();
  const blockedNodeIds = new Set();

  const nodes = graph?.nodes ?? new Map();
  const edgesById = graph?.edgesById ?? new Map();

  /** Every edge with BOTH ends on a floor. Memoized: a floor scan is O(edges)
   *  and several closures can name the same floor. */
  const floorEdgeCache = new Map();
  const edgesOnFloor = (floorId) => {
    let ids = floorEdgeCache.get(floorId);
    if (ids) return ids;
    ids = new Set();
    for (const edge of edgesById.values()) {
      const source = nodes.get(edge.sourceNodeId);
      const target = nodes.get(edge.targetNodeId);
      if (source?.floorId === floorId && target?.floorId === floorId) ids.add(edge.edgeId);
    }
    floorEdgeCache.set(floorId, ids);
    return ids;
  };

  /** Every edge with an end in `nodeIds`. One edge scan, membership by Set. */
  const edgesTouching = (nodeIds) => {
    const ids = new Set();
    if (nodeIds.size === 0) return ids;
    for (const edge of edgesById.values()) {
      if (nodeIds.has(edge.sourceNodeId) || nodeIds.has(edge.targetNodeId)) ids.add(edge.edgeId);
    }
    return ids;
  };

  /**
   * What a closure covers: its named edges, its named nodes, or its floor.
   *
   * The SCOPE is decided by what the author NAMED (the raw lists), while the
   * effect only ever uses ids that are still in the graph. Deciding on the
   * filtered lists instead would silently rescope a closure as the map
   * changes: `{floorId, edgeIds:[e]}` whose `e` has since been deleted would
   * fall through to the floor branch and become a WHOLE-FLOOR closure, which
   * is the opposite of "ids not in the graph are ignored".
   */
  const scopeOf = (closure) => {
    const rawEdges = closure.edgeIds || [];
    const rawNodes = closure.nodeIds || [];

    if (rawEdges.length > 0 || rawNodes.length > 0) {
      return {
        edgeIds: new Set(rawEdges.filter((id) => edgesById.has(id))),
        nodeIds: new Set(rawNodes.filter((id) => nodes.has(id))),
      };
    }
    if (closure.floorId) {
      return { edgeIds: edgesOnFloor(closure.floorId), nodeIds: new Set() };
    }
    return { edgeIds: new Set(), nodeIds: new Set() };
  };

  // Blocks first, so a penalty can never re-open an edge another closure shut.
  const blocking = [];
  const penalizing = [];
  for (const closure of closures || []) {
    (closure.costMultiplier === null || closure.costMultiplier === undefined
      ? blocking
      : penalizing
    ).push(closure);
  }

  for (const closure of blocking) {
    const scope = scopeOf(closure);

    // A blocked node is carried by `blockedNodeIds` and NEVER expanded into
    // its edges — not even when the same closure also names edges. Expanding
    // would put the node's own edges into `blockedEdgeIds`, which
    // `overlayForOrigin` cannot lift, and the person standing on the closed
    // node would be told there is no route at all.
    for (const nodeId of scope.nodeIds) blockedNodeIds.add(nodeId);
    // Only the ids the closure named itself (or its whole floor) become hard
    // edge blocks.
    for (const edgeId of scope.edgeIds) blockedEdgeIds.add(edgeId);
  }

  for (const closure of penalizing) {
    const multiplier = Number(closure.costMultiplier);
    if (!Number.isFinite(multiplier) || multiplier <= 0) continue;

    const scope = scopeOf(closure);
    // A penalty HAS no node channel — `edgeMultiplier` is edge-keyed — so a
    // penalized node does expand into every edge touching it. Safe to expand
    // here where it is not safe above: a penalty can slow a route down but
    // can never strand anyone.
    const affected = new Set([...scope.edgeIds, ...edgesTouching(scope.nodeIds)]);
    for (const edgeId of affected) {
      if (blockedEdgeIds.has(edgeId)) continue;
      edgeMultiplier.set(edgeId, (edgeMultiplier.get(edgeId) ?? 1) * multiplier);
    }
  }

  // Derived from the RESOLVED effect, not from the rows: two different sets of
  // closures that restrict the graph identically are, for routing, the same
  // overlay.
  const fingerprint = [
    ...[...edgeMultiplier].map(([id, m]) => `m:${id}:${m}`),
    ...[...blockedEdgeIds].map((id) => `e:${id}`),
    ...[...blockedNodeIds].map((id) => `n:${id}`),
  ]
    .sort()
    .join('|');

  return { edgeMultiplier, blockedEdgeIds, blockedNodeIds, fingerprint };
}

/**
 * The same overlay with the origin node's block lifted.
 *
 * Someone scanned the QR sticker on the wall of the area that was just
 * closed. Blocking their own node leaves them with no edges at all and a 404
 * — the one answer a person standing inside an incident must never get. The
 * closure still holds for everybody routing *past* that point.
 */
export function overlayForOrigin(overlay, originId) {
  if (!overlay || !originId || !overlay.blockedNodeIds?.has(originId)) return overlay;
  const blockedNodeIds = new Set(overlay.blockedNodeIds);
  blockedNodeIds.delete(originId);
  return { ...overlay, blockedNodeIds };
}

/**
 * Build the routing context for a request with an overlay applied, exempting
 * the origin node from any block.
 *
 * `ctx` is the context SPEC — `{graph, name, includeTags, excludeTags,
 * audience}` — not an already-built context: folding an overlay in after the
 * fact would mean rebuilding the cost function and every fallback's filter
 * here, a second copy of `buildRoutingContext` that could drift from it.
 * The returned object is `buildRoutingContext`'s result plus the
 * origin-adjusted `overlay`, which the caller hands to `assembleRoute` so the
 * `CLOSURE_ON_ROUTE` warnings describe the same restrictions that were routed
 * under.
 *
 * @param {{graph:object, name:string, includeTags?:string[],
 *          excludeTags?:string[], audience?:'public'|'staff'}} ctx
 * @param {object} overlay from `buildOverlay`
 * @param {{originId?:string|null}} [options]
 */
export function applyOverlay({ graph, ...options }, overlay, { originId = null } = {}) {
  const safe = overlayForOrigin(overlay, originId);
  return { ...buildRoutingContext(graph, { ...options, overlay: safe }), overlay: safe };
}

/**
 * The wire-contract view of a closure — what an anonymous scan page is told.
 *
 * No `edgeIds`/`nodeIds`: which specific corridor is shut is operational
 * detail the viewer cannot act on, and publishing the graph's internal ids to
 * an unauthenticated caller buys nothing. `blocked` is the derived form of
 * "costMultiplier is null" so the client never has to know that convention.
 */
export function publicClosure(row) {
  return {
    id: row.id,
    floorId: row.floorId ?? null,
    reason: row.reason ?? null,
    costMultiplier: row.costMultiplier ?? null,
    startsAt: row.startsAt ? asDate(row.startsAt).toISOString() : null,
    endsAt: row.endsAt ? asDate(row.endsAt).toISOString() : null,
    blocked: row.costMultiplier === null || row.costMultiplier === undefined,
  };
}
