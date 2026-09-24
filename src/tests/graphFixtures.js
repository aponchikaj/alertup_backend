import {
  calculateDistance,
  DEFAULT_TRANSIT_COST,
} from '../features/wayfinding/dijkstra.js';
import { ASSUMED_PIXELS_PER_METER } from '../features/wayfinding/costModel.js';

/**
 * In-memory graph fixtures shaped exactly like `graphService.loadBuildingGraph`
 * output, so pure routing units (dijkstra, cost model, route assembler) can be
 * tested without a database.
 *
 * spec: {
 *   nodes: [{id, x, y, type, label, floorNumber, level, scale, visibility, externalId}],
 *   edges: [[a, b, opts?]]
 * }
 * opts: {weight, transitType, accessible, edgeId, lengthM, direction, tags,
 *        rank, visibility}
 *
 * Floors get synthetic ids `floor-<n>`; edges are expanded the way graphService
 * expands the Edge table (BOTH both ways, FORWARD source→target, REVERSE
 * target→source) and every `adj[a]→b` push is mirrored into `radj[b]`.
 */

/**
 * The assumed scale for uncalibrated floors, re-exported so a test can assert
 * against it without a second import. It is the cost model's constant, not a
 * fixture-local copy — a duplicate here would let the fixture and the code it
 * stands in for drift apart.
 */
export { ASSUMED_PIXELS_PER_METER };

let edgeSeq = 0;

export function buildGraph({ nodes, edges }) {
  const nodeMap = new Map();
  const floors = new Map();
  for (const n of nodes) {
    const floorNumber = n.floorNumber ?? 1;
    const floorId = `floor-${floorNumber}`;
    if (!floors.has(floorId)) {
      floors.set(floorId, {
        id: floorId,
        floorNumber,
        name: `Floor ${floorNumber}`,
        shortName: n.shortName ?? null,
        verticalOrder: n.verticalOrder ?? null,
        scalePixelsPerMeter: n.scale ?? null,
      });
    }
    nodeMap.set(n.id, {
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      type: n.type ?? 'NORMAL',
      label: n.label ?? null,
      floorId,
      floorNumber,
      level: n.level ?? n.verticalOrder ?? floorNumber,
      visibility: n.visibility ?? 'PUBLIC',
      externalId: n.externalId ?? null,
    });
  }

  const adj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  const radj = new Map([...nodeMap.keys()].map((id) => [id, []]));
  const edgesById = new Map();

  const push = (from, to, entry) => {
    adj.get(from).push({ ...entry, to });
    radj.get(to).push({ ...entry, to: from });
  };

  for (const [a, b, opts = {}] of edges) {
    const na = nodeMap.get(a);
    const nb = nodeMap.get(b);
    const crossFloor = na.floorId !== nb.floorId;
    const transitType = opts.transitType ?? (crossFloor ? 'STAIRS' : 'WALKWAY');
    const distance = crossFloor ? 0 : calculateDistance(na.x, na.y, nb.x, nb.y);
    const cost =
      opts.weight ?? (crossFloor ? DEFAULT_TRANSIT_COST[transitType] : distance);
    const accessible =
      opts.accessible ?? (!crossFloor || transitType === 'ELEVATOR');
    const scale = floors.get(na.floorId)?.scalePixelsPerMeter ?? null;

    let lengthM = opts.lengthM ?? null;
    let lengthMAssumed = false;
    if (lengthM === null && !crossFloor) {
      lengthM = cost / (scale ?? ASSUMED_PIXELS_PER_METER);
      lengthMAssumed = scale === null;
    }

    const entry = {
      edgeId: opts.edgeId ?? `fixture-edge-${(edgeSeq += 1)}`,
      cost,
      distance,
      lengthM,
      lengthMAssumed,
      transitType,
      accessible,
      direction: opts.direction ?? 'BOTH',
      tags: opts.tags ?? [],
      rank: opts.rank ?? 'PRIMARY',
      visibility: opts.visibility ?? 'PUBLIC',
    };

    edgesById.set(entry.edgeId, {
      ...entry,
      sourceNodeId: a,
      targetNodeId: b,
    });

    if (entry.direction === 'BOTH' || entry.direction === 'FORWARD') {
      push(a, b, { ...entry, forward: true });
    }
    if (entry.direction === 'BOTH' || entry.direction === 'REVERSE') {
      push(b, a, { ...entry, forward: false });
    }
  }

  return {
    buildingId: 'fixture-building',
    nodes: nodeMap,
    adj,
    radj,
    floors,
    edgesById,
    routingProfile: null,
    unscaledFloorIds: new Set(
      [...floors.values()]
        .filter((f) => !f.scalePixelsPerMeter || f.scalePixelsPerMeter <= 0)
        .map((f) => f.id)
    ),
    loadedAt: Date.now(),
  };
}

export default buildGraph;
