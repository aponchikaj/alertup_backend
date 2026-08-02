/* ============================================================================
   Placement repair — AI additions may not land on top of the user's work.
   ----------------------------------------------------------------------------
   The prompt tells the model to design inside the free areas; this module is
   what makes that true when it doesn't listen. Every generated shape passes
   through here before the merge:

     - rooms/shops snap to the editor's 25-unit grid and are clamped on-canvas;
     - near-duplicates of existing shapes are dropped (a model "helpfully"
       re-emitting the user's lobby must not create a second lobby);
     - a shape overlapping existing rooms/shops (or earlier accepted
       additions) is NUDGED to the nearest clear grid position; if nothing
       within reach is clear it is re-homed into the largest free rectangle;
       if it fits nowhere it is dropped, and the reply says so;
     - icons and text are clamped on-canvas; duplicate icons (same type, on
       top of an existing one) are dropped;
     - wall points are clamped on-canvas.

   Deliberate exception: a small shape FULLY INSIDE a much larger one is not a
   collision — "add a kiosk in the food court" legitimately places a shop
   inside a big hall room. Only partial overlaps are chaos.

   Pure module: shapes in, {shapes, moved, dropped} out.
   ========================================================================= */

/** The editor's snap grid. */
const GRID = 25;

/** Penetration below this is "touching", which adjacent rooms must be allowed. */
const TOL = 2;

/** How far a shape may be relocated from where the model put it. */
const MAX_NUDGE = 400;

/** Containment exception: the host must be at least this many times larger —
 *  a kiosk in a food court qualifies, a room half the hall's size does not. */
const CONTAIN_RATIO = 6;

/** Same-kind rects with IoU above this are the same shape re-emitted. */
const DUPLICATE_IOU = 0.55;

/** An icon of the same type within this radius of an existing one is a dupe. */
const ICON_DUPLICATE_RADIUS = 40;

const snap = (v) => Math.round(v / GRID) * GRID;

const rectOf = (s) => ({ x: s.x, y: s.y, w: s.width, h: s.height });

const contains = (inner, outer) =>
  inner.x >= outer.x - TOL &&
  inner.y >= outer.y - TOL &&
  inner.x + inner.w <= outer.x + outer.w + TOL &&
  inner.y + inner.h <= outer.y + outer.h + TOL;

/** Overlap that counts as a collision (touching and kiosk-in-hall are fine). */
export function rectsCollide(a, b) {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= TOL || iy <= TOL) return false;
  if (contains(a, b) && b.w * b.h >= CONTAIN_RATIO * a.w * a.h) return false;
  if (contains(b, a) && a.w * a.h >= CONTAIN_RATIO * b.w * b.h) return false;
  return true;
}

/** Intersection-over-union of two rects — the duplicate detector. */
export function rectIoU(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  if (inter === 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Grid offsets within MAX_NUDGE, nearest first — the nudge search order. */
const NUDGE_OFFSETS = (() => {
  const offsets = [];
  const steps = Math.floor(MAX_NUDGE / GRID);
  for (let dx = -steps; dx <= steps; dx += 1) {
    for (let dy = -steps; dy <= steps; dy += 1) {
      if (dx === 0 && dy === 0) continue;
      offsets.push({ dx: dx * GRID, dy: dy * GRID, d: Math.hypot(dx, dy) });
    }
  }
  offsets.sort((a, b) => a.d - b.d);
  return offsets;
})();

/**
 * Repair one batch of AI-generated shapes against the floor they will join.
 *
 * @param {object} params
 * @param {Array} params.existingShapes shapes already on the floor (locked)
 * @param {Array} params.additions shapes the model generated
 * @param {number} params.canvasW
 * @param {number} params.canvasH
 * @param {Array<{x,y,w,h}>} [params.freeRects] from analyzeFloor — fallback homes
 * @returns {{shapes: Array, moved: number, dropped: number}}
 */
export function repairAdditions({ existingShapes = [], additions = [], canvasW, canvasH, freeRects = [] }) {
  const existingRects = existingShapes
    .filter((s) => s.kind === 'room' || s.kind === 'shop')
    .map((s) => ({ rect: rectOf(s), kind: s.kind }));
  const existingIcons = existingShapes.filter((s) => s.kind === 'icon');

  // Everything a new room/shop must not partially overlap: existing boxes
  // plus additions accepted so far (so the AI's own shapes cannot pile up).
  const obstacles = existingRects.map((e) => e.rect);

  const inCanvas = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= canvasW && r.y + r.h <= canvasH;
  const clear = (r) => obstacles.every((o) => !rectsCollide(r, o));

  const shapes = [];
  const acceptedIcons = [];
  let moved = 0;
  let dropped = 0;

  for (const shape of additions) {
    if (shape.kind === 'room' || shape.kind === 'shop') {
      const w = Math.max(GRID, Math.min(snap(shape.width) || GRID, canvasW));
      const h = Math.max(GRID, Math.min(snap(shape.height) || GRID, canvasH));
      let x = Math.min(Math.max(snap(shape.x), 0), canvasW - w);
      let y = Math.min(Math.max(snap(shape.y), 0), canvasH - h);
      const desired = { x, y, w, h };

      // The model re-emitted an existing shape: drop the copy, the original
      // is already on the floor.
      const isDuplicate = existingRects.some(
        (e) => e.kind === shape.kind && rectIoU(desired, e.rect) >= DUPLICATE_IOU,
      );
      if (isDuplicate) {
        dropped += 1;
        continue;
      }

      let placed = null;
      if (clear(desired)) {
        placed = desired;
      } else {
        for (const { dx, dy } of NUDGE_OFFSETS) {
          const candidate = { x: x + dx, y: y + dy, w, h };
          if (!inCanvas(candidate)) continue;
          if (clear(candidate)) {
            placed = candidate;
            break;
          }
        }
        if (!placed) {
          // Nothing near the model's spot is clear — re-home into a free area.
          for (const rect of freeRects) {
            if (rect.w < w || rect.h < h) continue;
            const candidate = {
              x: Math.min(Math.max(snap(rect.x), 0), canvasW - w),
              y: Math.min(Math.max(snap(rect.y), 0), canvasH - h),
              w,
              h,
            };
            if (inCanvas(candidate) && clear(candidate)) {
              placed = candidate;
              break;
            }
          }
        }
        if (placed) moved += 1;
      }

      if (!placed) {
        dropped += 1;
        continue;
      }

      obstacles.push(placed);
      shapes.push({ ...shape, x: placed.x, y: placed.y, width: w, height: h });
      continue;
    }

    if (shape.kind === 'icon') {
      const x = Math.min(Math.max(shape.x, 0), canvasW);
      const y = Math.min(Math.max(shape.y, 0), canvasH);
      const isDuplicate = [...existingIcons, ...acceptedIcons].some(
        (icon) => icon.icon === shape.icon && Math.hypot(icon.x - x, icon.y - y) <= ICON_DUPLICATE_RADIUS,
      );
      if (isDuplicate) {
        dropped += 1;
        continue;
      }
      const placedIcon = { ...shape, x, y };
      acceptedIcons.push(placedIcon);
      shapes.push(placedIcon);
      continue;
    }

    if (shape.kind === 'text') {
      shapes.push({
        ...shape,
        x: Math.min(Math.max(shape.x, 0), canvasW),
        y: Math.min(Math.max(shape.y, 0), canvasH),
      });
      continue;
    }

    if (shape.kind === 'wall' || shape.kind === 'outline') {
      const points = (shape.points || []).map((v, i) =>
        i % 2 === 0 ? Math.min(Math.max(v, 0), canvasW) : Math.min(Math.max(v, 0), canvasH),
      );
      shapes.push({ ...shape, points });
      continue;
    }

    shapes.push(shape);
  }

  return { shapes, moved, dropped };
}

export const REPAIR_LIMITS = { GRID, MAX_NUDGE, DUPLICATE_IOU };
