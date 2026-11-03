import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import prisma from '../../db/prisma.js';
import { ok, fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';
import { enqueue } from '../../services/analyticsQueue.js';
import { getGraph } from './graphCache.js';
import { parseRoutingQuery } from './profiles.js';
import {
  getActiveClosures,
  buildOverlay,
  applyOverlay,
  publicClosure,
} from './closures.js';
import { searchWithFallbacks, planEvacuation, planRoute } from './planning.js';
import { resolveDestination, parseDestinations, MAX_DESTINATIONS } from './destinations.js';
import { planMultiStopWithFallbacks } from './multiStop.js';
import { assembleMultiStopRoute } from './multiStopRouteAssembler.js';
import { recordRouteRequest } from './routeRequests.js';

const router = Router();

// searchId shape: a v4 UUID minted by this route (never a Prisma cuid), so a
// caller cannot feed a POI or node id into the pick endpoint by mistake.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Moved to planning.js (FX-002); re-exported for existing importers.
export { searchWithFallbacks };

/**
 * GET /api/wayfinding/buildings/:buildingId/directory
 *
 * The building's full directory: every POI, every named drawn room or shop
 * on the floor plans, and every labeled node (exits, lifts, entrances) —
 * minus doors, which are navigation furniture rather than destinations. This
 * is the first thing a visitor sees after scanning — a browsable list,
 * searched client-side — where the /pois endpoint answers incremental typing
 * with a capped match set.
 *
 * Anonymous by design, same as every scan-page surface: names and floor
 * numbers of public places carry no more than the signage on the wall.
 */
router.get(
  '/api/wayfinding/buildings/:buildingId/directory',
  publicReadLimiter,
  async (req, res) => {
    try {
      const { buildingId } = req.params;
      if (!isId(buildingId)) return fail(res, 400, 'Invalid building id.');

      // Hard cap keeps the payload bounded for a building someone has filled
      // with junk; a real venue directory sits far below it.
      const CAP = 300;

      /** A named drawn room routes to the nearest node within this range —
       *  8 m at the default scale. Farther than that and the route would end
       *  somewhere that just is not the place the visitor asked for. */
      const SHAPE_NODE_RADIUS = 400;

      const floorSelect = {
        select: { id: true, floorNumber: true, name: true, shortName: true, verticalOrder: true },
      };

      const [pois, nodes, floors] = await Promise.all([
        // PUBLIC only (BE-29): STAFF and EMERGENCY_ONLY points are not public
        // destinations, and public routing cannot reach them anyway.
        prisma.poi.findMany({
          where: { node: { buildingId, visibility: 'PUBLIC' } },
          take: CAP,
          orderBy: { name: 'asc' },
          include: {
            node: { select: { id: true, type: true, floor: floorSelect } },
          },
        }),
        prisma.node.findMany({
          where: { buildingId, visibility: 'PUBLIC' },
          select: {
            id: true,
            x: true,
            y: true,
            label: true,
            type: true,
            floorId: true,
            floor: floorSelect,
          },
        }),
        prisma.floor.findMany({
          where: { buildingId },
          select: {
            id: true,
            floorNumber: true,
            name: true,
            shortName: true,
            verticalOrder: true,
            drawing: true,
          },
        }),
      ]);

      const nodeById = new Map(nodes.map((n) => [n.id, n]));

      // Doors are navigation furniture, not destinations: nobody searches for
      // "door", and listing twelve of them buries the shops. Their linked
      // nodes stay in the routing graph — they just stay out of the list.
      const doorNodeIds = new Set();
      for (const floor of floors) {
        for (const shape of floor.drawing?.shapes ?? []) {
          if (shape.kind === 'icon' && shape.icon === 'DOOR' && shape.nodeId) {
            doorNodeIds.add(shape.nodeId);
          }
        }
      }

      const entries = [];
      const seenNames = new Set();
      const push = (entry) => {
        const key = entry.name.trim().toLowerCase();
        if (!key || seenNames.has(key) || entries.length >= CAP) return;
        seenNames.add(key);
        entries.push(entry);
      };

      for (const poi of pois) {
        push({
          kind: 'poi',
          poiId: poi.id,
          nodeId: poi.node.id,
          name: poi.name,
          category: poi.category || null,
          externalId: poi.externalId || null,
          nodeType: poi.node.type,
          floorId: poi.node.floor?.id ?? null,
          floorNumber: poi.node.floor?.floorNumber ?? null,
          floorName: poi.node.floor?.name ?? null,
          floorShortName: poi.node.floor?.shortName ?? null,
          floorVerticalOrder: poi.node.floor?.verticalOrder ?? null,
        });
      }

      // Named drawn rooms and shops. An owner who names a room on the plan
      // has published a destination, whether or not they also wired a POI —
      // it routes via its linked node, or the nearest node inside range.
      for (const floor of floors) {
        for (const shape of floor.drawing?.shapes ?? []) {
          if (shape.kind !== 'room' && shape.kind !== 'shop') continue;
          if (typeof shape.name !== 'string' || !shape.name.trim()) continue;

          let target = shape.nodeId ? nodeById.get(shape.nodeId) : null;
          if (!target) {
            const cx = shape.x + shape.width / 2;
            const cy = shape.y + shape.height / 2;
            let best = null;
            for (const node of nodes) {
              if (node.floorId !== floor.id) continue;
              const d = Math.hypot(node.x - cx, node.y - cy);
              if (d <= SHAPE_NODE_RADIUS && (!best || d < best.d)) {
                best = { node, d };
              }
            }
            target = best?.node ?? null;
          }
          // Unroutable rooms are omitted: a directory row that dead-ends in
          // "no route" teaches visitors the list cannot be trusted.
          if (!target) continue;

          push({
            kind: 'shape',
            poiId: null,
            nodeId: target.id,
            name: shape.name.trim(),
            category: null,
            externalId: null,
            nodeType: target.type,
            floorId: floor.id,
            floorNumber: floor.floorNumber,
            floorName: floor.name ?? null,
            floorShortName: floor.shortName ?? null,
            floorVerticalOrder: floor.verticalOrder ?? null,
          });
        }
      }

      for (const node of nodes) {
        if (!node.label || doorNodeIds.has(node.id)) continue;
        push({
          kind: 'node',
          poiId: null,
          nodeId: node.id,
          name: node.label,
          category: null,
          externalId: null,
          nodeType: node.type,
          floorId: node.floor?.id ?? null,
          floorNumber: node.floor?.floorNumber ?? null,
          floorName: node.floor?.name ?? null,
          floorShortName: node.floor?.shortName ?? null,
          floorVerticalOrder: node.floor?.verticalOrder ?? null,
        });
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));
      return ok(res, { data: { entries } });
    } catch (err) {
      console.error('Directory error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

/**
 * GET /api/wayfinding/buildings/:buildingId/closures
 *
 * The restrictions in force RIGHT NOW, for the scan page's closure banner and
 * for a client deciding whether a `closure_changed` frame it just received
 * still applies. Anonymous, like every scan-page surface: "the east corridor
 * is shut" is what the sign taped to the wall already says.
 *
 * Only the active subset, and only the public projection — which specific
 * edges and nodes are involved is operational detail an anonymous caller
 * cannot act on.
 */
router.get(
  '/api/wayfinding/buildings/:buildingId/closures',
  publicReadLimiter,
  async (req, res) => {
    try {
      const { buildingId } = req.params;
      if (!isId(buildingId)) return fail(res, 400, 'Invalid building id.');

      const active = await getActiveClosures(buildingId);
      return ok(res, { data: { closures: active.map(publicClosure) } });
    } catch (err) {
      console.error('Closure list error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// POI destination search: "LC Waikiki", "coffee", "restroom"…
router.get(
  '/api/wayfinding/buildings/:buildingId/pois',
  publicReadLimiter,
  async (req, res) => {
    try {
      const { buildingId } = req.params;
      if (!isId(buildingId)) return fail(res, 400, 'Invalid building id.');

      // A well-formed-but-unknown id must 404 rather than fall through to an
      // empty-but-200 search: without this, an anonymous caller can drive an
      // unbounded number of failed searchEvent.create FK writes (buildingId
      // doesn't exist) at the full publicReadLimiter rate — each one caught
      // and swallowed by the analytics queue, but still a console.error per
      // request. 404 here removes the write from happening at all, instead
      // of trying to gate the enqueue on it (which would also wrongly hide
      // the FK case behind the same code path as "this building has no
      // matching POIs", a real and valuable event this endpoint exists to
      // log).
      const building = await prisma.building.findUnique({
        where: { id: buildingId },
        select: { id: true },
      });
      if (!building) return fail(res, 404, 'Building not found.');

      // Capped (BE-34): matched with `contains` and stored in SearchEvent, and
      // no real destination name comes near 100 characters.
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      const floorNumber =
        req.query.floor !== undefined ? Number(req.query.floor) : null;

      // `searchText` is the precomputed blob buildSearchText() writes on
      // every POI save — name + keywords + names.en/ka + aliases, all
      // lowercased (see src/features/mapEditor/fieldValidators.js). Matching
      // against it (case-sensitive `contains` on an already-lowercased
      // column, against a lowercased query) is what makes an alias or a
      // Georgian name findable. `name` is matched separately, case
      // insensitively, so a row saved before this slice — where the
      // migration backfilled searchText from name+keywords but `names` and
      // any alias stay null — is still findable by its plain display name.
      // `category` is matched as a THIRD, separate branch: buildSearchText
      // deliberately does not fold category in (it's a taxonomy field, not
      // a display/alias name), so "apparel" only ever finds LC Waikiki
      // through this branch — dropping it silently loses category search
      // for every POI ever saved, not just ones written before some cutoff.
      const where = {
        node: {
          buildingId,
          visibility: 'PUBLIC', // BE-29, as in the directory above
          ...(Number.isInteger(floorNumber)
            ? { floor: { floorNumber } }
            : {}),
        },
        ...(q
          ? {
              OR: [
                { searchText: { contains: q.toLowerCase() } },
                { name: { contains: q, mode: 'insensitive' } },
                { category: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const pois = await prisma.poi.findMany({
        where,
        take: 15,
        orderBy: { name: 'asc' },
        include: {
          node: {
            select: {
              id: true,
              floor: {
                select: {
                  id: true,
                  floorNumber: true,
                  name: true,
                  shortName: true,
                  verticalOrder: true,
                },
              },
            },
          },
        },
      });

      // Exact-prefix matches first, then alphabetical.
      const lowered = q.toLowerCase();
      const results = pois
        .map((p) => ({
          poiId: p.id,
          name: p.name,
          category: p.category,
          description: p.description,
          externalId: p.externalId || null,
          names: p.names || null,
          nodeId: p.node.id,
          floorId: p.node.floor?.id ?? null,
          floorNumber: p.node.floor?.floorNumber ?? null,
          floorName: p.node.floor?.name ?? null,
          floorShortName: p.node.floor?.shortName ?? null,
          floorVerticalOrder: p.node.floor?.verticalOrder ?? null,
        }))
        .sort((a, b) => {
          if (lowered) {
            const aPrefix = a.name.toLowerCase().startsWith(lowered) ? 0 : 1;
            const bPrefix = b.name.toLowerCase().startsWith(lowered) ? 0 : 1;
            if (aPrefix !== bPrefix) return aPrefix - bPrefix;
          }
          return a.name.localeCompare(b.name);
        });

      // Minted for every search (not just non-empty ones) so the response
      // shape never changes — but only a real, non-empty query is worth
      // logging: a blank query is just the directory browsing itself, not a
      // visitor asking for something. This is the one signal a building
      // owner has for "my map is missing X" (a q that returns 0 results),
      // so zero-result queries are logged exactly like any other.
      const searchId = randomUUID();
      const response = ok(res, { data: { pois: results, searchId } });
      if (q) {
        enqueue('search-event', () =>
          prisma.searchEvent.create({
            data: {
              id: searchId,
              buildingId,
              query: q,
              resultCount: results.length,
            },
          })
        );
      }
      return response;
    } catch (err) {
      console.error('POI search error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

/**
 * POST /api/wayfinding/search-events/:searchId/pick
 *
 * Records which POI a visitor actually picked after a search — the other
 * half of search-quality analytics alongside the zero-result logging above.
 * Anonymous and public, same as /pois: no auth to check, so the only
 * authorization question is "does this poiId belong to the building that
 * owns this searchId" — enforced entirely inside the `updateMany` WHERE
 * clause (one round trip, no read-then-write race) so a POI from Building B
 * can never be recorded against a search that happened in Building A. A
 * mismatch on any axis (unknown searchId, unknown poiId, or poiId from a
 * different building) all come back as the same 404 — this endpoint never
 * confirms or denies that a given searchId exists in someone else's building.
 */
router.post(
  '/api/wayfinding/search-events/:searchId/pick',
  publicReadLimiter,
  async (req, res) => {
    try {
      const { searchId } = req.params;
      if (!UUID_RE.test(searchId)) return fail(res, 400, 'Invalid search id.');

      const { poiId } = req.body || {};
      if (!isId(poiId)) return fail(res, 400, 'Invalid POI id.');

      // NOTE: this scopes by the denormalized `Poi.buildingId`, while the
      // /pois search above scopes by `node.buildingId` (the source of
      // truth). The two are kept in sync on every map-editor write, but if
      // they ever diverge for a given POI — or a legacy row's backfill
      // missed it — that POI becomes searchable but permanently un-pickable
      // (a 404 here, never a cross-building leak). Worth knowing if a "pick
      // never records" report ever traces back to this endpoint.
      const poi = await prisma.poi.findUnique({
        where: { id: poiId },
        select: { id: true, buildingId: true },
      });
      // A POI with no buildingId (never backfilled/linked) can't be scoped
      // to any building, so it can never be a valid pick either.
      if (!poi || !poi.buildingId) return fail(res, 404, 'Search event not found.');

      const updated = await prisma.searchEvent.updateMany({
        where: { id: searchId, buildingId: poi.buildingId },
        data: { pickedPoiId: poi.id },
      });
      if (updated.count === 0) return fail(res, 404, 'Search event not found.');

      return ok(res, { message: 'Recorded.' });
    } catch (err) {
      console.error('Search pick error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

/**
 * How many destination tokens the client actually sent, collapsing adjacent
 * duplicates the SAME way `parseDestinations` does. Computed on the RAW
 * query, before `parseDestinations`'s own silent `slice(0, MAX_DESTINATIONS)`
 * — that truncation exists so a caller who accidentally repeats a `to` still
 * gets an answer, not so a genuine 9-stop request can sneak past a cap that
 * exists to keep `planMultiStop` bounded.
 */
function countRequestedDestinations(rawTo) {
  if (rawTo === undefined || rawTo === null || rawTo === '') return 0;
  const values = (Array.isArray(rawTo) ? rawTo : [rawTo])
    .map((v) => String(v).trim())
    .filter(Boolean);
  let count = 0;
  let last = null;
  for (const value of values) {
    if (value === last) continue;
    last = value;
    count += 1;
  }
  return count;
}

/**
 * Mode A-multi (B12): more than one `to`. Resolve every requested stop, then
 * hand the routing policy entirely to `multiStop.js`
 * (`planMultiStopWithFallbacks` picks a sensible visiting order and searches
 * the whole plan under the same strict-then-relaxed routing context a
 * single-destination request would use) and `multiStopRouteAssembler.js`
 * (splices the winning plan into the response). This function only does
 * HTTP-layer work: parsing/resolving the request and shaping the failure
 * messages — see `multiStop.js`'s header for the real request cost and the
 * routing decisions themselves.
 */
async function assembleMultiStopResponse(res, { from, origin, parsed, destinations }) {
  // Every stop the caller actually asked for, IN REQUEST ORDER — see B13's
  // report for why `to` records this JSON-encoded list (not just the final
  // destination) for a multi-stop request.
  const requestedTo = JSON.stringify(destinations);
  const recordFailure = (profile) =>
    recordRouteRequest({
      buildingId: origin.buildingId,
      fromNodeId: from,
      to: requestedTo,
      profile,
      mode: 'WAYFINDING',
      src: parsed.src,
      found: false,
    });

  const resolvedStops = [];
  for (let i = 0; i < destinations.length; i += 1) {
    // Sequential rather than Promise.all: keeps error reporting
    // ("destination #N") aligned with request order, and at most 8 of these
    // is not worth the added complexity of parallelizing.
    const resolved = await resolveDestination(origin.buildingId, destinations[i]);
    if (!resolved.ok) {
      recordFailure(parsed.name);
      return fail(res, resolved.status, resolved.message);
    }
    resolvedStops.push({ ...resolved, requestIndex: i });
  }

  const graph = await getGraph(origin.buildingId);
  for (const stop of resolvedStops) {
    if (!graph.nodes.has(stop.nodeId)) {
      recordFailure(parsed.name);
      return fail(res, 404, `Destination #${stop.requestIndex + 1} is not in this building.`);
    }
  }

  const activeClosures = await getActiveClosures(origin.buildingId);
  const closures = activeClosures.map(publicClosure);
  const overlay = buildOverlay(activeClosures, graph);

  const context = applyOverlay(
    { graph, name: parsed.name, includeTags: parsed.includeTags, excludeTags: parsed.excludeTags },
    overlay,
    { originId: from }
  );
  if (!context.ok) {
    recordFailure(parsed.name);
    return fail(res, context.status, context.error);
  }

  const accessible = context.name === 'wheelchair';
  const targetIds = resolvedStops.map((s) => s.nodeId);

  // `context.fallbacks` is already strictest-relaxation-first (tags before
  // accessibility — see `buildRoutingContext`), exactly what cumulative flag
  // tracking requires.
  const { plan, tagConstraintsRelaxed, accessibleRouteUnavailable } = planMultiStopWithFallbacks(
    graph,
    from,
    targetIds,
    context.profile,
    { edgeFilter: context.strictEdgeFilter, costFn: context.costFn },
    context.fallbacks
  );

  if (!plan.ok) {
    recordFailure(context.name);
    const failedStop = resolvedStops[plan.failedIndex];
    const node = graph.nodes.get(failedStop.nodeId);
    const name = failedStop.poi?.name ?? node?.poi?.name ?? null;
    return fail(
      res,
      404,
      name ? `No route found to "${name}".` : `No route found to destination #${plan.failedIndex + 1}.`
    );
  }

  const route = assembleMultiStopRoute(graph, plan, {
    resolvedStops,
    accessible,
    accessibleRouteUnavailable,
    tagConstraintsRelaxed,
    profile: context.profile,
    profileName: context.name,
    overlay: context.overlay,
    heading: parsed.heading,
  });
  route.closures = closures;

  recordRouteRequest({
    buildingId: origin.buildingId,
    fromNodeId: from,
    to: requestedTo,
    profile: context.name,
    mode: 'WAYFINDING',
    src: parsed.src,
    found: true,
    distanceM: route.totalDistanceM,
    durationSec: route.totalDurationSec,
  });

  return ok(res, { data: { route, closures } });
}

// Mode A: point-to-point wayfinding. `to` accepts a node id, "poi:<poiId>",
// or "ext:<code>"; `to` is repeatable for multi-stop routing (B12), searched
// in an order `multiStop.js` chooses, not necessarily the order requested.
router.get('/api/wayfinding/route', publicReadLimiter, async (req, res) => {
  try {
    const from = String(req.query.from || '');
    if (!isId(from)) return fail(res, 400, 'Invalid origin node id.');

    const parsed = parseRoutingQuery(req.query);
    if (!parsed.ok) return fail(res, 400, parsed.error);

    const requestedCount = countRequestedDestinations(req.query.to);
    if (requestedCount > MAX_DESTINATIONS) {
      return fail(res, 422, `Too many destinations: at most ${MAX_DESTINATIONS} are allowed.`);
    }

    const destinations = parseDestinations(req.query);
    if (destinations.length === 0) {
      return fail(res, 400, 'Invalid destination node id.');
    }

    const origin = await prisma.node.findUnique({
      where: { id: from },
      select: { buildingId: true, poi: { select: { id: true } } },
    });
    if (!origin) return fail(res, 404, 'Origin node not found.');

    // A single `to` falls straight through to the path below, UNCHANGED from
    // before this task: same variables, same calls, same payload shape — the
    // frontend's golden fixtures and the live scan page depend on that being
    // byte-for-byte identical. Only `destinations.length > 1` takes the new
    // multi-stop branch above.
    if (destinations.length > 1) {
      return await assembleMultiStopResponse(res, { from, origin, parsed, destinations });
    }

    const rawTo = destinations[0];
    const recordFailure = (profile) =>
      recordRouteRequest({
        buildingId: origin.buildingId,
        fromNodeId: from,
        to: rawTo,
        profile,
        mode: 'WAYFINDING',
        src: parsed.src,
        found: false,
      });

    const resolved = await resolveDestination(origin.buildingId, rawTo);
    if (!resolved.ok) {
      recordFailure(parsed.name);
      return fail(res, resolved.status, resolved.message);
    }
    const to = resolved.nodeId;

    const graph = await getGraph(origin.buildingId);
    if (!graph.nodes.has(to)) {
      recordFailure(parsed.name);
      return fail(res, 404, 'Destination is not in this building.');
    }

    let destinationPoi = resolved.poi;
    if (!destinationPoi) {
      const destNode = graph.nodes.get(to);
      destinationPoi = destNode?.poi
        ? { id: destNode.poi.id, name: destNode.poi.name, category: destNode.poi.category }
        : null;
    }

    // Closures are read per request (15 s TTL, invalidated on every editor
    // write) rather than baked into the cached graph: they change on an
    // incident cadence and expire on the clock, with no write to hang an
    // invalidation off.
    const activeClosures = await getActiveClosures(origin.buildingId);
    const plan = planRoute({
      graph,
      activeClosures,
      originId: from,
      targetId: to,
      query: {
        name: parsed.name,
        includeTags: parsed.includeTags,
        excludeTags: parsed.excludeTags,
        heading: parsed.heading,
      },
      destinationPoi,
    });
    if (!plan.ok) {
      recordFailure(parsed.name);
      return fail(res, plan.status, plan.error);
    }
    if (!plan.found) {
      recordFailure(plan.profileName);
      return fail(res, 404, 'No route found between these points.');
    }
    const { route, closures } = plan;
    recordRouteRequest({
      buildingId: origin.buildingId,
      fromNodeId: from,
      to: rawTo,
      profile: plan.profileName,
      mode: 'WAYFINDING',
      src: parsed.src,
      found: true,
      distanceM: route.totalDistanceM,
      durationSec: route.totalDurationSec,
    });

    return ok(res, { data: { route, closures } });
  } catch (err) {
    console.error('Wayfinding route error:', err);
    return fail(res, 500, 'Server error.');
  }
});

// Mode B: evacuation to the nearest emergency exit.
//
// LIFE-SAFETY RULE: `/evacuate` always searches under the `emergency`
// profile's visibility (EMERGENCY_ONLY edges) and blocking (elevators,
// unless the building says its cars are evacuation rated) — never an
// explicit `profile=`. Letting a public, anonymous `?profile=walk` (or any
// other named profile) replace the routing context outright would hide
// EMERGENCY_ONLY edges and re-open elevators, which is not a preference, it
// is a wrong answer during a fire. An explicit named profile other than
// `wheelchair`/`emergency` may still contribute its *cost* preferences
// (`transitMultiplier`, `floorChangePenaltySec`) layered on top of the
// emergency-resolved profile — e.g. `profile=min_floor_changes` still avoids
// extra floor changes when it can, it just can never route through a
// blocked/hidden edge to do it. `wheelchair` (or `accessible=true`) layers
// its accessibility requirement on top the same way.
router.get('/api/wayfinding/evacuate', publicReadLimiter, async (req, res) => {
  try {
    const from = String(req.query.from || '');
    if (!isId(from)) return fail(res, 400, 'Invalid origin node id.');

    const parsed = parseRoutingQuery(req.query);
    if (!parsed.ok) return fail(res, 400, parsed.error);

    const origin = await prisma.node.findUnique({
      where: { id: from },
      select: { buildingId: true },
    });
    if (!origin) return fail(res, 404, 'Origin node not found.');

    const wheelchairRequestedEarly = parsed.name === 'wheelchair';
    const recordFailure = () =>
      recordRouteRequest({
        buildingId: origin.buildingId,
        fromNodeId: from,
        to: null,
        profile: wheelchairRequestedEarly ? 'wheelchair' : 'emergency',
        mode: 'EVACUATION',
        src: parsed.src,
        found: false,
      });

    const graph = await getGraph(origin.buildingId);
    const activeClosures = await getActiveClosures(origin.buildingId);

    const plan = planEvacuation({
      graph,
      activeClosures,
      originId: from,
      query: {
        name: parsed.name,
        explicitProfile: typeof req.query.profile === 'string' && Boolean(req.query.profile),
        includeTags: parsed.includeTags,
        excludeTags: parsed.excludeTags,
        heading: parsed.heading,
      },
    });
    if (!plan.ok) {
      recordFailure();
      return fail(res, plan.status, plan.error);
    }
    if (!plan.found) {
      recordFailure();
      return fail(res, 404, 'No exit route found from this location.');
    }
    const { route, closures } = plan;
    const wheelchairRequested = plan.wheelchairRequested;
    recordRouteRequest({
      buildingId: origin.buildingId,
      fromNodeId: from,
      to: null,
      profile: wheelchairRequested ? 'wheelchair' : 'emergency',
      mode: 'EVACUATION',
      src: parsed.src,
      found: true,
      distanceM: route.totalDistanceM,
      durationSec: route.totalDurationSec,
    });

    return ok(res, { data: { route, closures } });
  } catch (err) {
    console.error('Evacuation route error:', err);
    return fail(res, 500, 'Server error.');
  }
});

export default router;
