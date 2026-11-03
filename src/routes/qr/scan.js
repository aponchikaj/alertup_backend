import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../db/prisma.js';
import config from '../../config/index.js';
import { isId } from '../../utils/ids.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';
import { parseQrSlug } from '../../features/qr/qrPayload.js';
import { getGraph } from '../../features/wayfinding/graphCache.js';
import { parseRoutingQuery } from '../../features/wayfinding/profiles.js';
import { getActiveClosures } from '../../features/wayfinding/closures.js';
import { planEvacuation } from '../../features/wayfinding/planning.js';
import { calculateDistance } from '../../features/wayfinding/dijkstra.js';
import { recordRouteRequest } from '../../features/wayfinding/routeRequests.js';
import { recordAction } from '../../features/emergency/emergencyService.js';

const router = express.Router();

// Printed QR codes in the field encode qr_{buildingId}_{floor}_{nodeId} with
// Mongo ObjectId hex ids. Migrated rows keep those ids as their PKs, so the
// lookup below resolves old and new codes identically. The response envelope
// is CONTRACT: the deployed SPA reads these exact fields. New consumers use
// the added `route` (stepper shape) and `emergency` fields.

// Old payloads used the legacy type vocabulary; keep emitting it in the
// legacy fields so the deployed frontend keeps colouring nodes correctly.
const LEGACY_TYPE = {
  NORMAL: 'path',
  ENTRANCE: 'path',
  TRANSIT: 'stairs',
  POI: 'path',
  EMERGENCY_EXIT: 'exit',
};
const legacyType = (type) => LEGACY_TYPE[type] || 'path';

const buildFloorMapData = (floor) => {
  if (!floor) return null;
  return {
    floor: floor.name || String(floor.floorNumber),
    map: floor.mapImageUrl,
    qrCode: floor.qrCodeUrl,
    imageUrl: floor.mapImageUrl,
    svgContent: floor.svgContent || null,
    // Hand-drawn plan + its canvas size. Drawn floors have no image at all,
    // so without these the scan page showed an empty grid where the owner
    // had drawn a whole floor.
    drawing: floor.drawing || null,
    width: floor.width || null,
    height: floor.height || null,
    createdAt: floor.createdAt,
  };
};

router.get('/route/:qrId', publicReadLimiter, async (req, res) => {
  try {
    const { qrId } = req.params;

    const parsed = parseQrSlug(qrId);
    if (!parsed) {
      return res.status(400).json({ success: false, message: 'Invalid QR code format', qrId });
    }

    const { buildingId, floorNumber: floor, nodeId } = parsed;
    if (!isId(buildingId) || !isId(nodeId)) {
      return res.status(400).json({ success: false, message: 'Invalid building or node ID format', qrId });
    }

    const [node, building] = await Promise.all([
      prisma.node.findFirst({
        where: { id: nodeId, buildingId },
        include: { floor: true },
      }),
      prisma.building.findUnique({ where: { id: buildingId } }),
    ]);

    if (!node) return res.status(404).json({ success: false, message: 'Node not found', qrId });
    if (!building) return res.status(404).json({ success: false, message: 'Building not found', qrId });
    // FX-055: deactivating a building promises the owner its codes stop
    // resolving — the floor-QR scan already honours it with 410.
    if (building.isDeactivated) {
      return res.status(410).json({ success: false, message: 'This building is currently deactivated.', qrId });
    }

    // Whole-building graph (cached). Also the source for this floor's nodes.
    const graph = await getGraph(buildingId);

    const floorNodes = [...graph.nodes.values()]
      .filter((n) => n.floorId === node.floorId)
      .sort((a, b) => a.x - b.x || a.y - b.y);

    const neighbourIds = (id) => (graph.adj.get(id) || []).map((e) => e.to);

    const describe = (n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      type: legacyType(n.type),
      label: n.label || `${legacyType(n.type)} (${n.x}, ${n.y})`,
      floor: n.floorNumber,
      connections: neighbourIds(n.id),
    });

    // B16: bring the scan endpoint up to the same routing contract as
    // /api/wayfinding/evacuate — closures folded into an overlay, the cached
    // distance-to-safety field for the common case, alternative exits, and
    // real turn-by-turn instructions (assembleRoute builds those internally).
    //
    // LIFE-SAFETY RULE, same as /evacuate: this is an evacuation surface, so
    // visibility (EMERGENCY_ONLY edges) and blocking always come from the
    // `emergency` profile — never from an explicit `?profile=`. `wheelchair`
    // (`?profile=wheelchair` or `?accessible=true`) layers an accessibility
    // REQUIREMENT on top via `composeFilters`, with its own last-resort
    // fallback that drops it. Any OTHER named profile contributes COST
    // preferences only (`transitMultiplier`/`floorChangePenaltySec`, layered
    // onto the emergency-resolved profile below) — it is never allowed to
    // swap out the visibility/blocking rules a printed sticker's evacuation
    // route depends on, exactly like `/evacuate`'s `costOverlayName`.
    const parsedQuery = parseRoutingQuery(req.query);
    if (!parsedQuery.ok) {
      return res.status(400).json({ success: false, message: parsedQuery.error, qrId });
    }
    const activeClosures = await getActiveClosures(buildingId);
    const plan = planEvacuation({
      graph,
      activeClosures,
      originId: node.id,
      query: {
        name: parsedQuery.name,
        explicitProfile: typeof req.query.profile === 'string' && Boolean(req.query.profile),
        includeTags: parsedQuery.includeTags,
        excludeTags: parsedQuery.excludeTags,
        heading: parsedQuery.heading,
      },
    });
    if (!plan.ok) {
      return res.status(400).json({ success: false, message: plan.error, qrId });
    }
    const { result, closures, profileName } = plan;

    const found = Boolean(result);
    const pathNodes = found
      ? result.path.map((id) => graph.nodes.get(id)).filter(Boolean)
      : [];
    const exitNode = found ? pathNodes[pathNodes.length - 1] : null;

    // Legacy floorTransitions/walkingDistance semantics — unchanged shape,
    // now fed by the same search result the new `route` uses.
    const floorChanges = [];
    let walkingDistance = 0;
    for (let i = 1; i < pathNodes.length; i++) {
      if (pathNodes[i].floorNumber !== pathNodes[i - 1].floorNumber) {
        floorChanges.push({
          from: pathNodes[i - 1].floorNumber,
          to: pathNodes[i].floorNumber,
          atStep: i,
          nodeType: legacyType(pathNodes[i].type),
        });
      } else {
        walkingDistance += calculateDistance(
          pathNodes[i - 1].x,
          pathNodes[i - 1].y,
          pathNodes[i].x,
          pathNodes[i].y
        );
      }
    }
    walkingDistance = Math.round(walkingDistance);

    const emergencyRoute = {
      found,
      message: found ? null : 'No exit route found from this location',
      exitNodeId: exitNode ? exitNode.id : null,
      path: pathNodes.map((p) => p.id),
      distance: found ? pathNodes.length - 1 : 0, // hop count — CONTRACT, never meters/seconds
      walkingDistance,
      exitNode: exitNode
        ? {
            id: exitNode.id,
            x: exitNode.x,
            y: exitNode.y,
            type: legacyType(exitNode.type),
            label: exitNode.label || 'Emergency Exit',
            floor: exitNode.floorNumber,
          }
        : null,
    };

    // Stepper-shaped route for the redesigned viewer (instructions, warnings,
    // alternative exits), from the SAME search the legacy fields above used.
    const route = plan.route;

    // B13/B16: every scan is a route request too — this is the highest-
    // traffic call site (every printed sticker in the field), always an
    // evacuation search from the scanned node with no explicit `to`. Records
    // the profile actually used, not a hardcoded value — a scan under
    // `?profile=wheelchair` that falls back is still worth telling apart from
    // a plain `emergency` row.
    recordRouteRequest({
      buildingId,
      fromNodeId: node.id,
      to: null,
      profile: profileName,
      mode: 'EVACUATION',
      src: 'scan',
      found,
      distanceM: route?.totalDistanceM ?? null,
      durationSec: route?.totalDurationSec ?? null,
    });

    let activeEmergencyId = null;
    if (building.emergencyMode) {
      const activeEvent = await prisma.emergencyEvent.findFirst({
        where: { buildingId, status: 'ACTIVE' },
        select: { id: true },
        orderBy: { startedAt: 'desc' },
      });
      activeEmergencyId = activeEvent?.id || null;
    }

    const routeData = {
      qrId,
      buildingId,
      buildingName: building.name,
      floorNumber: String(floor),
      nodeId: node.id,
      nodeType: legacyType(node.type),
      nodeLabel: node.label || `${legacyType(node.type)} (${node.x}, ${node.y})`,
      nodePosition: { x: node.x, y: node.y },
      connectedNodes: floorNodes
        .filter((n) => neighbourIds(node.id).includes(n.id))
        .map(describe),
      allFloorNodes: floorNodes.map(describe),
      routeNodes: pathNodes.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        type: legacyType(p.type),
        label: p.label || legacyType(p.type),
        floor: p.floorNumber,
      })),
      floorTransitions: floorChanges,
      requiresFloorChange: floorChanges.length > 0,
      emergencyRoute,
      floorMap: buildFloorMapData(node.floor),
      timestamp: new Date().toISOString(),
      scanCount: (node.scanCount || 0) + 1,
      // ---- additions for the redesigned viewer ----
      route,
      closures,
      profile: profileName,
      emergency: {
        active: building.emergencyMode,
        message: building.emergencyMode ? building.emergencyMessage : null,
        emergencyId: activeEmergencyId,
      },
    };

    // Persist the scan. None of this may block or break the response — the
    // route above is what the person standing in the building actually needs.
    prisma.node
      .update({ where: { id: node.id }, data: { scanCount: { increment: 1 } } })
      .catch((err) => console.error('Failed to increment node scanCount:', err.message));

    if (building.emergencyMode === true) {
      try {
        const message = `new Scan on ${node.floor?.floorNumber} Floor near ${node.label || 'a checkpoint'}`;
        await recordAction(buildingId, 'scanned', { message, nodeId: node.id });
      } catch (logErr) {
        console.error('Failed to record emergency scan:', logErr.message);
      }
    }

    // Record the scan against a logged-in user's history. An expired or
    // malformed token must never stop an occupant getting their route.
    const userToken = req.cookies?.['userToken'];
    if (userToken) {
      try {
        const decoded = jwt.verify(userToken, config.jwt.secret, { algorithms: ['HS256'] });
        if (decoded?.userID) {
          await prisma.scanEvent.create({
            data: {
              buildingId,
              userId: decoded.userID,
              buildingName: building.name,
              nodeId: node.id,
            },
          });
        }
      } catch (tokenErr) {
        console.warn('Scan history not recorded (invalid token):', tokenErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Route data retrieved successfully',
      data: routeData,
    });
  } catch (error) {
    console.error('Error handling QR code scan:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while processing QR code scan',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

export default router;
