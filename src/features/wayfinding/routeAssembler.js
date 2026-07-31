import { calculateDistance } from './dijkstra.js';

const toStepNode = (node) => ({
  id: node.id,
  x: node.x,
  y: node.y,
  type: node.type,
  label: node.label || null,
});

const floorSummary = (floor) =>
  floor
    ? {
        id: floor.id,
        floorNumber: floor.floorNumber,
        name: floor.name || null,
        mapImageUrl: floor.mapImageUrl || null,
        // Hand-drawn plans travel with the segment for the same reason the
        // image URL does: the visitor map must render the floor without a
        // second request. Bounded by the editor's shape/byte caps, and a route
        // crosses any given floor once, so the repetition stays cheap.
        drawing: floor.drawing || null,
        width: floor.width || null,
        height: floor.height || null,
        scalePixelsPerMeter: floor.scalePixelsPerMeter || null,
      }
    : null;

const pxToMeters = (px, floor) => {
  const scale = floor?.scalePixelsPerMeter;
  if (!scale || scale <= 0) return null;
  return Math.round((px / scale) * 10) / 10;
};

/**
 * Turn a node-id path into the stepper response the frontend renders:
 * per-floor walking segments, cross-floor transitions, and a flat step feed.
 * Segments carry their floor's map metadata so the SPA needs no second fetch.
 *
 * @param {{nodes: Map, adj: Map, floors: Map}} graph
 *   floors: Map<floorId, {id, floorNumber, name, mapImageUrl, width, height,
 *                         scalePixelsPerMeter}>
 * @param {string[]} pathIds node ids in walking order
 * @param {object} opts
 *   - mode: 'WAYFINDING' | 'EVACUATION'
 *   - destinationPoi: {id, name, category} | null
 *   - accessible / accessibleRouteUnavailable: flags from the router
 */
export function assembleRoute(graph, pathIds, opts = {}) {
  const {
    mode = 'WAYFINDING',
    destinationPoi = null,
    accessible = false,
    accessibleRouteUnavailable = false,
  } = opts;

  const { nodes, floors, adj } = graph;
  const pathNodes = pathIds.map((id) => nodes.get(id)).filter(Boolean);
  if (pathNodes.length === 0) return null;

  // Split at floor boundaries into walking segments.
  const segments = [];
  let currentNodes = [pathNodes[0]];
  for (let i = 1; i < pathNodes.length; i++) {
    if (pathNodes[i].floorId === pathNodes[i - 1].floorId) {
      currentNodes.push(pathNodes[i]);
    } else {
      segments.push(currentNodes);
      currentNodes = [pathNodes[i]];
    }
  }
  segments.push(currentNodes);

  const findEdge = (fromId, toId) =>
    (adj?.get(fromId) || []).find((e) => e.to === toId) || null;

  const builtSegments = segments.map((segmentNodes, index) => {
    const floor = floors?.get(segmentNodes[0].floorId) || null;
    let distancePx = 0;
    for (let i = 1; i < segmentNodes.length; i++) {
      distancePx += calculateDistance(
        segmentNodes[i - 1].x,
        segmentNodes[i - 1].y,
        segmentNodes[i].x,
        segmentNodes[i].y
      );
    }
    distancePx = Math.round(distancePx);
    return {
      index,
      floor: floorSummary(floor),
      nodes: segmentNodes.map(toStepNode),
      distancePx,
      distanceMeters: pxToMeters(distancePx, floor),
    };
  });

  const transitions = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const fromNode = segments[i][segments[i].length - 1];
    const toNode = segments[i + 1][0];
    const edge = findEdge(fromNode.id, toNode.id);
    const fromFloorNumber = fromNode.floorNumber;
    const toFloorNumber = toNode.floorNumber;
    transitions.push({
      afterSegmentIndex: i,
      transitType: edge?.transitType || 'STAIRS',
      fromFloorNumber,
      toFloorNumber,
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      direction:
        toFloorNumber > fromFloorNumber
          ? 'up'
          : toFloorNumber < fromFloorNumber
            ? 'down'
            : 'same',
      label: toNode.label || fromNode.label || null,
    });
  }

  // Flat feed for the stepper UI: walk → transit → walk → ... → arrive.
  const steps = [];
  builtSegments.forEach((segment, i) => {
    steps.push({ kind: 'walk', segmentIndex: segment.index });
    if (i < transitions.length) {
      steps.push({ kind: 'transit', transitionIndex: i });
    }
  });
  steps.push({ kind: 'arrive' });

  const origin = pathNodes[0];
  const destination = pathNodes[pathNodes.length - 1];
  const totalPx = builtSegments.reduce((sum, s) => sum + s.distancePx, 0);
  const metersKnown = builtSegments.every((s) => s.distanceMeters !== null);

  return {
    mode,
    origin: {
      nodeId: origin.id,
      label: origin.label || null,
      floorNumber: origin.floorNumber,
    },
    destination: {
      nodeId: destination.id,
      label: destination.label || null,
      floorNumber: destination.floorNumber,
      poi: destinationPoi,
    },
    accessible,
    accessibleRouteUnavailable,
    totalDistancePx: totalPx,
    totalDistanceMeters: metersKnown
      ? Math.round(builtSegments.reduce((sum, s) => sum + s.distanceMeters, 0) * 10) / 10
      : null,
    segments: builtSegments,
    transitions,
    steps,
  };
}
