import prisma from '../../../../db/prisma.js';
import { getGraph } from '../../../wayfinding/graphCache.js';
import { findRoute, findEvacuationRoute } from '../../../wayfinding/dijkstra.js';
import { assembleRoute } from '../../../wayfinding/routeAssembler.js';
import { recordRouteRequest } from '../../../wayfinding/routeRequests.js';
import { defineTool } from '../toolRegistry.js';

/* ============================================================================
   Tools for the visitor-facing Wayfinder agent.
   ----------------------------------------------------------------------------
   This is the anonymous surface, so two things are load-bearing.

   FIRST: every tool reports failure plainly. `found: false` with no name, no
   distance and nothing else to embellish. The prompt says "never invent shops,
   floors or exits" — but a prompt is guidance, and a tool that returns an
   empty, unambiguous result is enforcement. A model cannot describe an exit it
   was never handed.

   SECOND: routes are SUMMARIZED, not returned whole. The visitor already has
   the full route on screen, drawn from the same graph by the same Dijkstra.
   Handing the model the geometry would invite it to narrate turn-by-turn
   directions that compete with the drawn line — and when those two disagree
   during an evacuation, the model loses but the visitor has already read it.
   ========================================================================= */

const SEARCH_LIMIT = 8;

/**
 * A path is only useful to the model as a shape: how far, how many floors,
 * how long.
 *
 * B16 tried threading a `profileName` STRING through to `assembleRoute` here,
 * on the theory that the AI surface's ETA should reflect the same named
 * profile as the HTTP surfaces. That was a regression, not an improvement:
 * `assembleRoute`'s `normalizeProfile` resolves a bare string with NO
 * building overrides (`resolveProfile(null, name)`), whereas passing nothing
 * at all falls back to `resolveProfile(graph.routingProfile ?? null, 'walk')`
 * — which DOES pick up the building's own calibrated `routingProfile` (e.g. a
 * custom `walkSpeedMps`). The string form silently discarded that. It also
 * bought nothing even done correctly: `etaProfileOf` (routeAssembler.js)
 * strips `transitMultiplier`, `floorChangePenaltySec` and `blockedTransit`
 * for ETA purposes — exactly the three knobs that distinguish one named
 * profile's physics from another — so no profile name can change the ETA
 * either way. Left at the default (no `profile` passed) instead: simpler,
 * and correct today and if that stripping ever changes.
 */
function summarizeRoute(graph, path, { mode, accessible, destinationPoi }) {
  const route = assembleRoute(graph, path, { mode, accessible, destinationPoi });
  if (!route) return { found: false };

  const transitions = route.transitions || [];
  // A floor with no scalePixelsPerMeter yields 0 metres, and "0 metres away"
  // is worse than saying nothing: the visitor would read it as "you are here".
  // Omit the distance instead and let the agent describe the route without it.
  const meters = Math.round(route.totalDistanceMeters ?? 0);
  return {
    found: true,
    ...(meters > 0 ? { distanceMeters: meters } : {}),
    // Always numeric — `assembleRoute` assumes a scale when the floor has
    // none, so unlike distance there is no "0 means unknown" case to hide.
    durationSec: Math.round(route.totalDurationSec ?? 0),
    floorChanges: transitions.length,
    // Named so the agent can warn about lifts during an emergency without
    // being told the whole path.
    transitTypes: [...new Set(transitions.map((transition) => transition.transitType))],
    accessibleRouteUnavailable: Boolean(route.accessibleRouteUnavailable),
  };
}

const search_destinations = defineTool({
  name: 'search_destinations',
  description:
    'Search the places in this building by name, category or keyword. Use this before answering any "where is X" question — it is the only way to know whether a place exists here.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      floorNumber: { type: 'integer' },
    },
    required: ['query'],
  },
  handler: async (ctx, args) => {
    const query = args.query.trim();
    if (!query) return { found: false, places: [] };

    const pois = await prisma.poi.findMany({
      where: {
        // Scoped through the node: a Poi has no buildingId of its own.
        node: {
          buildingId: ctx.buildingId,
          ...(args.floorNumber !== undefined
            ? { floor: { floorNumber: args.floorNumber } }
            : {}),
        },
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { category: { contains: query, mode: 'insensitive' } },
          { keywords: { has: query.toLowerCase() } },
        ],
      },
      take: SEARCH_LIMIT,
      orderBy: { name: 'asc' },
      include: {
        node: { select: { id: true, floor: { select: { floorNumber: true, name: true } } } },
      },
    });

    const places = pois.map((poi) => ({
      poiId: poi.id,
      nodeId: poi.nodeId,
      name: poi.name,
      category: poi.category,
      floorNumber: poi.node?.floor?.floorNumber ?? null,
      floorName: poi.node?.floor?.name ?? null,
    }));

    return { found: places.length > 0, places };
  },
});

const find_nearest_exit = defineTool({
  name: 'find_nearest_exit',
  description:
    'Find the nearest emergency exit from where the visitor is standing. Returns found:false when the building has no exit or the visitor position is unknown — say so plainly rather than guessing.',
  parameters: {
    type: 'object',
    properties: { accessible: { type: 'boolean' } },
  },
  handler: async (ctx, args) => {
    // No origin means no route. Saying so is the whole point: the alternative
    // is a model describing an exit it has no basis for. Nothing is recorded
    // here — same as an HTTP call site never enqueuing a write before its
    // origin resolves, this isn't a real route request without one.
    if (!ctx.nodeId) return { found: false, reason: 'unknown_position' };

    const graph = await getGraph(ctx.buildingId);
    if (!graph.nodes.has(ctx.nodeId)) return { found: false, reason: 'unknown_position' };

    // EVACUATION-mode rows record 'wheelchair' or 'emergency' everywhere else
    // in this table (the HTTP /evacuate endpoint, the QR scan route) — never
    // 'walk', which is the WAYFINDING-mode default and means a different
    // profile entirely on this shared column.
    const profile = args.accessible ? 'wheelchair' : 'emergency';
    const result = findEvacuationRoute(graph, ctx.nodeId, { accessible: Boolean(args.accessible) });
    if (!result) {
      recordRouteRequest({
        buildingId: ctx.buildingId,
        fromNodeId: ctx.nodeId,
        to: null,
        profile,
        mode: 'EVACUATION',
        src: 'ai',
        found: false,
      });
      return { found: false, reason: 'no_exit' };
    }

    const exitNode = graph.nodes.get(result.path[result.path.length - 1]);
    const summary = summarizeRoute(graph, result.path, {
      mode: 'EVACUATION',
      accessible: Boolean(args.accessible),
    });
    recordRouteRequest({
      buildingId: ctx.buildingId,
      fromNodeId: ctx.nodeId,
      to: null,
      profile,
      mode: 'EVACUATION',
      src: 'ai',
      found: true,
      distanceM: summary.distanceMeters ?? null,
    });
    return {
      ...summary,
      exitName: exitNode?.label || 'the emergency exit',
      exitFloorNumber: exitNode?.floorNumber ?? null,
    };
  },
});

const get_route = defineTool({
  name: 'get_route',
  description:
    'Check whether a walking route exists from the visitor to a place, and how far it is. Returns found:false when there is no route — never describe a route this did not confirm.',
  parameters: {
    type: 'object',
    properties: {
      toPoiId: { type: 'string' },
      toNodeId: { type: 'string' },
      accessible: { type: 'boolean' },
    },
  },
  handler: async (ctx, args) => {
    // No origin at all: there is no `from`, so this can never become a real
    // route request — same as an HTTP call site never enqueuing a write
    // before the origin resolves.
    if (!ctx.nodeId) return { found: false, reason: 'unknown_position' };

    const profile = args.accessible ? 'wheelchair' : 'walk';

    let targetNodeId = args.toNodeId || null;
    let destinationPoi = null;

    if (args.toPoiId) {
      const poi = await prisma.poi.findFirst({
        // Scoped: the id came from the model.
        where: { id: args.toPoiId, node: { buildingId: ctx.buildingId } },
        select: { id: true, name: true, nodeId: true },
      });
      if (!poi) {
        // The origin (ctx.nodeId) IS known and valid here, and a destination
        // WAS attempted — this is the AI-concierge equivalent of the HTTP
        // `/route` handler's `resolveDestination` failure (a `poi:<id>`
        // token that doesn't resolve), which IS recorded there. The AI
        // surface is the one most likely to receive a mistyped or invented
        // destination, which makes this exactly the row worth keeping, not
        // dropping. `to` is prefixed the same way the HTTP `to` column
        // already stores a `poi:<id>` token, so a reader of this table sees
        // a self-describing "what was being looked up" rather than a bare id.
        recordRouteRequest({
          buildingId: ctx.buildingId,
          fromNodeId: ctx.nodeId,
          to: `poi:${args.toPoiId}`,
          profile,
          mode: 'WAYFINDING',
          src: 'ai',
          found: false,
        });
        return { found: false, reason: 'unknown_destination' };
      }
      targetNodeId = poi.nodeId;
      destinationPoi = poi;
    }

    // Neither `toPoiId` nor `toNodeId` was given at all — no destination was
    // ever attempted, the same shape as an HTTP request with no `to` param
    // at all (rejected before the origin is even looked up, and never
    // recorded there either).
    if (!targetNodeId) return { found: false, reason: 'unknown_destination' };

    const graph = await getGraph(ctx.buildingId);
    if (!graph.nodes.has(targetNodeId) || !graph.nodes.has(ctx.nodeId)) {
      // A concrete node id was given (directly, or resolved from a poi above)
      // but it isn't in this building's graph — the AI-tool equivalent of the
      // HTTP handler's "Destination is not in this building" 404, which is
      // also recorded there.
      recordRouteRequest({
        buildingId: ctx.buildingId,
        fromNodeId: ctx.nodeId,
        to: targetNodeId,
        profile,
        mode: 'WAYFINDING',
        src: 'ai',
        found: false,
      });
      return { found: false, reason: 'unknown_destination' };
    }
    const result = findRoute(graph, ctx.nodeId, targetNodeId, {
      accessible: Boolean(args.accessible),
    });
    if (!result) {
      recordRouteRequest({
        buildingId: ctx.buildingId,
        fromNodeId: ctx.nodeId,
        to: targetNodeId,
        profile,
        mode: 'WAYFINDING',
        src: 'ai',
        found: false,
      });
      return { found: false, reason: 'no_route' };
    }

    const summary = summarizeRoute(graph, result.path, {
      mode: 'WAYFINDING',
      accessible: Boolean(args.accessible),
      destinationPoi,
    });
    recordRouteRequest({
      buildingId: ctx.buildingId,
      fromNodeId: ctx.nodeId,
      to: targetNodeId,
      profile,
      mode: 'WAYFINDING',
      src: 'ai',
      found: true,
      distanceM: summary.distanceMeters ?? null,
    });
    return {
      ...summary,
      destinationName: destinationPoi?.name ?? graph.nodes.get(targetNodeId)?.label ?? null,
    };
  },
});

const show_route_to = defineTool({
  name: 'show_route_to',
  description:
    'Draw the route to a place on the visitor\'s map. Use this whenever you name a destination — it saves them searching for it by hand. Only ever pass an id that search_destinations returned.',
  // The whole reason this agent exists: the old concierge could only tell the
  // visitor to go and use the search box themselves.
  sideEffect: 'client',
  parameters: {
    type: 'object',
    properties: {
      poiId: { type: 'string' },
      nodeId: { type: 'string' },
    },
  },
  handler: async (ctx, args) => {
    if (args.poiId) {
      const poi = await prisma.poi.findFirst({
        where: { id: args.poiId, node: { buildingId: ctx.buildingId } },
        select: { id: true, name: true, nodeId: true },
      });
      if (!poi) return { error: 'That place was not found in this building.' };
      return { action: { name: 'show_route_to', args: { poiId: poi.id, name: poi.name } } };
    }

    if (args.nodeId) {
      const node = await prisma.node.findFirst({
        where: { id: args.nodeId, buildingId: ctx.buildingId },
        select: { id: true, label: true },
      });
      if (!node) return { error: 'That place was not found in this building.' };
      return {
        action: {
          name: 'show_route_to',
          args: { nodeId: node.id, name: node.label || 'the destination' },
        },
      };
    }

    return { error: 'Give a poiId or a nodeId from a search result.' };
  },
});

export const wayfindingTools = Object.freeze({
  search_destinations,
  find_nearest_exit,
  get_route,
  show_route_to,
});
