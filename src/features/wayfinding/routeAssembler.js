import { calculateDistance } from './dijkstra.js';
import {
  ASSUMED_PIXELS_PER_METER,
  resolveProfile,
  normalizeProfile,
  edgeDurationSec,
} from './costModel.js';

const toStepNode = (node) => ({
  id: node.id,
  x: node.x,
  y: node.y,
  type: node.type,
  label: node.label || null,
});

/**
 * @param {object|null} floor
 * @param {boolean} lean drop the hand-drawn plan (alternatives and the AI
 *   payload embed whole routes; the drawing is the one unbounded field).
 *   `svgContent` is never included here, lean or not — it is the editor's
 *   source document, not something the visitor map renders.
 */
const floorSummary = (floor, lean = false) =>
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
        ...(lean ? {} : { drawing: floor.drawing || null }),
        width: floor.width || null,
        height: floor.height || null,
        scalePixelsPerMeter: floor.scalePixelsPerMeter || null,
      }
    : null;

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Metres, or null when the floor was never calibrated. This is the *legacy*
 * conversion: `distanceMeters` / `totalDistanceMeters` promise "null means we
 * do not know", and clients already branch on that.
 */
const pxToMeters = (px, floor) => {
  const scale = floor?.scalePixelsPerMeter;
  if (!scale || scale <= 0) return null;
  return round1(px / scale);
};

/** Pixels per metre for a floor, falling back to the documented assumption. */
const scaleOf = (floor) => {
  const scale = floor?.scalePixelsPerMeter;
  return scale > 0 ? scale : ASSUMED_PIXELS_PER_METER;
};

/**
 * Metres that are always a number: an uncalibrated floor gets the assumed
 * scale rather than a hole, and the route says so via `scaleAssumed` plus a
 * `SCALE_ASSUMED` warning. ETAs and "in 20 m, turn left" need a number.
 */
const metersFromPx = (px, floor) => round1(px / scaleOf(floor));

/**
 * The ETA the visitor is shown must be preference-neutral.
 *
 * A named profile carries two kinds of number: physics (walk speed, stair run
 * length, lift wait) and *reluctance* — `floorChangePenaltySec` (600 s under
 * `min_floor_changes`), `transitMultiplier` (×3 stairs / ×2 escalator under
 * `elevator_first`) and `blockedTransit`. Reluctance exists to steer Dijkstra
 * away from a route; it is not time that passes. Leaving it in would tell a
 * visitor the escalator takes ten minutes, and would make two routes with the
 * same walk report different ETAs purely because of how they were searched.
 *
 * So: strip the three search knobs, keep everything else — including the
 * building's own `routingProfile` overrides, which are real measurements.
 * The routing cost function is untouched and keeps every penalty.
 */
const etaProfileOf = (profile) => ({
  ...profile,
  floorChangePenaltySec: 0,
  transitMultiplier: {},
  // A blocked type would price at Infinity and be floored to a 0 s lie below.
  // A blocked edge cannot be on the path anyway; if one is, time it honestly.
  blockedTransit: [],
});

/** Seconds for one edge, never NaN/Infinity. */
const durationOf = (edge, from, to, profile) => {
  const seconds = edgeDurationSec(edge, from, to, profile);
  return Number.isFinite(seconds) ? seconds : 0;
};

/**
 * The adjacency entries a node path actually traverses.
 *
 * `graph.adj` is keyed by node, so the edge joining two consecutive path nodes
 * has to be looked up by its `to`. Parallel edges (two rows joining the same
 * pair) are rare but legal; when several match, prefer the one whose `edgeId`
 * is unique among the candidates, so a duplicated row cannot shadow the real
 * edge. Unknown node ids are skipped exactly as `assembleRoute` skips them, so
 * the returned array stays aligned with the resolved path.
 *
 * @param {{nodes: Map, adj: Map}} graph
 * @param {string[]} pathIds node ids in walking order
 * @returns {Array<{edge: object|null, from: object, to: object}>} one entry per
 *   traversed pair (`pathIds.length - 1` when every id resolves)
 */
export function pathEdges(graph, pathIds = []) {
  const nodes = graph?.nodes;
  if (!nodes) return [];

  const walked = (pathIds || []).map((id) => nodes.get(id)).filter(Boolean);
  const out = [];

  for (let i = 1; i < walked.length; i++) {
    const from = walked[i - 1];
    const to = walked[i];
    const candidates = (graph.adj?.get(from.id) || []).filter((e) => e.to === to.id);

    let edge = candidates[0] || null;
    if (candidates.length > 1) {
      const seen = new Map();
      for (const c of candidates) seen.set(c.edgeId, (seen.get(c.edgeId) ?? 0) + 1);
      edge = candidates.find((c) => seen.get(c.edgeId) === 1) ?? candidates[0];
    }

    out.push({ edge, from, to });
  }

  return out;
}

/**
 * Turn a node-id path into the stepper response the frontend renders:
 * per-floor walking segments, cross-floor transitions, and a flat step feed.
 * Segments carry their floor's map metadata so the SPA needs no second fetch.
 *
 * Every field the v1 response carried keeps its exact meaning — `distancePx`,
 * `distanceMeters` (null when a floor has no scale), `totalDistanceMeters`,
 * `segments[].nodes`, the step feed's `kind`/`segmentIndex`/`transitionIndex`.
 * v2 only adds: ETAs (`durationSec`), always-numeric metres (`distanceM`),
 * cumulative "how far in am I" fields on each step, per-step accessibility,
 * and a `warnings[]` feed the UI can surface verbatim.
 *
 * @param {{nodes: Map, adj: Map, floors: Map, routingProfile?: object|null}} graph
 *   floors: Map<floorId, {id, floorNumber, name, mapImageUrl, width, height,
 *                         scalePixelsPerMeter}>
 * @param {string[]} pathIds node ids in walking order
 * @param {object} opts
 *   - mode: 'WAYFINDING' | 'EVACUATION'
 *   - destinationPoi: {id, name, category} | null
 *   - accessible / accessibleRouteUnavailable: flags from the router
 *   - profile: the resolved profile the search used (`buildRoutingContext().profile`).
 *     Legacy callers pass nothing and get a plain `walk` profile, because an
 *     ETA the UI can show is better than no ETA at all.
 *   - profileName: the profile's name, echoed back as `route.profile`
 *   - tagConstraintsRelaxed: the router dropped include/exclude tags to find this
 *   - overlay: B7's closure overlay `{edgeMultiplier, blockedEdgeIds, blockedNodeIds}`
 *   - lean: omit `floor.drawing` (embedded routes: alternatives, AI payloads)
 */
export function assembleRoute(graph, pathIds, opts = {}) {
  const {
    mode = 'WAYFINDING',
    destinationPoi = null,
    accessible = false,
    accessibleRouteUnavailable = false,
    profile = null,
    profileName = null,
    tagConstraintsRelaxed = false,
    overlay = null,
    lean = false,
  } = opts;

  const { nodes, floors } = graph;
  const pathNodes = pathIds.map((id) => nodes.get(id)).filter(Boolean);
  if (pathNodes.length === 0) return null;

  // A route without a profile still owes the visitor an ETA, so fall back to
  // the building's own tuning under a plain `walk`.
  const activeProfile =
    normalizeProfile(profile) ?? resolveProfile(graph.routingProfile ?? null, 'walk');
  const activeProfileName = profileName ?? activeProfile.name ?? 'walk';
  // Every user-facing duration below is priced with this, never with
  // `activeProfile` — see `etaProfileOf`.
  const etaProfile = etaProfileOf(activeProfile);

  // Split at floor boundaries into walking segments, remembering which segment
  // each path node landed in so the traversed edges can be bucketed the same way.
  const segments = [];
  const segmentIndexAt = new Array(pathNodes.length);
  let currentNodes = [pathNodes[0]];
  segmentIndexAt[0] = 0;
  for (let i = 1; i < pathNodes.length; i++) {
    if (pathNodes[i].floorId === pathNodes[i - 1].floorId) {
      currentNodes.push(pathNodes[i]);
    } else {
      segments.push(currentNodes);
      currentNodes = [pathNodes[i]];
    }
    segmentIndexAt[i] = segments.length;
  }
  segments.push(currentNodes);

  // Bucket the traversed edges: same-floor edges belong to their segment,
  // floor-crossing ones are the transition that follows it.
  const walkedEdges = pathEdges(graph, pathIds);
  const segmentEdges = segments.map(() => []);
  const transitionEdges = new Array(Math.max(0, segments.length - 1)).fill(null);
  for (let i = 0; i < walkedEdges.length; i++) {
    const from = segmentIndexAt[i];
    const to = segmentIndexAt[i + 1];
    if (from === to) segmentEdges[from].push(walkedEdges[i]);
    else transitionEdges[from] = walkedEdges[i];
  }

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

    const walked = segmentEdges[index];
    const durationSec = walked.reduce(
      (sum, { edge, from, to }) => sum + durationOf(edge, from, to, etaProfile),
      0
    );

    return {
      index,
      floor: floorSummary(floor, lean),
      nodes: segmentNodes.map(toStepNode),
      distancePx,
      distanceMeters: pxToMeters(distancePx, floor),
      distanceM: metersFromPx(distancePx, floor),
      // Whole seconds: the UI rounds to minutes anyway, and integer segment
      // durations make the cumulative fields sum to the totals exactly.
      durationSec: Math.round(durationSec),
      accessible: walked.every(({ edge }) => !edge || edge.accessible !== false),
      // The edges actually walked say whether metres were guessed — a floor
      // may carry a scale while a hand-measured edge on it does not, and vice
      // versa.
      scaleAssumed: walked.some(({ edge }) => edge?.lengthMAssumed === true),
    };
  });

  const levelOf = (node) => (Number.isFinite(node?.level) ? node.level : null);

  const transitions = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const fromNode = segments[i][segments[i].length - 1];
    const toNode = segments[i + 1][0];
    const edge = transitionEdges[i]?.edge ?? null;
    const fromFloorNumber = fromNode.floorNumber;
    const toFloorNumber = toNode.floorNumber;
    const fromLevel = levelOf(fromNode);
    const toLevel = levelOf(toNode);

    // `level` (Floor.verticalOrder) is the truth about which way is up:
    // floorNumber can be non-contiguous or negative (basements, mezzanines).
    // Fall back to floorNumber when a floor has no vertical order yet.
    const [up, down] =
      fromLevel !== null && toLevel !== null
        ? [toLevel > fromLevel, toLevel < fromLevel]
        : [toFloorNumber > fromFloorNumber, toFloorNumber < fromFloorNumber];

    transitions.push({
      afterSegmentIndex: i,
      transitType: edge?.transitType || 'STAIRS',
      fromFloorNumber,
      toFloorNumber,
      fromNodeId: fromNode.id,
      toNodeId: toNode.id,
      direction: up ? 'up' : down ? 'down' : 'same',
      label: toNode.label || fromNode.label || null,
      edgeId: edge?.edgeId ?? null,
      durationSec: Math.round(durationOf(edge, fromNode, toNode, etaProfile)),
      accessible: edge ? edge.accessible !== false : true,
      level: { from: fromLevel, to: toLevel },
    });
  }

  // Flat feed for the stepper UI: walk → transit → walk → ... → arrive.
  // `distanceUntilM`/`timeUntilSec` are the running totals *before* the step,
  // so the first is always 0 and `arrive` carries the route totals.
  const steps = [];
  let metresSoFar = 0;
  let secondsSoFar = 0;
  const pushStep = (step) => {
    steps.push({ ...step, distanceUntilM: round1(metresSoFar), timeUntilSec: secondsSoFar });
    metresSoFar = round1(metresSoFar + step.distanceM);
    secondsSoFar += step.durationSec;
  };

  builtSegments.forEach((segment, i) => {
    pushStep({
      kind: 'walk',
      segmentIndex: segment.index,
      distanceM: segment.distanceM,
      durationSec: segment.durationSec,
      accessible: segment.accessible,
    });
    if (i < transitions.length) {
      pushStep({
        kind: 'transit',
        transitionIndex: i,
        // A floor change costs time, not floor distance; counting the stair
        // run as metres walked would double-bill the corridor lengths.
        distanceM: 0,
        durationSec: transitions[i].durationSec,
        accessible: transitions[i].accessible,
      });
    }
  });
  pushStep({ kind: 'arrive', distanceM: 0, durationSec: 0, accessible: true });

  const warnings = [];

  const assumedFloorIds = [];
  for (const segment of builtSegments) {
    const floorId = segment.floor?.id;
    if (segment.scaleAssumed && floorId && !assumedFloorIds.includes(floorId)) {
      assumedFloorIds.push(floorId);
    }
  }
  const scaleAssumed = assumedFloorIds.length > 0;
  if (scaleAssumed) {
    warnings.push({
      code: 'SCALE_ASSUMED',
      message: `Distances and times on ${
        assumedFloorIds.length === 1 ? 'one floor are' : `${assumedFloorIds.length} floors are`
      } estimated: no map scale is set, so ${ASSUMED_PIXELS_PER_METER} pixels per metre is assumed.`,
      floorIds: assumedFloorIds,
    });
  }

  // The router could not honour the step-free request and fell back to a route
  // with steps in it. Say exactly where, and how far in, so the visitor can
  // decide before setting off.
  //
  // `accessible` is checked alongside the profile name because today's callers
  // (QR scan, the AI wayfinding tools, the evacuation brief) pass the two flags
  // and no profile at all — gating on the name alone would silently drop the
  // warning for every one of them.
  if ((activeProfileName === 'wheelchair' || accessible) && accessibleRouteUnavailable) {
    steps.forEach((step, stepIndex) => {
      if (step.accessible !== false) return;
      if (step.kind === 'transit') {
        const transition = transitions[step.transitionIndex];
        warnings.push({
          code: 'INACCESSIBLE_STEP',
          message: `This route uses ${transition.transitType.toLowerCase()} between floor ${transition.fromFloorNumber} and floor ${transition.toFloorNumber}, which is not step-free.`,
          segmentIndex: transition.afterSegmentIndex,
          transitionIndex: step.transitionIndex,
          stepIndex,
          distanceFromStartM: step.distanceUntilM,
        });
        return;
      }
      const segment = builtSegments[step.segmentIndex];
      warnings.push({
        code: 'INACCESSIBLE_STEP',
        message: `Part of the walk on floor ${segment.floor?.floorNumber ?? '?'} is not step-free.`,
        segmentIndex: step.segmentIndex,
        stepIndex,
        distanceFromStartM: step.distanceUntilM,
      });
    });
  }

  // Closures (B7 completes this): a blocked edge can never be on the path, so
  // the only thing left to report is a route that was routed *through* a
  // slowed-down closure because nothing better existed.
  const edgeMultiplier = overlay?.edgeMultiplier;
  if (edgeMultiplier?.size) {
    let metresAtEdge = 0;
    for (let i = 0; i < walkedEdges.length; i++) {
      const { edge, from, to } = walkedEdges[i];
      const crossFloor = from.floorId !== to.floorId;
      if (edge?.edgeId && edgeMultiplier.has(edge.edgeId)) {
        const segmentIndex = segmentIndexAt[i];
        warnings.push({
          code: 'CLOSURE_ON_ROUTE',
          message: 'This route passes through an area with a temporary restriction.',
          segmentIndex,
          ...(crossFloor ? { transitionIndex: segmentIndex } : {}),
          distanceFromStartM: round1(metresAtEdge),
        });
      }
      if (!crossFloor) {
        const floor = floors?.get(from.floorId) || null;
        metresAtEdge += calculateDistance(from.x, from.y, to.x, to.y) / scaleOf(floor);
      }
    }
  }

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
      ? round1(builtSegments.reduce((sum, s) => sum + s.distanceMeters, 0))
      : null,
    segments: builtSegments,
    transitions,
    steps,
    profile: activeProfileName,
    totalDistanceM: round1(builtSegments.reduce((sum, s) => sum + s.distanceM, 0)),
    totalDurationSec:
      builtSegments.reduce((sum, s) => sum + s.durationSec, 0) +
      transitions.reduce((sum, t) => sum + t.durationSec, 0),
    scaleAssumed,
    tagConstraintsRelaxed,
    warnings,
  };
}
