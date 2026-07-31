import express from 'express';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import { requirePermission } from '../../middlewares/requireBuildingPermission.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import { isId } from '../../utils/ids.js';
import { createEdge, recomputeEdgesForNode, normalizePair } from '../../features/mapEditor/edgeService.js';
import { invalidate } from '../../features/wayfinding/graphCache.js';

const router = express.Router();

// LEGACY COMPATIBILITY SHIM for the deployed node manager UI. The new editor
// talks to /api/map-editor/*; this router keeps the old /api/nodes contract
// (legacy type vocabulary, embedded connections[], Mongo-style _id) working on
// top of the Prisma tables until the frontend transition completes.

const TO_NEW_TYPE = { path: 'NORMAL', exit: 'EMERGENCY_EXIT', stairs: 'TRANSIT' };
const TO_LEGACY_TYPE = {
  NORMAL: 'path',
  ENTRANCE: 'path',
  POI: 'path',
  EMERGENCY_EXIT: 'exit',
  TRANSIT: 'stairs',
};

const guard = [whoami, requirePermission(PERMISSIONS.CAN_EDIT_MAP)];

async function connectionsByNode(buildingId) {
  const edges = await prisma.edge.findMany({
    where: { buildingId },
    select: { sourceNodeId: true, targetNodeId: true },
  });
  const map = new Map();
  const push = (a, b) => {
    if (!map.has(a)) map.set(a, []);
    map.get(a).push(b);
  };
  for (const e of edges) {
    push(e.sourceNodeId, e.targetNodeId);
    push(e.targetNodeId, e.sourceNodeId);
  }
  return map;
}

const legacyNode = (node, connections) => ({
  _id: node.id,
  id: node.id,
  buildingId: node.buildingId,
  floorNumber: node.floorNumber,
  x: node.x,
  y: node.y,
  type: TO_LEGACY_TYPE[node.type] || 'path',
  label: node.label ?? undefined,
  connections: connections || [],
  scanCount: node.scanCount,
  createdAt: node.createdAt,
  updatedAt: node.updatedAt,
});

async function floorFor(buildingId, floorNumber) {
  const existing = await prisma.floor.findUnique({
    where: { buildingId_floorNumber: { buildingId, floorNumber } },
  });
  if (existing) return existing;
  // The old data model allowed nodes on floors with no Floor record; keep that
  // behaviour by creating a placeholder row.
  return prisma.floor.create({
    data: { buildingId, floorNumber, name: `Floor ${floorNumber}` },
  });
}

const validateNodeData = (data) => {
  const errors = [];
  if (!data.buildingId || !isId(String(data.buildingId))) {
    errors.push('Valid building ID is required');
  }
  if (typeof data.floorNumber !== 'number' || data.floorNumber < 0) {
    errors.push('Valid floor number is required');
  }
  if (typeof data.x !== 'number' || typeof data.y !== 'number') {
    errors.push('Valid x, y coordinates are required');
  }
  if (!data.type || !['path', 'exit', 'stairs'].includes(data.type)) {
    errors.push('Type must be path, exit, or stairs');
  }
  return errors;
};

router.post('/api/nodes', ...guard, async (req, res) => {
  try {
    const { buildingId, floorNumber, x, y, type, label, connections } = req.body;

    const validationErrors = validateNodeData(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors,
      });
    }

    const floor = await floorFor(req.building.id, floorNumber);
    const node = await prisma.node.create({
      data: {
        buildingId: req.building.id,
        floorId: floor.id,
        x,
        y,
        type: TO_NEW_TYPE[type],
        label: label || null,
      },
    });

    // Same-building filter + symmetric write, now guaranteed by the edges table.
    const created = [];
    if (Array.isArray(connections)) {
      for (const otherId of connections.filter((c) => isId(String(c)))) {
        try {
          await createEdge({ sourceNodeId: node.id, targetNodeId: otherId, inferCrossFloorTransit: true });
          created.push(otherId);
        } catch {
          // dangling/cross-building/duplicate — legacy behaviour was to skip
        }
      }
    }

    invalidate(req.building.id);
    res.json({
      success: true,
      message: 'Node created successfully',
      node: legacyNode({ ...node, floorNumber }, created),
    });
  } catch (error) {
    console.error('Error creating node:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

router.get('/api/nodes/building/:buildingId', ...guard, async (req, res) => {
  try {
    const nodes = await prisma.node.findMany({
      where: { buildingId: req.building.id },
      include: { floor: { select: { floorNumber: true } } },
      orderBy: [{ x: 'asc' }, { y: 'asc' }],
    });
    const connections = await connectionsByNode(req.building.id);

    const shaped = nodes
      .map((n) =>
        legacyNode(
          { ...n, floorNumber: n.floor?.floorNumber ?? 0 },
          connections.get(n.id) || []
        )
      )
      .sort((a, b) => a.floorNumber - b.floorNumber || a.x - b.x || a.y - b.y);

    res.status(200).json({ success: true, nodes: shaped });
  } catch (error) {
    console.error('Error fetching nodes:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

router.put('/api/nodes/:nodeId', ...guard, async (req, res) => {
  try {
    const { nodeId } = req.params;
    const { x, y, type, label, connections } = req.body;

    const node = await prisma.node.findFirst({
      where: { id: nodeId, buildingId: req.building.id },
      include: { floor: { select: { floorNumber: true } } },
    });
    if (!node) {
      return res.status(404).json({ success: false, message: 'Node not found' });
    }

    const updateData = {};
    if (x !== undefined) {
      if (typeof x !== 'number' || x < 0) {
        return res.status(400).json({ success: false, message: 'Invalid x coordinate' });
      }
      updateData.x = x;
    }
    if (y !== undefined) {
      if (typeof y !== 'number' || y < 0) {
        return res.status(400).json({ success: false, message: 'Invalid y coordinate' });
      }
      updateData.y = y;
    }
    if (type !== undefined) {
      if (!['path', 'exit', 'stairs'].includes(type)) {
        return res
          .status(400)
          .json({ success: false, message: 'Type must be path, exit, or stairs' });
      }
      updateData.type = TO_NEW_TYPE[type];
    }
    if (label !== undefined) {
      updateData.label = label || null;
    }

    const updated = await prisma.node.update({
      where: { id: node.id },
      data: updateData,
    });

    if (updateData.x !== undefined || updateData.y !== undefined) {
      await recomputeEdgesForNode(node.id);
    }

    // Diff the connections list against current edges, symmetric by table design.
    let finalConnections;
    if (connections !== undefined) {
      if (!Array.isArray(connections)) {
        return res
          .status(400)
          .json({ success: false, message: 'Connections must be an array' });
      }
      const valid = connections.filter((c) => isId(String(c)));
      const inBuilding = await prisma.node.findMany({
        where: { id: { in: valid }, buildingId: req.building.id },
        select: { id: true },
      });
      const after = new Set(inBuilding.map((n) => n.id));

      const map = await connectionsByNode(req.building.id);
      const before = new Set(map.get(node.id) || []);

      for (const otherId of after) {
        if (!before.has(otherId)) {
          try {
            await createEdge({ sourceNodeId: node.id, targetNodeId: otherId, inferCrossFloorTransit: true });
          } catch {
            // duplicate/cross-floor without transit — skip like legacy
          }
        }
      }
      for (const otherId of before) {
        if (!after.has(otherId)) {
          const [s, t] = normalizePair(node.id, otherId);
          await prisma.edge.deleteMany({
            where: { sourceNodeId: s, targetNodeId: t },
          });
        }
      }
      finalConnections = [...after];
    }

    if (finalConnections === undefined) {
      const map = await connectionsByNode(req.building.id);
      finalConnections = map.get(node.id) || [];
    }

    invalidate(req.building.id);
    res.status(200).json({
      success: true,
      message: 'Node updated successfully',
      node: legacyNode(
        { ...updated, floorNumber: node.floor?.floorNumber ?? 0 },
        finalConnections
      ),
    });
  } catch (error) {
    console.error('Error updating node:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating node',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

router.delete('/api/nodes/:nodeId', ...guard, async (req, res) => {
  try {
    const { nodeId } = req.params;
    const node = await prisma.node.findFirst({
      where: { id: nodeId, buildingId: req.building.id },
    });
    if (!node) {
      return res.status(404).json({ success: false, message: 'Node not found' });
    }

    // FK cascade removes incident edges and any POI.
    await prisma.node.delete({ where: { id: node.id } });
    invalidate(req.building.id);

    res.status(200).json({
      success: true,
      message: 'Node deleted successfully',
      data: { deletedNodeId: nodeId, buildingId: node.buildingId },
    });
  } catch (error) {
    console.error('Error deleting node:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting node',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

router.post('/api/nodes/connect', ...guard, async (req, res) => {
  try {
    const { buildingId, node1Id, node2Id } = req.body;

    if (!buildingId || !node1Id || !node2Id) {
      return res.status(400).json({
        success: false,
        message: 'buildingId, node1Id, and node2Id are required',
      });
    }
    if (!isId(String(node1Id)) || !isId(String(node2Id))) {
      return res.status(400).json({ success: false, message: 'Invalid ID format' });
    }
    if (node1Id === node2Id) {
      return res
        .status(400)
        .json({ success: false, message: 'Cannot connect a node to itself' });
    }

    const [node1, node2] = await Promise.all([
      prisma.node.findUnique({ where: { id: node1Id }, include: { floor: true } }),
      prisma.node.findUnique({ where: { id: node2Id }, include: { floor: true } }),
    ]);
    if (!node1 || !node2) {
      return res.status(404).json({ success: false, message: 'One or both nodes not found' });
    }
    if (node1.buildingId !== req.building.id || node2.buildingId !== req.building.id) {
      return res.status(400).json({
        success: false,
        message: 'Nodes must belong to the specified building',
      });
    }

    try {
      await createEdge({ sourceNodeId: node1Id, targetNodeId: node2Id, inferCrossFloorTransit: true });
    } catch (err) {
      if (err.status === 409) {
        return res
          .status(400)
          .json({ success: false, message: 'Nodes are already connected' });
      }
      throw err;
    }

    invalidate(req.building.id);
    const map = await connectionsByNode(req.building.id);
    res.status(200).json({
      success: true,
      message: 'Nodes connected successfully',
      data: {
        connection: {
          buildingId,
          node1Id,
          node2Id,
          node1: legacyNode(
            { ...node1, floorNumber: node1.floor?.floorNumber ?? 0 },
            map.get(node1.id) || []
          ),
          node2: legacyNode(
            { ...node2, floorNumber: node2.floor?.floorNumber ?? 0 },
            map.get(node2.id) || []
          ),
        },
      },
    });
  } catch (error) {
    console.error('Error connecting nodes:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while connecting nodes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

export default router;
