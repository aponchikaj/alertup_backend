import prisma from '../../db/prisma.js';
import { MAX_NODES } from './dijkstra.js';

/**
 * Pixels per metre assumed for a floor whose owner never calibrated a scale.
 * Matches the assumption `autoConnect.js` and the wayfinding routes already
 * document, so a route on an unscaled floor still reports metres and minutes —
 * flagged, never silently precise.
 */
export const ASSUMED_PIXELS_PER_METER = 50;

/** A weight that no longer tracks the on-canvas distance was set by hand. */
const isManualWeight = (edge) => Math.abs(edge.weight - edge.distance) > 1e-6;

/**
 * Load a building's routing graph in four flat queries and index it for the
 * pathfinder. Edges are stored once (source < target) and expanded here
 * according to `direction` — mirroring is a load-time concern, not a
 * write-time invariant maintained by hand across four call sites.
 *
 * Every adjacency entry carries the edge's identity and routing metadata so
 * the assembler can describe a step (which edge, how long in metres, one-way
 * or not, primary or service route) without a second query.
 *
 * @returns {{buildingId: string, nodes: Map, adj: Map, radj: Map, floors: Map,
 *            edgesById: Map, routingProfile: object|null,
 *            unscaledFloorIds: Set<string>, loadedAt: number}}
 *   adj:  Map<nodeId, Array<entry>>  outgoing traversals
 *   radj: Map<nodeId, Array<entry>>  incoming traversals, `to` pointing back
 *         at the predecessor so a reverse search reuses the same Dijkstra
 */
export async function loadBuildingGraph(buildingId) {
  const [floors, nodes, edges, building] = await Promise.all([
    prisma.floor.findMany({
      where: { buildingId },
      select: {
        id: true,
        floorNumber: true,
        name: true,
        shortName: true,
        verticalOrder: true,
        mapImageUrl: true,
        svgContent: true,
        drawing: true,
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
        visibility: true,
        externalId: true,
        floor: { select: { floorNumber: true, verticalOrder: true } },
        poi: { select: { id: true, name: true, category: true } },
      },
    }),
    prisma.edge.findMany({
      where: { buildingId },
      select: {
        id: true,
        sourceNodeId: true,
        targetNodeId: true,
        weight: true,
        distance: true,
        transitType: true,
        accessible: true,
        lengthM: true,
        direction: true,
        tags: true,
        rank: true,
        visibility: true,
      },
    }),
    prisma.building.findUnique({
      where: { id: buildingId },
      select: { routingProfile: true },
    }),
  ]);

  const floorMap = new Map(floors.map((f) => [f.id, f]));
  const unscaledFloorIds = new Set(
    floors.filter((f) => !(f.scalePixelsPerMeter > 0)).map((f) => f.id)
  );

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
        // Routing orders floors by verticalOrder where the owner set one;
        // floorNumber can be non-contiguous (basements, mezzanines).
        level: n.floor?.verticalOrder ?? n.floor?.floorNumber ?? null,
        visibility: n.visibility,
        externalId: n.externalId ?? null,
        hasPoi: Boolean(n.poi),
        poi: n.poi || null,
      },
    ])
  );

  const adj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  const radj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  const edgesById = new Map();

  const push = (from, to, entry) => {
    adj.get(from).push({ ...entry, to });
    radj.get(to).push({ ...entry, to: from });
  };

  for (const edge of edges) {
    const source = nodeMap.get(edge.sourceNodeId);
    const target = nodeMap.get(edge.targetNodeId);
    if (!source || !target) continue;

    const crossFloor = source.floorId !== target.floorId;
    const scale = floorMap.get(source.floorId)?.scalePixelsPerMeter ?? null;

    // Metres, in order of trustworthiness: a measured length, then the pixel
    // length the router actually uses (a hand-set weight overrules the
    // on-canvas distance) converted with the floor's scale, then the same
    // conversion with the assumed scale. Cross-floor pixels are a fixed
    // transit cost, not a length, so they stay null.
    let lengthM = null;
    let lengthMAssumed = false;
    if (edge.lengthM !== null && edge.lengthM !== undefined) {
      lengthM = edge.lengthM;
    } else if (!crossFloor) {
      const px = isManualWeight(edge) ? edge.weight : edge.distance;
      if (scale > 0) {
        lengthM = px / scale;
      } else {
        lengthM = px / ASSUMED_PIXELS_PER_METER;
        lengthMAssumed = true;
      }
    }

    const entry = {
      edgeId: edge.id,
      cost: edge.weight,
      distance: edge.distance,
      lengthM,
      lengthMAssumed,
      transitType: edge.transitType,
      accessible: edge.accessible,
      direction: edge.direction,
      tags: edge.tags,
      rank: edge.rank,
      visibility: edge.visibility,
    };

    edgesById.set(edge.id, {
      ...entry,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
    });

    if (edge.direction === 'BOTH' || edge.direction === 'FORWARD') {
      push(edge.sourceNodeId, edge.targetNodeId, { ...entry, forward: true });
    }
    if (edge.direction === 'BOTH' || edge.direction === 'REVERSE') {
      push(edge.targetNodeId, edge.sourceNodeId, { ...entry, forward: false });
    }
  }

  return {
    buildingId,
    nodes: nodeMap,
    adj,
    radj,
    floors: floorMap,
    edgesById,
    routingProfile: building?.routingProfile ?? null,
    unscaledFloorIds,
    loadedAt: Date.now(),
  };
}
