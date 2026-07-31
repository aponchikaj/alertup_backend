import prisma from '../../db/prisma.js';
import { MAX_NODES } from './dijkstra.js';

/**
 * Load a building's routing graph in three flat queries and index it for the
 * pathfinder. Edges are stored once (source < target) and expanded into both
 * directions here — mirroring is a load-time concern now, not a write-time
 * invariant maintained by hand across four call sites.
 *
 * @returns {{nodes: Map, adj: Map, floors: Map}}
 */
export async function loadBuildingGraph(buildingId) {
  const [floors, nodes, edges] = await Promise.all([
    prisma.floor.findMany({
      where: { buildingId },
      select: {
        id: true,
        floorNumber: true,
        name: true,
        mapImageUrl: true,
        svgContent: true,
        width: true,
        height: true,
        scalePixelsPerMeter: true,
      },
    }),
    prisma.node.findMany({
      where: { buildingId },
      take: MAX_NODES,
      select: {
        id: true,
        x: true,
        y: true,
        type: true,
        label: true,
        floorId: true,
        floor: { select: { floorNumber: true } },
        poi: { select: { id: true, name: true, category: true } },
      },
    }),
    prisma.edge.findMany({
      where: { buildingId },
      select: {
        sourceNodeId: true,
        targetNodeId: true,
        weight: true,
        distance: true,
        transitType: true,
        accessible: true,
      },
    }),
  ]);

  const floorMap = new Map(floors.map((f) => [f.id, f]));
  const nodeMap = new Map(
    nodes.map((n) => [
      n.id,
      {
        id: n.id,
        x: n.x,
        y: n.y,
        type: n.type,
        label: n.label,
        floorId: n.floorId,
        floorNumber: n.floor?.floorNumber ?? null,
        hasPoi: Boolean(n.poi),
        poi: n.poi || null,
      },
    ])
  );

  const adj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  for (const edge of edges) {
    if (!nodeMap.has(edge.sourceNodeId) || !nodeMap.has(edge.targetNodeId)) continue;
    const entry = {
      cost: edge.weight,
      transitType: edge.transitType,
      accessible: edge.accessible,
      distance: edge.distance,
    };
    adj.get(edge.sourceNodeId).push({ ...entry, to: edge.targetNodeId });
    adj.get(edge.targetNodeId).push({ ...entry, to: edge.sourceNodeId });
  }

  return { nodes: nodeMap, adj, floors: floorMap };
}
