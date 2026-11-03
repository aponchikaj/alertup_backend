import prisma from '../../db/prisma.js';
import { calculateDistance, DEFAULT_TRANSIT_COST } from '../wayfinding/dijkstra.js';

// Edge invariants live here: normalized pair order (source < target), computed
// distance, and the weight actually used by the router.
//
// `direction` is ALWAYS relative to the edge's stored (and returned)
// `sourceNodeId` → `targetNodeId`, never to the order a caller passed the two
// nodes in. Storage sorts the pair, so about half of all calls have their ends
// swapped on the way in; re-interpreting `direction` against the caller's
// orientation would make it mean one thing on create and another on update,
// and a client that PATCHed back the value it was just handed would flip a
// one-way corridor. So: create and update both take it verbatim, and what the
// API returns after a create is exactly what a later PATCH reproduces. A
// client that tracks its own "as drawn A→B" orientation is responsible for
// comparing against the returned `sourceNodeId`.

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
 *
 * `client` defaults to the module-level `prisma` but accepts a
 * `prisma.$transaction(async (tx) => ...)` client too, so a caller that needs
 * the create and its audit row to commit or roll back together can pass `tx`
 * straight through instead of duplicating this function's logic inline.
 *
 * @throws {Error} with .status for client errors
 */
export async function createEdge({
  sourceNodeId,
  targetNodeId,
  transitType = 'WALKWAY',
  weight = null,
  accessible = null,
  // Routing metadata, all plain pass-throughs — `direction` included: it reads
  // against the STORED pair order (see the module header), not against the
  // order these two arguments arrived in. `null`/`undefined` leaves the column
  // at its schema default.
  direction = null,
  tags = null,
  rank = null,
  visibility = null,
  lengthM = null,
  // Legacy /api/nodes shim: the old model connected nodes across floors with
  // no transit type. When set, cross-floor WALKWAY silently becomes STAIRS
  // (the old FLOOR_CHANGE semantics) instead of a validation error.
  inferCrossFloorTransit = false,
  client = prisma,
}) {
  if (sourceNodeId === targetNodeId) {
    const err = new Error('A node cannot connect to itself.');
    err.status = 422;
    throw err;
  }

  const [a, b] = await Promise.all([
    client.node.findUnique({ where: { id: sourceNodeId } }),
    client.node.findUnique({ where: { id: targetNodeId } }),
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
    return await client.edge.create({
      data: {
        sourceNodeId: sourceId,
        targetNodeId: targetId,
        buildingId: a.buildingId,
        distance,
        weight: effectiveWeight,
        transitType,
        accessible: effectiveAccessible,
        ...(direction ? { direction } : {}),
        ...(tags ? { tags } : {}),
        ...(rank ? { rank } : {}),
        ...(visibility ? { visibility } : {}),
        ...(lengthM === null || lengthM === undefined ? {} : { lengthM }),
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
