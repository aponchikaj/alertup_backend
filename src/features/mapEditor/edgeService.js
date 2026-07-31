import prisma from '../../db/prisma.js';
import { calculateDistance, DEFAULT_TRANSIT_COST } from '../wayfinding/dijkstra.js';

// Edge invariants live here: normalized pair order (source < target), computed
// distance, and the weight actually used by the router.

export function normalizePair(aId, bId) {
  return aId < bId ? [aId, bId] : [bId, aId];
}

export function computeEdgeGeometry(nodeA, nodeB, { transitType = 'WALKWAY', weight = null } = {}) {
  const crossFloor = nodeA.floorId !== nodeB.floorId;
  const distance = crossFloor
    ? 0
    : calculateDistance(nodeA.x, nodeA.y, nodeB.x, nodeB.y);
  const effectiveWeight =
    weight ?? (crossFloor ? DEFAULT_TRANSIT_COST[transitType] ?? DEFAULT_TRANSIT_COST.STAIRS : distance);
  return { crossFloor, distance, weight: effectiveWeight };
}

/**
 * Create an edge between two nodes of the same building.
 * @throws {Error} with .status for client errors
 */
export async function createEdge({
  sourceNodeId,
  targetNodeId,
  transitType = 'WALKWAY',
  weight = null,
  accessible = null,
  // Legacy /api/nodes shim: the old model connected nodes across floors with
  // no transit type. When set, cross-floor WALKWAY silently becomes STAIRS
  // (the old FLOOR_CHANGE semantics) instead of a validation error.
  inferCrossFloorTransit = false,
}) {
  if (sourceNodeId === targetNodeId) {
    const err = new Error('A node cannot connect to itself.');
    err.status = 422;
    throw err;
  }

  const [a, b] = await Promise.all([
    prisma.node.findUnique({ where: { id: sourceNodeId } }),
    prisma.node.findUnique({ where: { id: targetNodeId } }),
  ]);
  if (!a || !b) {
    const err = new Error('Both nodes must exist.');
    err.status = 404;
    throw err;
  }
  if (a.buildingId !== b.buildingId) {
    const err = new Error('Nodes belong to different buildings.');
    err.status = 422;
    throw err;
  }

  const crossFloorPreview = a.floorId !== b.floorId;
  if (crossFloorPreview && transitType === 'WALKWAY' && inferCrossFloorTransit) {
    transitType = 'STAIRS';
  }

  const { crossFloor, distance, weight: effectiveWeight } = computeEdgeGeometry(a, b, {
    transitType,
    weight,
  });

  if (crossFloor && transitType === 'WALKWAY') {
    const err = new Error(
      'Cross-floor connections need a transit type (STAIRS, ELEVATOR or ESCALATOR).'
    );
    err.status = 422;
    throw err;
  }

  const [sourceId, targetId] = normalizePair(a.id, b.id);
  // Default accessibility: powered/level transit is accessible, stairs and
  // escalators are not (wheelchairs).
  const effectiveAccessible =
    accessible ?? !(transitType === 'STAIRS' || transitType === 'ESCALATOR');

  try {
    return await prisma.edge.create({
      data: {
        sourceNodeId: sourceId,
        targetNodeId: targetId,
        buildingId: a.buildingId,
        distance,
        weight: effectiveWeight,
        transitType,
        accessible: effectiveAccessible,
      },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      const dup = new Error('These nodes are already connected.');
      dup.status = 409;
      throw dup;
    }
    throw err;
  }
}

/**
 * A node moved: recompute distance (and weight where weight tracked distance)
 * for every same-floor edge touching it.
 */
export async function recomputeEdgesForNode(nodeId) {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) return;

  const edges = await prisma.edge.findMany({
    where: { OR: [{ sourceNodeId: nodeId }, { targetNodeId: nodeId }] },
  });

  for (const edge of edges) {
    const otherId = edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
    const other = await prisma.node.findUnique({ where: { id: otherId } });
    if (!other || other.floorId !== node.floorId) continue; // cross-floor: fixed cost

    const distance = calculateDistance(node.x, node.y, other.x, other.y);
    // If weight was tracking distance (no manual override), keep tracking it.
    const weightTrackedDistance = Math.abs(edge.weight - edge.distance) < 1e-6;
    await prisma.edge.update({
      where: { id: edge.id },
      data: {
        distance,
        ...(weightTrackedDistance ? { weight: distance } : {}),
      },
    });
  }
}
