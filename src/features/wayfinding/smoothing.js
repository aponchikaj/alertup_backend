/**
 * Any-angle path smoothing — turn Dijkstra's node-by-node zig-zag into a
 * straight-line-where-possible polyline for drawing.
 * ----------------------------------------------------------------------------
 * `shortestPath` walks graph nodes, so a corridor auto-connected with a dozen
 * shortcut nodes routes fine but *draws* as a jagged staircase even when the
 * floor is one open room. This module post-processes the walked node list
 * into a shorter polyline of points that a person could actually walk in a
 * straight line, using the floor's drawn walls as the only obstacle test —
 * greedy "farthest visible from here" (a standard any-angle/string-pulling
 * technique), the same proper-intersection test `autoConnect.js` already uses
 * to keep auto-wired edges out of walls.
 *
 * IMPORTANT — distances are NOT recomputed from the smoothed polyline.
 * `routeAssembler.js`'s `distancePx`/`distanceMeters`/`distanceM` (and every
 * duration derived from them) are computed from the NODE polyline, which is
 * what Dijkstra actually optimised and what the frontend's existing
 * assertions pin. `points` here is a *drawing* concern — and, later, the
 * source geometry for turn-by-turn instructions — deliberately allowed to
 * diverge from the metric the route was costed on. A smoothed polyline is
 * usually a little shorter than the walked node path; re-deriving distance
 * from it would make the "shortest path" the router found look longer or
 * shorter than the number it was chosen by, which is worse than the two
 * being frankly different measurements of two different things.
 */

import { segmentsIntersect, wallSegments } from '../mapEditor/autoConnect.js';

/** Node types that must survive smoothing regardless of visibility. */
const PROTECTED_TYPES = new Set(['TRANSIT', 'EMERGENCY_EXIT', 'POI', 'ENTRANCE']);

/**
 * Can a person standing at (ax,ay) see (bx,by) in a straight line, i.e. does
 * no wall centreline cross that segment?
 *
 * Reuses `autoConnect.segmentsIntersect`'s proper-intersection semantics: a
 * wall that only shares an endpoint with the sightline (meeting at a node, or
 * touching a wall's own endpoint) does not count as blocking — exactly the
 * same rule `autoConnect.js` applies when deciding whether an edge may be
 * drawn.
 *
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {Array<[number, number, number, number]>} walls wall centreline
 *   segments, shaped like `autoConnect.wallSegments` returns
 * @returns {boolean}
 */
export function lineOfSight(ax, ay, bx, by, walls) {
  return !(walls || []).some(([x1, y1, x2, y2]) =>
    segmentsIntersect(ax, ay, bx, by, x1, y1, x2, y2)
  );
}

/**
 * Greedy any-angle string-pulling: from each anchor, walk forward through the
 * node list and take the farthest node still in a straight line of sight,
 * then anchor there and repeat. This is the standard "farthest visible"
 * simplification — never worse than the original path (every kept segment is
 * a subset of what the walker could already see) and always collapses a
 * straight corridor to its two ends.
 *
 * A protected node — the first, the last, or anything `isProtected` flags
 * (transit points, POIs, emergency exits, entrances) — can never be skipped
 * over: the scan advances index by index and stops the moment it *reaches* a
 * protected node, even if nodes beyond it are still visible from the current
 * anchor. That forces the next anchor to be that protected node, so it always
 * appears in the output.
 *
 * @param {Array<{x:number,y:number}>} nodes node polyline, in walking order
 * @param {Array<[number, number, number, number]>} walls
 * @param {{isProtected?: (node: object, index: number) => boolean}} opts
 * @returns {Array<object>} the subsequence of `nodes` kept after smoothing
 */
export function smoothPolyline(nodes, walls, { isProtected } = {}) {
  const protectedFn = isProtected || (() => false);
  const list = nodes || [];
  if (list.length <= 2) return list.slice();

  const result = [list[0]];
  let anchor = 0;
  const last = list.length - 1;

  while (anchor < last) {
    let farthest = anchor + 1;
    for (let candidate = anchor + 1; candidate <= last; candidate += 1) {
      const a = list[anchor];
      const b = list[candidate];
      if (!lineOfSight(a.x, a.y, b.x, b.y, walls)) break;
      farthest = candidate;
      if (protectedFn(b, candidate)) break;
    }
    result.push(list[farthest]);
    anchor = farthest;
  }

  return result;
}

/**
 * Smooth one route segment's node polyline into drawable points.
 *
 * Returns the node polyline unsmoothed when the floor's drawing has no
 * `wall` or `outline` shapes — an image-only floor has no geometry to test
 * line-of-sight against, and drawing a straight line through an unmapped
 * wall would be worse than the zig-zag the frontend already renders from
 * `segments[].nodes`.
 *
 * @param {Array<{id:string,x:number,y:number,type?:string,hasPoi?:boolean}>} segmentNodes
 *   the same-floor node polyline for one route segment, in walking order
 * @param {{drawing: {shapes: Array<object>}|null}|null} floor
 * @returns {{points: Array<{x:number,y:number,nodeId?:string}>, smoothed: boolean}}
 */
export function smoothSegment(segmentNodes, floor) {
  const list = segmentNodes || [];
  const toPoint = (node) => ({ x: node.x, y: node.y, nodeId: node.id });

  const shapes = floor?.drawing?.shapes ?? [];
  const hasGeometry = shapes.some((shape) => shape.kind === 'wall' || shape.kind === 'outline');
  if (!hasGeometry) {
    return { points: list.map(toPoint), smoothed: false };
  }

  const walls = wallSegments(floor.drawing);
  const isProtected = (node) => PROTECTED_TYPES.has(node.type) || Boolean(node.hasPoi);
  const smoothed = smoothPolyline(list, walls, { isProtected });

  return { points: smoothed.map(toPoint), smoothed: true };
}
