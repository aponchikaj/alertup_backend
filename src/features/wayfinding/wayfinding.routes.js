import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { ok, fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';
import { getGraph } from './graphCache.js';
import { findRoute, findEvacuationRoute } from './dijkstra.js';
import { assembleRoute } from './routeAssembler.js';
import { parseRoutingQuery, composeFilters, makeOverlayCostFn } from './profiles.js';
import {
  getActiveClosures,
  buildOverlay,
  applyOverlay,
  publicClosure,
} from './closures.js';
import { resolveDestination, parseDestinations } from './destinations.js';
import { resolveProfile, makeCostFn } from './costModel.js';

const router = Router();

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
 * @returns {{result:object|null, tagConstraintsRelaxed:boolean, accessibleRouteUnavailable:boolean}}
 */
function searchWithFallbacks(strictAttempt, fallbackAttempts, search) {
  const strictResult = search(strictAttempt.edgeFilter, strictAttempt.costFn);
  if (strictResult) {
    return { result: strictResult, tagConstraintsRelaxed: false, accessibleRouteUnavailable: false };
  }

  let tagConstraintsRelaxed = false;
  let accessibleRouteUnavailable = false;
  for (const attempt of fallbackAttempts) {
    if (attempt.label === 'tagConstraintsRelaxed') tagConstraintsRelaxed = true;
    if (attempt.label === 'accessibleRouteUnavailable') accessibleRouteUnavailable = true;
    const result = search(attempt.edgeFilter, attempt.costFn);
    if (result) return { result, tagConstraintsRelaxed, accessibleRouteUnavailable };
  }
  return { result: null, tagConstraintsRelaxed: false, accessibleRouteUnavailable: false };
}

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
        prisma.poi.findMany({
          where: { node: { buildingId } },
          take: CAP,
          orderBy: { name: 'asc' },
          include: {
            node: { select: { id: true, type: true, floor: floorSelect } },
          },
        }),
        prisma.node.findMany({
          where: { buildingId },
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

      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const floorNumber =
        req.query.floor !== undefined ? Number(req.query.floor) : null;

      const where = {
        node: {
          buildingId,
          ...(Number.isInteger(floorNumber)
            ? { floor: { floorNumber } }
            : {}),
        },
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { category: { contains: q, mode: 'insensitive' } },
                { keywords: { has: q.toLowerCase() } },
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

      return ok(res, { data: { pois: results } });
    } catch (err) {
      console.error('POI search error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// Mode A: point-to-point wayfinding. `to` accepts a node id, "poi:<poiId>",
// or "ext:<code>"; repeated `to` (multi-stop) is B12 — only the first is used.
router.get('/api/wayfinding/route', publicReadLimiter, async (req, res) => {
  try {
    const from = String(req.query.from || '');
    if (!isId(from)) return fail(res, 400, 'Invalid origin node id.');

    const parsed = parseRoutingQuery(req.query);
    if (!parsed.ok) return fail(res, 400, parsed.error);

    const destinations = parseDestinations(req.query);
    if (destinations.length === 0) {
      return fail(res, 400, 'Invalid destination node id.');
    }
    const rawTo = destinations[0]; // B12: multi-stop routing uses the rest.

    const origin = await prisma.node.findUnique({
      where: { id: from },
      select: { buildingId: true, poi: { select: { id: true } } },
    });
    if (!origin) return fail(res, 404, 'Origin node not found.');

    const resolved = await resolveDestination(origin.buildingId, rawTo);
    if (!resolved.ok) return fail(res, resolved.status, resolved.message);
    const to = resolved.nodeId;

    const graph = await getGraph(origin.buildingId);
    if (!graph.nodes.has(to)) {
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
    const closures = activeClosures.map(publicClosure);
    const overlay = buildOverlay(activeClosures, graph);

    const context = applyOverlay(
      {
        graph,
        name: parsed.name,
        includeTags: parsed.includeTags,
        excludeTags: parsed.excludeTags,
      },
      overlay,
      { originId: from }
    );
    if (!context.ok) return fail(res, context.status, context.error);

    const accessible = context.name === 'wheelchair';

    // `context.fallbacks` is already ordered strictest-relaxation-first
    // (tags before accessibility — see `buildRoutingContext`), which is
    // exactly what cumulative flag tracking requires.
    const { result, tagConstraintsRelaxed, accessibleRouteUnavailable } = searchWithFallbacks(
      { edgeFilter: context.strictEdgeFilter, costFn: context.costFn },
      context.fallbacks,
      (edgeFilter, costFn) =>
        findRoute(graph, from, to, {
          accessible: false, // relaxation is driven by the fallback chain above
          profile: context.profile,
          costFn,
          edgeFilter,
        })
    );
    if (!result) {
      return fail(res, 404, 'No route found between these points.');
    }

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
    });
    // Also on the route itself: the frontend normalizes `route.closures`, and
    // a route handed to the AI or embedded as an alternative travels alone.
    route.closures = closures;

    // B13: recordRouteRequest({ buildingId: origin.buildingId, profile: context.name, src: parsed.src, ... })

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

    const graph = await getGraph(origin.buildingId);

    // `contextName` is always 'emergency': visibility, blockedTransit and
    // the fallback chain all come from it, never from an explicit `profile=`.
    const activeClosures = await getActiveClosures(origin.buildingId);
    const closures = activeClosures.map(publicClosure);
    const overlay = buildOverlay(activeClosures, graph);

    const context = applyOverlay(
      {
        graph,
        name: 'emergency',
        includeTags: parsed.includeTags,
        excludeTags: parsed.excludeTags,
      },
      overlay,
      { originId: from }
    );
    if (!context.ok) return fail(res, context.status, context.error);

    const wheelchairRequested = parsed.name === 'wheelchair';
    const explicitProfileName =
      typeof req.query.profile === 'string' && req.query.profile ? parsed.name : null;
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
      // `makeCostFn` alone knows nothing about closures, so without the
      // re-wrap a closure's penalty would silently stop applying the moment
      // anyone passed `?profile=` to /evacuate. (Its hard block holds either
      // way — that lives in the edge filter, not the cost.)
      effectiveCostFn = makeOverlayCostFn(makeCostFn(effectiveProfile), context.overlay);
    }

    // Layered on top of `emergency`'s strict filter/fallbacks, strictest
    // relaxation first: tags before accessibility, so an evacuating
    // wheelchair user only loses the accessibility requirement as an
    // absolute last resort (never before a soft tag preference is relaxed).
    // `context.fallbacks` alone (emergency has no accessibility filter of
    // its own) only ever represents "tags dropped" here, so when wheelchair
    // is requested it's composed with `requireAccessible` to keep
    // accessibility in force through that step; the accessibility-drop step
    // is appended strictly after it, built from whichever filter that step
    // would have used (the last fallback's, or the strict filter itself when
    // there were no tags to relax at all).
    const requireAccessible = (edge) => edge.accessible !== false;
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
    const strictEdgeFilter = wheelchairRequested
      ? composeFilters(context.strictEdgeFilter, requireAccessible)
      : context.strictEdgeFilter;
    const fallbacks = [...tagRelaxedFallbacks, ...accessibilityDroppedFallback];

    const { result, tagConstraintsRelaxed, accessibleRouteUnavailable } = searchWithFallbacks(
      { edgeFilter: strictEdgeFilter, costFn: effectiveCostFn },
      fallbacks,
      (edgeFilter, costFn) =>
        findEvacuationRoute(graph, from, {
          accessible: false, // relaxation is driven by the fallback chain above
          profile: effectiveProfile,
          costFn,
          edgeFilter,
        })
    );
    if (!result) {
      return fail(res, 404, 'No exit route found from this location.');
    }

    const route = assembleRoute(graph, result.path, {
      mode: 'EVACUATION',
      accessible: wheelchairRequested,
      accessibleRouteUnavailable,
      profile: effectiveProfile,
      // Stays inside the closed RouteProfile union the frontend switches on
      // (e.g. the emergency banner's danger framing keys off
      // `profile === 'emergency'`) — the layered cost preference rides the
      // separate, additive `preference` field instead of a composite name.
      profileName: wheelchairRequested ? 'wheelchair' : 'emergency',
      preference: costOverlayName,
      tagConstraintsRelaxed,
      overlay: context.overlay,
    });
    route.closures = closures;

    // B13: recordRouteRequest({ buildingId: origin.buildingId, profile: route.profile, src: parsed.src, ... })

    return ok(res, { data: { route, closures } });
  } catch (err) {
    console.error('Evacuation route error:', err);
    return fail(res, 500, 'Server error.');
  }
});

export default router;
