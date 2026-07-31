import express from 'express';
import jwt from 'jsonwebtoken';
import Node from '../../models/node.model.js';
import BUILDINGS from '../../models/building.model.js';
import USERS from '../../models/user.model.js';
import { isValidObjectId } from 'mongoose';
import LOGS from '../../models/logs.model.js';
import EMERGENCIES from '../../models/emergencies.model.js';
import { findShortestRoute, validateRoute, routeDistance } from '../../services/routingService.js';
import { publicReadLimiter } from '../../services/rateLimiter.js';

const router = express.Router();

// qr_<buildingId>_<floorNumber>_<nodeId>
const QR_PATTERN = /^qr_(.+)_(\d+)_(.+)$/;

/**
 * Resolve the floor's map entry from the building's embedded `maps` array.
 * Floor is stored as a string in some records and a number in others.
 */
const findFloorMap = (building, floor) => {
  const maps = building.maps || [];
  return (
    maps.find((map) => map.floor === String(floor)) ||
    maps.find((map) => parseInt(map.floor, 10) === floor) ||
    maps[0] ||
    null
  );
};

const buildFloorMapData = (floorMap) => {
  if (!floorMap) return null;

  const imageUrl = (() => {
    const map = floorMap.map;
    if (!map) return null;
    if (map.startsWith('http')) return map;

    const base = process.env.API_BASE_URL || 'https://www.alertup.world';
    if (map.startsWith('/uploads')) return `${base}${map}`;
    if (map.includes('uploads')) return `${base}/uploads${map.split('uploads')[1]}`;
    return null;
  })();

  return {
    floor: floorMap.floor,
    map: floorMap.map,
    qrCode: floorMap.qrCode,
    imageUrl,
    svgContent: floorMap.map?.includes('<svg') ? floorMap.map : null,
    createdAt: floorMap.createdAt,
  };
};

/**
 * GET /route/:qrId  (mounted at /api/qr/scan)
 *
 * The single entry point for a scanned QR code. The id is self-describing, so
 * no database record needs to exist for a printed code to work — which matters,
 * because nothing in the app ever created the QRCode documents the old
 * /api/route/:qrId endpoint looked for.
 */
router.get('/route/:qrId', publicReadLimiter, async (req, res) => {
  try {
    const { qrId } = req.params;

    const match = qrId.match(QR_PATTERN);
    if (!match) {
      return res.status(400).json({ success: false, message: 'Invalid QR code format', qrId });
    }

    const [, buildingId, floorNumber, nodeId] = match;

    if (!isValidObjectId(buildingId) || !isValidObjectId(nodeId)) {
      return res.status(400).json({ success: false, message: 'Invalid building or node ID format', qrId });
    }

    const floor = parseInt(floorNumber, 10);

    const [node, building] = await Promise.all([
      Node.findOne({ _id: nodeId, buildingId, floorNumber: floor }).lean(),
      BUILDINGS.findById(buildingId).lean(),
    ]);

    if (!node) return res.status(404).json({ success: false, message: 'Node not found', qrId });
    if (!building) return res.status(404).json({ success: false, message: 'Building not found', qrId });

    // Nodes on the scanned floor, for drawing the map.
    const floorNodes = await Node.find({ buildingId, floorNumber: floor }).sort({ x: 1, y: 1 }).lean();

    const describe = (n) => ({
      id: String(n._id),
      x: n.x,
      y: n.y,
      type: n.type,
      label: n.label || `${n.type} (${n.x}, ${n.y})`,
      floor: n.floorNumber,
      connections: (n.connections || []).map(String),
    });

    // Shortest route to the nearest exit, across floors where necessary.
    let route = [];
    let routeError = null;
    try {
      route = await findShortestRoute(node._id);
    } catch (err) {
      routeError = err.message;
    }

    const found = route.length > 0;
    const exitNode = found ? route[route.length - 1] : null;
    const transitions = found ? validateRoute(route) : { floorChanges: [], hasStairs: false };

    const emergencyRoute = {
      found,
      message: routeError,
      exitNodeId: exitNode ? String(exitNode._id) : null,
      // Node ids in walking order — the map layer resolves these to coordinates.
      path: route.map((point) => String(point._id)),
      // Hop count, kept for the existing "N steps" label in the UI.
      distance: found ? route.length - 1 : 0,
      // Physical walking distance in SVG units, ignoring floor changes.
      walkingDistance: routeDistance(route),
      exitNode: exitNode
        ? {
            id: String(exitNode._id),
            x: exitNode.x,
            y: exitNode.y,
            type: exitNode.type,
            label: exitNode.label || 'Emergency Exit',
            floor: exitNode.floor,
          }
        : null,
    };

    const routeData = {
      qrId,
      buildingId,
      buildingName: building.buildingName,
      floorNumber,
      nodeId: node._id,
      nodeType: node.type,
      nodeLabel: node.label || `${node.type} (${node.x}, ${node.y})`,
      nodePosition: { x: node.x, y: node.y },
      connectedNodes: floorNodes
        .filter((n) => (node.connections || []).some((c) => String(c) === String(n._id)))
        .map(describe),
      allFloorNodes: floorNodes.map(describe),
      // Full node objects for every step of the route, including steps on other
      // floors. `allFloorNodes` only covers the scanned floor, so a multi-floor
      // route cannot be drawn from it alone.
      routeNodes: route.map((point) => ({
        id: String(point._id),
        x: point.x,
        y: point.y,
        type: point.type,
        label: point.label || point.type,
        floor: point.floor,
      })),
      floorTransitions: transitions.floorChanges,
      requiresFloorChange: transitions.hasStairs,
      emergencyRoute,
      floorMap: buildFloorMapData(findFloorMap(building, floor)),
      timestamp: new Date().toISOString(),
      scanCount: (node.scanCount || 0) + 1,
    };

    // Persist the scan. None of this may block or break the response — the
    // route above is what the person standing in the building actually needs.
    Node.findByIdAndUpdate(nodeId, { $inc: { scanCount: 1 } }).catch((err) =>
      console.error('Failed to increment node scanCount:', err.message)
    );

    if (building.emergencyMode === true) {
      try {
        await LOGS.create({
          logType: 'scan',
          logMessage: `new Scan on ${node.floorNumber} Floor near ${node.label}`,
          buildingID: node.buildingId,
          isEmergency: true,
        });
        await EMERGENCIES.findOneAndUpdate(
          { buildingID: building._id, isFinished: false },
          { $inc: { scanned: 1 } },
          { new: true }
        );
      } catch (logErr) {
        console.error('Failed to record emergency scan:', logErr.message);
      }
    }

    // Record the scan against a logged-in user's history. An expired or
    // malformed token must never stop an occupant getting their route.
    const userToken = req.cookies?.['userToken'];
    if (userToken) {
      try {
        const decoded = jwt.verify(userToken, process.env.JWT_SECRET);
        await USERS.findOneAndUpdate(
          { _id: decoded.userID },
          { $push: { scanned: { buildingName: building.buildingName, scannedAt: Date.now(), buildingID: building._id } } },
          { new: true }
        );
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
