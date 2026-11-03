/**
 * Turn-by-turn instruction generation — pure geometry, no I/O.
 * ----------------------------------------------------------------------------
 * The route assembler knows *where* the visitor walks; this module decides
 * what to say about it. It reads the smoothed polyline B8 already produced
 * (`segments[].points`), simplifies it once more so a corridor drawn with a
 * dozen collinear shortcut nodes does not become a dozen "continue straight"
 * cards, classifies what is left into Valhalla's turn bands, and attaches the
 * nearest useful POI as a landmark.
 *
 * Nothing here touches Prisma or the request: every input is passed in, so the
 * whole builder is unit-testable against an in-memory graph fixture.
 */

import { lineOfSight } from './smoothing.js';
import { wallSegments } from '../mapEditor/autoConnect.js';
import { ASSUMED_PIXELS_PER_METER } from './costModel.js';
import { LOCALES, formatDistance, render } from './instructionText.js';

/**
 * Valhalla's turn bands, keyed on the CLOCKWISE turn from the incoming
 * bearing to the outgoing one — so a small delta is a right turn and a large
 * one is a left turn, exactly as `Turn::GetType` defines them.
 *
 * Both ends are inclusive and the degrees are integers: `classifyTurn` rounds
 * before banding, because a band edge quoted as "44/45" has no meaning for a
 * delta of 44.5. Anything the table does not cover (0-10 and 350-359, the two
 * halves of the straight-ahead band, which wrap through 0) is `straight`.
 */
export const TURN_TABLE = Object.freeze([
  Object.freeze({ kind: 'slight_right', from: 11, to: 44 }),
  Object.freeze({ kind: 'right', from: 45, to: 135 }),
  Object.freeze({ kind: 'sharp_right', from: 136, to: 159 }),
  Object.freeze({ kind: 'uturn', from: 160, to: 200 }),
  Object.freeze({ kind: 'sharp_left', from: 201, to: 224 }),
  Object.freeze({ kind: 'left', from: 225, to: 315 }),
  Object.freeze({ kind: 'slight_left', from: 316, to: 349 }),
]);

/** Degrees into [0, 360). */
const norm360 = (deg) => ((deg % 360) + 360) % 360;

/**
 * The turn kind for a clockwise delta in degrees.
 *
 * @param {number} deltaDeg clockwise turn, any magnitude or sign
 * @returns {'straight'|'slight_right'|'right'|'sharp_right'|'uturn'|'sharp_left'|'left'|'slight_left'}
 */
export function classifyTurn(deltaDeg) {
  if (!Number.isFinite(deltaDeg)) return 'straight';
  const deg = norm360(Math.round(deltaDeg)) % 360;
  const band = TURN_TABLE.find((b) => deg >= b.from && deg <= b.to);
  return band ? band.kind : 'straight';
}

/**
 * Map-space bearing from `p` to `q`: 0 is up the map, angles run clockwise.
 *
 * Map y grows downward (canvas coordinates), so "up" is -y and the clockwise
 * convention falls straight out of `atan2(dx, -dy)`. This is a MAP bearing,
 * not a compass bearing — `profile.northOffsetDeg` is what relates the two.
 *
 * @returns {number|null} degrees in [0, 360), or null for a zero-length step
 */
export function bearing(p, q) {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  if (dx === 0 && dy === 0) return null;
  return norm360((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/** Perpendicular distance from `p` to the segment `a`-`b` (px). */
function perpendicularDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  // Twice the triangle area over the base length — no projection clamping
  // needed, because Douglas-Peucker only ever measures points that lie
  // between the two ends of the chord it is testing.
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / Math.hypot(dx, dy);
}

/**
 * Ramer-Douglas-Peucker simplification of a polyline.
 *
 * B8's smoothing already collapses what the *walls* allow; this collapses what
 * the *geometry* allows. A corridor auto-wired with a dozen shortcut nodes can
 * survive smoothing as a dozen near-collinear points, each of which would
 * classify as its own (tiny) turn. Anything that strays less than `epsPx` off
 * the straight line between its neighbours is not a decision a person makes.
 *
 * The original point objects are returned, not copies, so `nodeId` survives.
 *
 * @param {Array<{x:number,y:number,nodeId?:string}>} points
 * @param {number} epsPx tolerance in pixels
 * @returns {Array<{x:number,y:number,nodeId?:string}>} a subsequence, endpoints kept
 */
export function douglasPeucker(points, epsPx) {
  const list = points || [];
  if (list.length <= 2) return list.slice();
  const eps = Number.isFinite(epsPx) && epsPx > 0 ? epsPx : 0;

  const first = list[0];
  const last = list[list.length - 1];

  let worst = 0;
  let worstIndex = 0;
  for (let i = 1; i < list.length - 1; i += 1) {
    const d = perpendicularDistance(list[i], first, last);
    if (d > worst) {
      worst = d;
      worstIndex = i;
    }
  }

  if (worst <= eps) return [first, last];

  const left = douglasPeucker(list.slice(0, worstIndex + 1), eps);
  const right = douglasPeucker(list.slice(worstIndex), eps);
  return [...left.slice(0, -1), ...right];
}

/* ============================================================================
   Landmarks.
   ========================================================================= */

/**
 * How much each kind of POI is worth as a landmark. A door is the best thing
 * to steer by — you either walk through it or you do not — and a generic "info"
 * pillar the worst, because every mall has six of them.
 *
 * Matched on substrings of the POI's free-text category (owners type their
 * own), longest-match-wins, with `shop/poi` as the default for anything that
 * does not look like infrastructure.
 */
export const CATEGORY_WEIGHTS = Object.freeze([
  Object.freeze({ match: ['door', 'entrance', 'exit', 'gate'], weight: 1.0 }),
  Object.freeze({ match: ['elevator', 'lift', 'stair', 'escalator'], weight: 0.9 }),
  Object.freeze({ match: ['wc', 'toilet', 'restroom', 'bathroom'], weight: 0.8 }),
  Object.freeze({ match: ['info', 'sign', 'kiosk'], weight: 0.5 }),
]);

/** Everything that is not infrastructure: a shop, a café, a desk, a stand. */
const DEFAULT_CATEGORY_WEIGHT = 0.7;

/** A landmark on the wrong side of the walker is still a landmark — just a worse one. */
const WRONG_SIDE_FACTOR = 0.4;
/** "The third Kiosk" helps nobody; a name shared with another candidate is discounted. */
const REPEATED_NAME_FACTOR = 0.5;
/** Out of sight, behind a wall: mentioned only when nothing visible is nearby. */
const NO_LINE_OF_SIGHT_FACTOR = 0.3;
/**
 * How far along the approach a POI may sit and still read as "at" the turn,
 * as a fraction of the search radius. The builder overrides it with a real
 * distance (`atBandPx`) because "at" is about paces, not about how wide we
 * cast the net; this default only keeps a bare `pickLandmark` call sensible.
 */
const AT_BAND_FRACTION = 0.2;

/** The weight for a POI category, by longest matching keyword. */
export function categoryWeight(category) {
  const text = String(category ?? '').toLowerCase();
  if (!text) return DEFAULT_CATEGORY_WEIGHT;
  let best = null;
  for (const row of CATEGORY_WEIGHTS) {
    for (const keyword of row.match) {
      if (text.includes(keyword) && (!best || keyword.length > best.length)) {
        best = { length: keyword.length, weight: row.weight };
      }
    }
  }
  return best ? best.weight : DEFAULT_CATEGORY_WEIGHT;
}

/**
 * Which side of a walker heading along `dir` the vector `v` falls on.
 *
 * Map y grows downward, so the z-component of the cross product is positive
 * for things on the walker's right. Dead ahead (or dead behind) has no side.
 */
function sideOf(dir, v) {
  const cross = dir.x * v.y - dir.y * v.x;
  if (cross === 0) return null;
  return cross > 0 ? 'right' : 'left';
}

/**
 * The POI most worth naming at a decision point.
 *
 * score = categoryWeight × unique × sideMatch × (line of sight ? 1 : 0.3)
 *
 * Distance is a FILTER, not a term: past the radius a POI is not a landmark
 * at all, and inside it "the café you are turning towards" beats "the one you
 * will have your back to" however much closer the second one is. Distance only
 * breaks ties between equally-scoring candidates.
 *
 * @param {{x:number,y:number}} turnPoint where the maneuver happens
 * @param {{x:number,y:number}} prevPoint the point walked in FROM (sets the facing)
 * @param {Array<{id:string,name:string,category?:string,x:number,y:number}>} pois
 * @param {Array<[number,number,number,number]>} walls wall centrelines, as
 *   `wallSegments` returns them
 * @param {{radiusPx:number, side?:'left'|'right'|null, atBandPx?:number}} opts
 *   `side` is the side the visitor is about to turn towards, when there is one;
 *   `atBandPx` is how far along the approach still counts as "at" the turn
 * @returns {{poiId:string,name:string,relation:'before'|'after'|'at',side:'left'|'right'}|null}
 */
export function pickLandmark(turnPoint, prevPoint, pois, walls, opts = {}) {
  const { radiusPx = 0, side = null, atBandPx = null } = opts;
  if (!turnPoint || !prevPoint || !Array.isArray(pois) || pois.length === 0) return null;
  if (!(radiusPx > 0)) return null;

  const dx = turnPoint.x - prevPoint.x;
  const dy = turnPoint.y - prevPoint.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const dir = { x: dx / length, y: dy / length };

  const inRange = pois.filter(
    (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)
      && Math.hypot(p.x - turnPoint.x, p.y - turnPoint.y) <= radiusPx
  );
  if (inRange.length === 0) return null;

  const nameCounts = new Map();
  for (const p of inRange) {
    const key = String(p.name ?? '').trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const atBand = atBandPx > 0 ? atBandPx : radiusPx * AT_BAND_FRACTION;

  let best = null;
  for (const p of inRange) {
    const v = { x: p.x - turnPoint.x, y: p.y - turnPoint.y };
    const distance = Math.hypot(v.x, v.y);
    // Along-track: negative is still short of the turn, positive is past it.
    const along = dir.x * v.x + dir.y * v.y;
    const actualSide = sideOf(dir, v) ?? side ?? 'right';

    const unique = nameCounts.get(String(p.name ?? '').trim().toLowerCase()) > 1
      ? REPEATED_NAME_FACTOR
      : 1;
    const sideMatch = !side || actualSide === side ? 1 : WRONG_SIDE_FACTOR;
    const visible = lineOfSight(turnPoint.x, turnPoint.y, p.x, p.y, walls) ? 1 : NO_LINE_OF_SIGHT_FACTOR;
    const score = categoryWeight(p.category) * unique * sideMatch * visible;

    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = {
        score,
        distance,
        landmark: {
          poiId: p.id,
          name: p.name,
          relation: Math.abs(along) <= atBand ? 'at' : along < 0 ? 'before' : 'after',
          side: actualSide,
        },
      };
    }
  }

  return best ? best.landmark : null;
}

/* ============================================================================
   The builder.
   ========================================================================= */

/**
 * Simplification tolerance. 0.4 m is narrower than a person, so nothing a
 * visitor could actually walk around survives as a "turn", while a real
 * corner (which is metres wide) always does.
 */
const SIMPLIFY_EPS_M = 0.4;
/** Two decisions closer than this are one decision said twice. */
const MERGE_WITHIN_M = 3;
/** Below this, a leg is too short to be worth confirming mid-walk. */
const STRAIGHT_MIN_LEG_M = 25;
/** A landmark further than this from the decision point is not "at" it. */
const LANDMARK_RADIUS_M = 10;
/** Along the approach, within this still reads as "at" rather than before/after. */
const AT_BAND_M = 3;

/** Which side a turn kind sends the visitor towards, if any. */
const SIDE_OF_KIND = Object.freeze({
  slight_left: 'left',
  left: 'left',
  sharp_left: 'left',
  slight_right: 'right',
  right: 'right',
  sharp_right: 'right',
});

/** The template family a turn kind is phrased with. */
const KEY_OF_KIND = Object.freeze({
  slight_left: 'slight',
  slight_right: 'slight',
  left: 'turn',
  right: 'turn',
  sharp_left: 'sharp',
  sharp_right: 'sharp',
  uturn: 'uturn',
});

const defaultScaleFor = (floor) => {
  const scale = floor?.scalePixelsPerMeter;
  return scale > 0 ? scale : ASSUMED_PIXELS_PER_METER;
};

const round1 = (n) => Math.round(n * 10) / 10;

/** Drop repeated points — a zero-length step has no bearing to classify. */
function dedupe(points) {
  const out = [];
  for (const p of points || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  return out;
}

/** Cumulative along-path pixels for a polyline: one entry per point. */
function cumulative(points) {
  const out = [0];
  for (let i = 1; i < points.length; i += 1) {
    out.push(out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return out;
}

/** The point `distancePx` along the polyline, and the index it sits after. */
function pointAlong(points, cum, distancePx) {
  const total = cum[cum.length - 1];
  const target = Math.max(0, Math.min(distancePx, total));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i += 1;
  const span = cum[i] - cum[i - 1];
  const t = span > 0 ? (target - cum[i - 1]) / span : 0;
  return {
    x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
    y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
    afterIndex: i - 1,
  };
}

/**
 * POIs indexed by floor, and their nodes indexed by POI id.
 *
 * Built once per graph object and held weakly, because scanning 20 000 nodes
 * per segment per route is exactly the cost `/evacuate` cannot pay: during an
 * incident it assembles a primary route plus two alternatives, for hundreds of
 * occupants, over the same cached graph. The cache dies with the graph, so a
 * refreshed graph rebuilds rather than serving stale POIs.
 */
const poiIndexCache = new WeakMap();

function poiIndex(graph) {
  if (!graph?.nodes) return { byFloor: new Map(), byPoiId: new Map() };
  const cached = poiIndexCache.get(graph);
  if (cached) return cached;

  const byFloor = new Map();
  const byPoiId = new Map();
  for (const node of graph.nodes.values()) {
    if (!node.poi) continue;
    if (!byFloor.has(node.floorId)) byFloor.set(node.floorId, []);
    byFloor.get(node.floorId).push({
      id: node.poi.id,
      name: node.poi.name,
      category: node.poi.category ?? null,
      x: node.x,
      y: node.y,
    });
    if (node.poi.id && !byPoiId.has(node.poi.id)) byPoiId.set(node.poi.id, node);
  }

  const index = { byFloor, byPoiId };
  poiIndexCache.set(graph, index);
  return index;
}

/** Every POI-bearing node on one floor, as landmark candidates. */
function poisOnFloor(graph, floorId) {
  if (!floorId) return [];
  return poiIndex(graph).byFloor.get(floorId) ?? [];
}

/** Is `name` the only candidate with that name within `radiusPx` of `point`? */
function nameIsUnique(pois, point, radiusPx, name) {
  const key = String(name ?? '').trim().toLowerCase();
  let seen = 0;
  for (const p of pois) {
    if (Math.hypot(p.x - point.x, p.y - point.y) > radiusPx) continue;
    if (String(p.name ?? '').trim().toLowerCase() === key) seen += 1;
  }
  return seen === 1;
}

/**
 * The decision points on one simplified polyline, after merging the ones that
 * land on top of each other.
 *
 * Two 45° jinks 2 m apart are one 90° corner that the floor plan happened to
 * draw as two vertices; a visitor told to "bear right" twice in two paces has
 * been told something false. Merging re-classifies the *combined* turn — the
 * incoming bearing of the first and the outgoing bearing of the last — which
 * also means two opposite jinks cancel out to `straight` and disappear.
 */
function decisionsOn(points, cum, mergeWithinPx) {
  const raw = [];
  for (let i = 1; i < points.length - 1; i += 1) {
    const incoming = bearing(points[i - 1], points[i]);
    const outgoing = bearing(points[i], points[i + 1]);
    if (incoming === null || outgoing === null) continue;
    raw.push({ index: i, incoming, outgoing });
  }

  const merged = [];
  let i = 0;
  while (i < raw.length) {
    let last = i;
    while (last + 1 < raw.length && cum[raw[last + 1].index] - cum[raw[i].index] < mergeWithinPx) {
      last += 1;
    }
    const kind = classifyTurn(raw[last].outgoing - raw[i].incoming);
    if (kind !== 'straight') {
      merged.push({ index: raw[i].index, kind, incoming: raw[i].incoming });
    }
    i = last + 1;
  }

  return merged;
}

/**
 * Split `totalM` across legs in proportion to their pixel length, so the
 * instruction distances always sum to EXACTLY the segment distance the rest of
 * the route reports.
 *
 * This matters because the two are measured on different polylines: the
 * segment's metres come from the node path Dijkstra optimised, the legs from
 * B8's smoothed-and-simplified drawing polyline (see the header of
 * `smoothing.js`). Allocating rather than re-measuring keeps "30 m + 40 m" and
 * "70 m in total" from contradicting each other on the same card.
 */
function allocate(cumPx, totalPx, total, roundFn) {
  const out = [];
  let previous = 0;
  for (let i = 1; i < cumPx.length; i += 1) {
    const upto = totalPx > 0 ? roundFn(total * (cumPx[i] / totalPx)) : 0;
    out.push(roundFn(upto - previous));
    previous = upto;
  }
  return out;
}

/**
 * Build the turn-by-turn feed for an assembled route.
 *
 * One instruction per thing the visitor has to DO: leave, turn, change floor,
 * arrive — plus a confirmation part-way down any leg long enough that silence
 * would feel like the app had stopped working.
 *
 * Every walk segment is guaranteed at least one instruction, because the
 * frontend's `buildFeed` maps instructions onto steps and a step no
 * instruction claims never appears in the stepper at all.
 *
 * @param {object} route an `assembleRoute` result
 * @param {{nodes: Map, floors: Map}} graph the graph it was built from — the
 *   source of POIs and of floor drawings (a lean route has no `floor.drawing`)
 * @param {{profile?: object|null, heading?: number|null,
 *          scaleFor?: (floor: object|null) => number}} opts
 *   `heading` is a COMPASS bearing in degrees; `profile.northOffsetDeg` turns
 *   it into a map bearing.
 * @returns {Array<object>} the `instructions[]` wire objects
 */
export function buildInstructions(route, graph, opts = {}) {
  const { profile = null, heading = null, scaleFor = defaultScaleFor } = opts;
  const segments = route?.segments;
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const transitions = route?.transitions ?? [];
  const destinationPoiId = route?.destination?.poi?.id ?? null;
  const northOffsetDeg = Number.isFinite(profile?.northOffsetDeg) ? profile.northOffsetDeg : 0;
  const facingMapBearing = Number.isFinite(heading) ? norm360(heading - northOffsetDeg) : null;

  const out = [];
  const push = (instruction) => out.push({ index: out.length, ...instruction });

  segments.forEach((segment, segmentIndex) => {
    const floorId = segment.floor?.id ?? null;
    // Prefer the graph's floor: a lean route drops `drawing`, and without walls
    // every landmark would score as visible.
    const floor = graph?.floors?.get?.(floorId) ?? segment.floor ?? null;
    const scale = scaleFor(floor);
    const walls = wallSegments(floor?.drawing ?? null);
    const pois = poisOnFloor(graph, floorId);
    const radiusPx = LANDMARK_RADIUS_M * scale;
    const atBandPx = AT_BAND_M * scale;

    // The destination is what the visitor is walking TO, so it is never what
    // they steer BY: "turn right at Shop B" immediately followed by "you have
    // arrived at Shop B" anchors the maneuver on its own goal. The `arrive`
    // instruction still names it — that is the one place it belongs.
    const landmarkPois = destinationPoiId
      ? pois.filter((p) => p.id !== destinationPoiId)
      : pois;

    const source = segment.points?.length
      ? segment.points
      : (segment.nodes ?? []).map((n) => ({ x: n.x, y: n.y, nodeId: n.id }));
    const points = douglasPeucker(dedupe(source), SIMPLIFY_EPS_M * scale);

    const isLastSegment = segmentIndex === segments.length - 1;
    const transition = transitions.find((t) => t.afterSegmentIndex === segmentIndex) ?? null;

    if (points.length < 2) {
      // A degenerate segment (one point, or a floor change immediately after
      // stepping off another one) still owes the stepper an instruction.
      if (!isLastSegment && transition) pushTransit(push, transition, points[0] ?? null);
      else if (isLastSegment) pushArrive(push, route, graph, segmentIndex, points, scale);
      else pushWalkOpener(push, segmentIndex, points[0] ?? null, 0, 0, null, facingMapBearing);
      return;
    }

    const cum = cumulative(points);
    const totalPx = cum[cum.length - 1];
    const decisions = decisionsOn(points, cum, MERGE_WITHIN_M * scale);

    // Stops: where the visitor is told something. Start, each decision, and a
    // mid-leg confirmation wherever a long straight run has something unique
    // to steer by. The segment's end is handled separately (transit/arrive).
    const stops = [{ atPx: 0, point: points[0], nodeId: points[0].nodeId ?? null, kind: null }];
    for (const decision of decisions) {
      const point = points[decision.index];
      stops.push({
        atPx: cum[decision.index],
        point,
        nodeId: point.nodeId ?? null,
        kind: decision.kind,
        incoming: decision.incoming,
      });
    }
    const endPx = totalPx;

    const withConfirmations = [];
    for (let i = 0; i < stops.length; i += 1) {
      withConfirmations.push(stops[i]);
      const nextPx = i + 1 < stops.length ? stops[i + 1].atPx : endPx;
      const legPx = nextPx - stops[i].atPx;
      if (legPx / scale <= STRAIGHT_MIN_LEG_M) continue;

      const midPx = stops[i].atPx + legPx / 2;
      const mid = pointAlong(points, cum, midPx);
      const landmark = pickLandmark(mid, stops[i].point, landmarkPois, walls, {
        radiusPx,
        side: null,
        atBandPx,
      });
      if (!landmark || !nameIsUnique(landmarkPois, mid, radiusPx, landmark.name)) continue;
      withConfirmations.push({ atPx: midPx, point: mid, nodeId: null, kind: 'straight', landmark });
    }

    const stopPx = [...withConfirmations.map((s) => s.atPx), endPx];
    const legM = allocate(stopPx, totalPx, segment.distanceM ?? 0, round1);
    const legSec = allocate(stopPx, totalPx, segment.durationSec ?? 0, Math.round);

    withConfirmations.forEach((stop, i) => {
      const distanceM = legM[i] ?? 0;
      const durationSec = legSec[i] ?? 0;

      if (stop.kind === null) {
        pushWalkOpener(
          push,
          segmentIndex,
          stop,
          distanceM,
          durationSec,
          segmentIndex === 0 ? bearing(points[0], points[1]) : null,
          segmentIndex === 0 ? facingMapBearing : null
        );
        return;
      }

      if (stop.kind === 'straight') {
        push({
          kind: 'straight',
          distanceM,
          durationSec,
          segmentIndex,
          at: { x: round1(stop.point.x), y: round1(stop.point.y) },
          ...(stop.landmark ? { landmark: stop.landmark } : {}),
          text: textFor('straight', { distanceM, landmark: stop.landmark }),
        });
        return;
      }

      const side = SIDE_OF_KIND[stop.kind] ?? null;
      const previous = withConfirmations[i - 1]?.point ?? points[0];
      const landmark = pickLandmark(stop.point, previous, landmarkPois, walls, {
        radiusPx,
        side,
        atBandPx,
      });

      push({
        kind: stop.kind,
        distanceM,
        durationSec,
        segmentIndex,
        ...(stop.nodeId ? { atNodeId: stop.nodeId } : {}),
        at: { x: round1(stop.point.x), y: round1(stop.point.y) },
        ...(landmark ? { landmark } : {}),
        text: textFor(KEY_OF_KIND[stop.kind], { side, landmark }),
      });
    });

    if (!isLastSegment && transition) {
      pushTransit(push, transition, points[points.length - 1]);
    } else if (isLastSegment) {
      pushArrive(push, route, graph, segmentIndex, points, scale);
    }
  });

  return out;
}

/**
 * The first thing said on a segment.
 *
 * Segment 0 is the departure, phrased against the compass when the device gave
 * us one. Every later segment opens with a `straight` — the visitor has just
 * stepped off a lift or a staircase and there is no incoming bearing to turn
 * relative to, so "continue straight for 20 m" is the only honest thing to
 * say. (This is the one `straight` that is not a long-leg confirmation: the
 * stepper's feed would skip the whole segment without it.)
 *
 * KIND FOLLOWS THE PHRASING. The frontend rotates the stepper's arrow from
 * `kind` alone (`INSTRUCTION_ROTATION`), and `depart` points straight up — so
 * a `depart` whose text reads "Turn right, then go 8 m" shows an UP arrow over
 * the word "right". When the compass says the visitor must turn before taking
 * a step, the instruction IS that turn; `depart` is kept only for a plain "go
 * ahead". Safe for `useRouteProgress.buildFeed`, which maps every non-transit,
 * non-arrive instruction by `segmentIndex` regardless of kind.
 */
function pushWalkOpener(push, segmentIndex, stop, distanceM, durationSec, legBearing, facing) {
  const point = stop?.point ?? stop ?? null;
  const nodeId = stop?.nodeId ?? point?.nodeId ?? null;
  const base = {
    distanceM,
    durationSec,
    segmentIndex,
    ...(nodeId ? { atNodeId: nodeId } : {}),
    ...(point ? { at: { x: round1(point.x), y: round1(point.y) } } : {}),
  };

  if (segmentIndex !== 0) {
    push({ ...base, kind: 'straight', text: textFor('straight', { distanceM }) });
    return;
  }

  // Which way does the visitor have to turn before taking the first step?
  const turn =
    facing !== null && legBearing !== null ? classifyTurn(legBearing - facing) : 'straight';
  const side = SIDE_OF_KIND[turn] ?? null;
  const key = turn === 'straight' ? 'depart' : turn === 'uturn' ? 'uturn' : 'depart_heading';

  push({
    ...base,
    kind: turn === 'straight' ? 'depart' : turn,
    text: textFor(key, { distanceM, side }),
  });
}

/** Which sentence a floor change gets. `direction` is a closed set of three. */
const TRANSIT_KEY_OF_DIRECTION = Object.freeze({
  up: 'transit_up',
  down: 'transit_down',
  same: 'transit_same',
});

function pushTransit(push, transition, point) {
  // Mapping "not down" to "up" made a same-level crossing say "up to floor 2".
  // An unrecognised direction falls back to `transit_same`, which is the only
  // one of the three that is never wrong about which way the visitor moves.
  const key = TRANSIT_KEY_OF_DIRECTION[transition.direction] ?? 'transit_same';
  push({
    kind: 'transit',
    distanceM: 0,
    durationSec: transition.durationSec ?? 0,
    // `useRouteProgress.buildFeed` falls back to matching this against
    // `transitions[].afterSegmentIndex` — it is the segment being LEFT.
    segmentIndex: transition.afterSegmentIndex,
    ...(transition.fromNodeId ? { atNodeId: transition.fromNodeId } : {}),
    ...(point ? { at: { x: round1(point.x), y: round1(point.y) } } : {}),
    floorChange: {
      fromFloorNumber: transition.fromFloorNumber,
      toFloorNumber: transition.toFloorNumber,
      transitType: transition.transitType,
      direction: transition.direction,
    },
    text: textFor(key, {
      transitType: transition.transitType,
      floor: transition.toFloorNumber,
    }),
  });
}

/**
 * "You have arrived" — and, when the destination POI is off to one side of the
 * final approach rather than sitting on it, which side that is. The side is a
 * cross product against the last leg walked; a destination dead ahead has no
 * side and gets the plain sentence rather than an invented one.
 */
function pushArrive(push, route, graph, segmentIndex, points, scale) {
  const point = points[points.length - 1] ?? null;
  const poiId = route?.destination?.poi?.id ?? null;
  const name = route?.destination?.poi?.name ?? null;

  let landmark = null;
  if (poiId && name && point && points.length >= 2) {
    const node = findPoiNode(graph, poiId);
    if (node) {
      const previous = points[points.length - 2];
      const dir = { x: point.x - previous.x, y: point.y - previous.y };
      const v = { x: node.x - point.x, y: node.y - point.y };
      const side = sideOf(dir, v);
      // Only worth saying while the POI is close enough to point at.
      if (side && Math.hypot(v.x, v.y) <= LANDMARK_RADIUS_M * scale) {
        landmark = { poiId, name, relation: 'at', side };
      }
    }
  }

  push({
    kind: 'arrive',
    distanceM: 0,
    durationSec: 0,
    segmentIndex,
    ...(point?.nodeId ? { atNodeId: point.nodeId } : {}),
    ...(point ? { at: { x: round1(point.x), y: round1(point.y) } } : {}),
    ...(landmark ? { landmark } : {}),
    text: textFor(landmark ? 'arrive_side' : 'arrive', { landmark }),
  });
}

function findPoiNode(graph, poiId) {
  return poiIndex(graph).byPoiId.get(poiId) ?? null;
}

/**
 * Render one instruction into every locale.
 *
 * The landmark clause is appended rather than baked into each maneuver
 * template, so "Turn right" and "Turn right at the Coffee Bar" are one
 * template plus one optional phrase in both languages instead of four.
 */
function textFor(key, { distanceM = null, side = null, landmark = null, transitType = null, floor = null } = {}) {
  const text = {};
  for (const locale of LOCALES) {
    const vars = {
      distance: distanceM === null ? null : formatDistance(distanceM),
      side: side ? render(locale, `side_${side}`) : null,
      name: landmark?.name ?? null,
      floor,
      // An unknown transit type must never be INVENTED as stairs: that is the
      // one wrong answer on a step-free route, and the response advertises
      // step-free in the same payload. The neutral level crossing is the safe
      // fallback — it under-describes rather than contradicting.
      transit: transitType
        ? (render(locale, `transit_${transitType}`) ?? render(locale, 'transit_WALKWAY'))
        : null,
    };
    // `arrive_side` names the destination inline; every other sentence takes
    // the landmark as a trailing clause.
    if (key === 'arrive_side') {
      vars.side = landmark?.side ? render(locale, `side_${landmark.side}`) : null;
    }

    let sentence = render(locale, key, vars) ?? '';
    if (landmark && key !== 'arrive_side') {
      const clause = render(locale, `rel_${landmark.relation}`, { name: landmark.name });
      if (clause) sentence = `${sentence} ${clause}`.trim();
    }
    text[locale] = sentence;
  }
  return text;
}

export { lineOfSight, wallSegments };
