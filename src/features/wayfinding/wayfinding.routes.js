import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { ok, fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';
import { getGraph } from './graphCache.js';
import { findRoute, findEvacuationRoute } from './dijkstra.js';
import { assembleRoute } from './routeAssembler.js';

const router = Router();

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
              floor: { select: { id: true, floorNumber: true, name: true } },
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
          nodeId: p.node.id,
          floorId: p.node.floor?.id ?? null,
          floorNumber: p.node.floor?.floorNumber ?? null,
          floorName: p.node.floor?.name ?? null,
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

// Mode A: point-to-point wayfinding. `to` accepts a node id or "poi:<poiId>".
router.get('/api/wayfinding/route', publicReadLimiter, async (req, res) => {
  try {
    const from = String(req.query.from || '');
    let to = String(req.query.to || '');
    const accessible = req.query.accessible === 'true';

    if (!isId(from)) return fail(res, 400, 'Invalid origin node id.');

    let destinationPoi = null;
    if (to.startsWith('poi:')) {
      const poiId = to.slice(4);
      if (!isId(poiId)) return fail(res, 400, 'Invalid destination.');
      const poi = await prisma.poi.findUnique({
        where: { id: poiId },
        select: { id: true, name: true, category: true, nodeId: true },
      });
      if (!poi) return fail(res, 404, 'Destination not found.');
      destinationPoi = { id: poi.id, name: poi.name, category: poi.category };
      to = poi.nodeId;
    } else if (!isId(to)) {
      return fail(res, 400, 'Invalid destination node id.');
    }

    const origin = await prisma.node.findUnique({
      where: { id: from },
      select: { buildingId: true, poi: { select: { id: true } } },
    });
    if (!origin) return fail(res, 404, 'Origin node not found.');

    const graph = await getGraph(origin.buildingId);
    if (!graph.nodes.has(to)) {
      return fail(res, 404, 'Destination is not in this building.');
    }

    if (!destinationPoi) {
      const destNode = graph.nodes.get(to);
      destinationPoi = destNode?.poi
        ? { id: destNode.poi.id, name: destNode.poi.name, category: destNode.poi.category }
        : null;
    }

    const result = findRoute(graph, from, to, { accessible });
    if (!result) {
      return fail(res, 404, 'No route found between these points.');
    }

    const route = assembleRoute(graph, result.path, {
      mode: 'WAYFINDING',
      destinationPoi,
      accessible,
      accessibleRouteUnavailable: result.accessibleRouteUnavailable,
    });
    return ok(res, { data: { route } });
  } catch (err) {
    console.error('Wayfinding route error:', err);
    return fail(res, 500, 'Server error.');
  }
});

// Mode B: evacuation to the nearest emergency exit.
router.get('/api/wayfinding/evacuate', publicReadLimiter, async (req, res) => {
  try {
    const from = String(req.query.from || '');
    const accessible = req.query.accessible === 'true';
    if (!isId(from)) return fail(res, 400, 'Invalid origin node id.');

    const origin = await prisma.node.findUnique({
      where: { id: from },
      select: { buildingId: true },
    });
    if (!origin) return fail(res, 404, 'Origin node not found.');

    const graph = await getGraph(origin.buildingId);
    const result = findEvacuationRoute(graph, from, { accessible });
    if (!result) {
      return fail(res, 404, 'No exit route found from this location.');
    }

    const route = assembleRoute(graph, result.path, {
      mode: 'EVACUATION',
      accessible,
      accessibleRouteUnavailable: result.accessibleRouteUnavailable,
    });
    return ok(res, { data: { route } });
  } catch (err) {
    console.error('Evacuation route error:', err);
    return fail(res, 500, 'Server error.');
  }
});

export default router;
