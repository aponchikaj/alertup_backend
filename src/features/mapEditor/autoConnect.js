/* ============================================================================
   Auto-connect — wire a floor's nodes into one walkable graph.
   ----------------------------------------------------------------------------
   One click in the editor (or one AI action) instead of dozens of manual
   connect gestures. Pure module: geometry in, list of pairs out — the route
   handler owns persistence.

   The plan:

     1. Minimum spanning tree over every node, seeded with the connections
        that already exist — guarantees the floor ends up as ONE component
        (routable end to end) while never duplicating or contradicting what
        the owner wired by hand.
     2. Shortcut pass: each node also links to its nearest neighbours within
        a walkable distance, so routes cut corners the way people do instead
        of snaking through a single chain.
     3. Drawn WALLS block edges. An auto-connector that wires paths through
        concrete would poison evacuation routing at the exact moment it
        matters, so any candidate crossing a wall segment is discarded — in
        the MST pass too. If walls genuinely separate two groups of nodes,
        they stay separate; that is the truthful answer.
   ========================================================================= */

/** Beyond this (12 m at 50 px/m), a direct hop is not how people walk. */
const DEFAULT_MAX_SHORTCUT = 600;

/** Shortcut links per node, beyond what the MST already gave it. */
const DEFAULT_EXTRA_NEIGHBORS = 2;

/** Runaway guard for pathological floors. */
const MAX_NEW_EDGES = 300;

/** Proper segment intersection (shared endpoints do not count — edges that
 *  meet at a node are normal, not blocked). */
export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const orient = (px, py, qx, qy, rx, ry) => {
    const v = (qy - py) * (rx - qx) - (qx - px) * (ry - qy);
    if (v > 1e-9) return 1;
    if (v < -1e-9) return -1;
    return 0;
  };
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/** Wall centreline segments out of a floor drawing. */
export function wallSegments(drawing) {
  const segments = [];
  for (const shape of drawing?.shapes ?? []) {
    if (shape.kind !== 'wall' || !Array.isArray(shape.points)) continue;
    for (let i = 0; i + 3 < shape.points.length; i += 2) {
      segments.push([
        shape.points[i],
        shape.points[i + 1],
        shape.points[i + 2],
        shape.points[i + 3],
      ]);
    }
  }
  return segments;
}

const blockedByWall = (a, b, walls) =>
  walls.some(([x1, y1, x2, y2]) =>
    segmentsIntersect(a.x, a.y, b.x, b.y, x1, y1, x2, y2),
  );

class UnionFind {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }
  find(id) {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path compression.
    let cursor = id;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.parent.set(ra, rb);
    return true;
  }
}

/**
 * Plan the connections that turn a floor's nodes into one walkable graph.
 *
 * @param {Array<{id: string, x: number, y: number}>} nodes same-floor nodes
 * @param {Array<{sourceNodeId: string, targetNodeId: string}>} existingEdges
 * @param {object|null} drawing the floor's drawing (walls block edges)
 * @param {{maxShortcut?: number, extraNeighbors?: number}} options
 * @returns {Array<[string, string]>} node-id pairs to connect
 */
export function planAutoConnect(nodes, existingEdges, drawing, options = {}) {
  const maxShortcut = options.maxShortcut ?? DEFAULT_MAX_SHORTCUT;
  const extraNeighbors = options.extraNeighbors ?? DEFAULT_EXTRA_NEIGHBORS;

  if (nodes.length < 2) return [];

  const walls = wallSegments(drawing);
  const key = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const connected = new Set(
    existingEdges.map((e) => key(e.sourceNodeId, e.targetNodeId)),
  );

  // All viable candidate pairs, closest first.
  const candidates = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      if (connected.has(key(a.id, b.id))) continue;
      if (blockedByWall(a, b, walls)) continue;
      candidates.push({
        a: a.id,
        b: b.id,
        distance: Math.hypot(a.x - b.x, a.y - b.y),
      });
    }
  }
  candidates.sort((p, q) => p.distance - q.distance);

  const uf = new UnionFind(nodes.map((n) => n.id));
  for (const e of existingEdges) uf.union(e.sourceNodeId, e.targetNodeId);

  const planned = [];
  const degree = new Map();
  const addDegree = (id) => degree.set(id, (degree.get(id) ?? 0) + 1);

  // Pass 1 — connectivity. No length cap: joining two distant islands with
  // one long corridor beats leaving half the floor unroutable.
  for (const { a, b } of candidates) {
    if (planned.length >= MAX_NEW_EDGES) return planned;
    if (!uf.union(a, b)) continue;
    planned.push([a, b]);
    connected.add(key(a, b));
    addDegree(a);
    addDegree(b);
  }

  // Pass 2 — shortcuts, nearest-first, capped per node and by distance.
  for (const { a, b, distance } of candidates) {
    if (planned.length >= MAX_NEW_EDGES) break;
    if (distance > maxShortcut) break; // sorted, so nothing closer follows
    if (connected.has(key(a, b))) continue;
    if ((degree.get(a) ?? 0) >= extraNeighbors && (degree.get(b) ?? 0) >= extraNeighbors) {
      continue;
    }
    planned.push([a, b]);
    connected.add(key(a, b));
    addDegree(a);
    addDegree(b);
  }

  return planned;
}

export const AUTO_CONNECT_LIMITS = { MAX_NEW_EDGES };
