import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../db/prisma.js';
import config from '../../config/index.js';
import { isId } from '../../utils/ids.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';
import { parseQrSlug } from '../../features/qr/qrPayload.js';
import { getGraph } from '../../features/wayfinding/graphCache.js';
import { findEvacuationRoute } from '../../features/wayfinding/dijkstra.js';
import { assembleRoute } from '../../features/wayfinding/routeAssembler.js';
import { calculateDistance } from '../../features/wayfinding/dijkstra.js';
import { publish } from '../../features/realtime/broadcaster.js';

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

    // Evacuation route to the nearest exit, across floors where necessary.
    const evac = findEvacuationRoute(graph, node.id);
    const found = Boolean(evac);
    const pathNodes = found
      ? evac.path.map((id) => graph.nodes.get(id)).filter(Boolean)
      : [];
    const exitNode = found ? pathNodes[pathNodes.length - 1] : null;

    // Legacy floorTransitions/walkingDistance semantics.
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
      distance: found ? pathNodes.length - 1 : 0,
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

    // New stepper-shaped route for the redesigned viewer.
    const route = found
      ? assembleRoute(graph, evac.path, { mode: 'EVACUATION' })
      : null;

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
        await prisma.$transaction([
          prisma.log.create({
            data: { buildingId, type: 'SCAN', isEmergency: true, message },
          }),
          prisma.emergencyEvent.updateMany({
            where: { buildingId, status: 'ACTIVE' },
            data: { scanned: { increment: 1 } },
          }),
        ]);
        publish(buildingId, 'log_appended', {
          message,
          type: 'SCAN',
          createdAt: new Date().toISOString(),
        });
      } catch (logErr) {
        console.error('Failed to record emergency scan:', logErr.message);
      }
    }

    // Record the scan against a logged-in user's history. An expired or
    // malformed token must never stop an occupant getting their route.
    const userToken = req.cookies?.['userToken'];
    if (userToken) {
      try {
        const decoded = jwt.verify(userToken, config.jwt.secret);
        if (decoded?.userID) {
          await prisma.scanEvent.create({
            data: {
              buildingId,
              userId: decoded.userID,
              buildingName: building.name,
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
