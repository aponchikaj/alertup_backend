/* ============================================================================
   Floor spatial analysis — the AI designer's "eyes".
   ----------------------------------------------------------------------------
   A language model reasons poorly over raw coordinate JSON: asked to "add two
   shops" to a half-drawn floor it will happily stack them on top of existing
   rooms. This module turns a drawing into the two things the model actually
   needs to design well:

     1. An inventory — what exists, where, with names (rooms, shops, icons,
        walls, outline), plus derived facts (exit count, grid alignment).
     2. A free-space map — the largest empty rectangles on the canvas, i.e.
        the ONLY places where new shapes belong.

   The same free rectangles feed placementRepair.js, so the prompt's "place
   additions only in free areas" instruction is backed by server-side
   enforcement rather than model obedience.

   Pure module: drawing in, analysis out. No I/O, fully unit-testable.
   ========================================================================= */

/** Grid cell for the occupancy raster. Matches the editor's 25-unit grid. */
const CELL = 25;

/** Raster guard — a 10000x10000 canvas still fits (400x400 cells). */
const MAX_CELLS_PER_AXIS = 400;

/** Free rectangles reported to the prompt / repair pass. */
const MAX_FREE_RECTS = 6;

/** Below this a "free area" is useless for placing anything (2x2 cells). */
const MIN_FREE_RECT_UNITS = 50;

/** Axis-aligned bounding rect of a shape, or null for point/line kinds. */
export function shapeRect(shape) {
  if (shape.kind === 'room' || shape.kind === 'shop') {
    return { x: shape.x, y: shape.y, w: shape.width, h: shape.height };
  }
  return null;
}

/** Ray-cast point-in-polygon over a flat [x, y, x, y, ...] array. */
export function pointInPolygon(px, py, pts) {
  let inside = false;
  const n = pts.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = pts[i];
    const yi = pts[i + 1];
    const xj = pts[j];
    const yj = pts[j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Largest all-free rectangle in the occupancy raster (histogram-stack sweep).
 * Returns {c0, r0, w, h} in CELL coordinates, or null when everything is full.
 */
function largestFreeRect(occupied, cols, rows) {
  const heights = new Int32Array(cols);
  let best = null;
  let bestArea = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      heights[c] = occupied[r * cols + c] ? 0 : heights[c] + 1;
    }
    const stack = [];
    for (let c = 0; c <= cols; c += 1) {
      const h = c < cols ? heights[c] : 0;
      while (stack.length && heights[stack[stack.length - 1]] >= h) {
        const height = heights[stack.pop()];
        const left = stack.length ? stack[stack.length - 1] + 1 : 0;
        const width = c - left;
        if (height * width > bestArea) {
          bestArea = height * width;
          best = { c0: left, r0: r - height + 1, w: width, h: height };
        }
      }
      stack.push(c);
    }
  }
  return best;
}

/**
 * Analyze a floor drawing against its canvas.
 *
 * @param {object|null} drawing normalized Floor.drawing
 * @param {number} canvasW
 * @param {number} canvasH
 * @returns {{
 *   rooms: Array, shops: Array, icons: Array, walls: number,
 *   outline: object|null, freeRects: Array<{x,y,w,h}>, occupiedRatio: number
 * }}
 */
export function analyzeFloor(drawing, canvasW, canvasH) {
  const shapes = Array.isArray(drawing?.shapes) ? drawing.shapes : [];
  const rooms = shapes.filter((s) => s.kind === 'room');
  const shops = shapes.filter((s) => s.kind === 'shop');
  const icons = shapes.filter((s) => s.kind === 'icon');
  const walls = shapes.filter((s) => s.kind === 'wall');
  const outline = shapes.find((s) => s.kind === 'outline') || null;

  const cols = Math.min(Math.max(1, Math.ceil(canvasW / CELL)), MAX_CELLS_PER_AXIS);
  const rows = Math.min(Math.max(1, Math.ceil(canvasH / CELL)), MAX_CELLS_PER_AXIS);
  const occupied = new Uint8Array(cols * rows);

  const markRect = (x, y, w, h) => {
    const c0 = Math.max(0, Math.floor(x / CELL));
    const r0 = Math.max(0, Math.floor(y / CELL));
    const c1 = Math.min(cols - 1, Math.ceil((x + w) / CELL) - 1);
    const r1 = Math.min(rows - 1, Math.ceil((y + h) / CELL) - 1);
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) occupied[r * cols + c] = 1;
    }
  };

  for (const s of [...rooms, ...shops]) markRect(s.x, s.y, s.width, s.height);

  // Walls: sample along each segment so rooms are not placed straddling them.
  for (const wall of walls) {
    const pts = wall.points || [];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x1 = pts[i];
      const y1 = pts[i + 1];
      const x2 = pts[i + 2];
      const y2 = pts[i + 3];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (CELL / 2)));
      for (let t = 0; t <= steps; t += 1) {
        const px = x1 + ((x2 - x1) * t) / steps;
        const py = y1 + ((y2 - y1) * t) / steps;
        const c = Math.floor(px / CELL);
        const r = Math.floor(py / CELL);
        if (c >= 0 && c < cols && r >= 0 && r < rows) occupied[r * cols + c] = 1;
      }
    }
  }

  // Outside the outline polygon is not part of the floor at all.
  if (outline?.points?.length >= 6) {
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (occupied[r * cols + c]) continue;
        const cx = c * CELL + CELL / 2;
        const cy = r * CELL + CELL / 2;
        if (!pointInPolygon(cx, cy, outline.points)) occupied[r * cols + c] = 1;
      }
    }
  }

  const occupiedCells = occupied.reduce((sum, v) => sum + v, 0);
  const occupiedRatio = occupiedCells / (cols * rows);

  // Peel off the biggest empty rectangles one by one: report each, mark it
  // used, repeat. Disjoint by construction, so the prompt can present them as
  // independent building sites.
  const freeRects = [];
  const scratch = Uint8Array.from(occupied);
  for (let i = 0; i < MAX_FREE_RECTS; i += 1) {
    const rect = largestFreeRect(scratch, cols, rows);
    if (!rect) break;
    const units = {
      x: rect.c0 * CELL,
      y: rect.r0 * CELL,
      w: rect.w * CELL,
      h: rect.h * CELL,
    };
    if (units.w < MIN_FREE_RECT_UNITS || units.h < MIN_FREE_RECT_UNITS) break;
    // Clip to the actual canvas edge (the last cell row/col may overhang).
    units.w = Math.min(units.w, canvasW - units.x);
    units.h = Math.min(units.h, canvasH - units.y);
    freeRects.push(units);
    for (let r = rect.r0; r < rect.r0 + rect.h; r += 1) {
      for (let c = rect.c0; c < rect.c0 + rect.w; c += 1) {
        scratch[r * cols + c] = 1;
      }
    }
  }

  return { rooms, shops, icons, walls: walls.length, outline, freeRects, occupiedRatio };
}

const fmt = (n) => String(Math.round(n));

const rectLine = (s) =>
  `${s.name ? `"${s.name}"` : '(unnamed)'} at (${fmt(s.x)},${fmt(s.y)}) size ${fmt(s.width)}x${fmt(s.height)}`;

/** Cap enumerations so a 500-shape mall cannot blow up the prompt. */
const MAX_LISTED = 30;

/**
 * Render the analysis as the MAP ANALYSIS prompt block. Compact, factual,
 * and in the exact coordinate language the model must answer in.
 */
export function describeFloorForPrompt(analysis, canvasW, canvasH) {
  const { rooms, shops, icons, walls, outline, freeRects, occupiedRatio } = analysis;
  const lines = [`MAP ANALYSIS (canvas ${fmt(canvasW)}x${fmt(canvasH)} units, 50 units = 1 metre):`];

  if (rooms.length) {
    const listed = rooms.slice(0, MAX_LISTED).map(rectLine).join('; ');
    lines.push(`- Rooms (${rooms.length}): ${listed}${rooms.length > MAX_LISTED ? '; …' : ''}`);
  }
  if (shops.length) {
    const listed = shops.slice(0, MAX_LISTED).map(rectLine).join('; ');
    lines.push(`- Shops (${shops.length}): ${listed}${shops.length > MAX_LISTED ? '; …' : ''}`);
  }
  if (icons.length) {
    const listed = icons
      .slice(0, MAX_LISTED)
      .map((s) => `${s.icon} at (${fmt(s.x)},${fmt(s.y)})`)
      .join('; ');
    lines.push(`- Icons (${icons.length}): ${listed}${icons.length > MAX_LISTED ? '; …' : ''}`);
  }
  if (walls) lines.push(`- Walls: ${walls} wall shape(s) drawn.`);
  if (outline) lines.push('- The floor has a hand-drawn outline (footprint); stay inside it.');

  if (freeRects.length) {
    const listed = freeRects
      .map((r) => `(${fmt(r.x)},${fmt(r.y)}) size ${fmt(r.w)}x${fmt(r.h)}`)
      .join('; ');
    lines.push(`- FREE AREAS — the only places with room for new shapes: ${listed}.`);
  } else if (rooms.length || shops.length) {
    lines.push('- FREE AREAS: none — the floor is effectively full; adding rooms requires the user to clear space first.');
  }

  lines.push(`- Occupancy: ${Math.round(occupiedRatio * 100)}% of the canvas is taken.`);
  return lines.join('\n');
}

export const ANALYSIS_LIMITS = { CELL, MAX_FREE_RECTS };
