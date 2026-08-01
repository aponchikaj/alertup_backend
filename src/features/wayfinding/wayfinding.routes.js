import { Router } from 'express';
import prisma from '../../db/prisma.js';
import { ok, fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';
import { getGraph } from './graphCache.js';
import { findRoute, findEvacuationRoute } from './dijkstra.js';
import { assembleRoute } from './routeAssembler.js';

const router = Router();

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

      const floorSelect = { select: { id: true, floorNumber: true, name: true } };

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
          select: { id: true, floorNumber: true, name: true, drawing: true },
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
          nodeType: poi.node.type,
          floorId: poi.node.floor?.id ?? null,
          floorNumber: poi.node.floor?.floorNumber ?? null,
          floorName: poi.node.floor?.name ?? null,
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
            nodeType: target.type,
            floorId: floor.id,
            floorNumber: floor.floorNumber,
            floorName: floor.name ?? null,
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
          nodeType: node.type,
          floorId: node.floor?.id ?? null,
          floorNumber: node.floor?.floorNumber ?? null,
          floorName: node.floor?.name ?? null,
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
