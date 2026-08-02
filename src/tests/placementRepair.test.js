import { repairAdditions, rectsCollide, rectIoU } from '../features/ai/placementRepair.js';

/* The repair pass is the hard guarantee behind "AI additions cannot land on
   my work" — the prompt asks, this enforces. */

const room = (x, y, w, h, extra = {}) => ({
  id: extra.id || 'r',
  kind: 'room',
  x,
  y,
  width: w,
  height: h,
  ...extra,
});

describe('rectsCollide', () => {
  test('partial overlap collides; touching does not', () => {
    expect(rectsCollide({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
    // Sharing an edge is how adjacent rooms are drawn.
    expect(rectsCollide({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 })).toBe(false);
  });

  test('a kiosk fully inside a much larger hall is not a collision', () => {
    const hall = { x: 0, y: 0, w: 600, h: 600 };
    const kiosk = { x: 200, y: 200, w: 100, h: 100 };
    expect(rectsCollide(kiosk, hall)).toBe(false);
    // But a near-equal shape inside another IS a collision (that's a dupe/overlap).
    expect(rectsCollide({ x: 10, y: 10, w: 580, h: 580 }, hall)).toBe(true);
  });
});

describe('repairAdditions', () => {
  test('an addition dropped onto an existing room is nudged into clear space', () => {
    const existing = [room(0, 0, 400, 400, { id: 'hand', name: 'Lobby' })];
    const { shapes, moved, dropped } = repairAdditions({
      existingShapes: existing,
      additions: [room(100, 100, 200, 200, { id: 'x', name: 'New office' })],
      canvasW: 1000,
      canvasH: 800,
      freeRects: [{ x: 400, y: 0, w: 600, h: 800 }],
    });
    expect(dropped).toBe(0);
    expect(moved).toBe(1);
    expect(shapes).toHaveLength(1);
    const placed = { x: shapes[0].x, y: shapes[0].y, w: shapes[0].width, h: shapes[0].height };
    // Clear of the lobby, on-grid, on-canvas.
    expect(rectsCollide(placed, { x: 0, y: 0, w: 400, h: 400 })).toBe(false);
    expect(placed.x % 25).toBe(0);
    expect(placed.y % 25).toBe(0);
    expect(placed.x + placed.w).toBeLessThanOrEqual(1000);
    expect(placed.y + placed.h).toBeLessThanOrEqual(800);
  });

  test('a re-emitted copy of an existing shape is dropped as a duplicate', () => {
    const existing = [room(100, 100, 300, 200, { id: 'hand', name: 'My Shop', kind: 'shop' })];
    existing[0].kind = 'shop';
    const copy = { ...room(100, 100, 300, 200, { id: 'ai', name: 'My Shop (improved)' }), kind: 'shop' };
    const { shapes, dropped } = repairAdditions({
      existingShapes: existing,
      additions: [copy],
      canvasW: 1000,
      canvasH: 800,
    });
    expect(dropped).toBe(1);
    expect(shapes).toHaveLength(0);
  });

  test('a shape that fits nowhere is dropped, not forced in', () => {
    // The whole canvas is one existing room; no free rects.
    const existing = [room(0, 0, 1000, 800, { id: 'hand', name: 'Everything' })];
    const { shapes, dropped } = repairAdditions({
      existingShapes: existing,
      // Big enough that the containment exception cannot apply.
      additions: [room(200, 200, 700, 500, { id: 'x' })],
      canvasW: 1000,
      canvasH: 800,
      freeRects: [],
    });
    expect(dropped).toBe(1);
    expect(shapes).toHaveLength(0);
  });

  test('the AI\'s own additions cannot pile on top of each other', () => {
    const { shapes, dropped } = repairAdditions({
      existingShapes: [],
      additions: [
        room(100, 100, 200, 200, { id: 'a', name: 'A' }),
        room(100, 100, 200, 200, { id: 'b', name: 'B' }),
      ],
      canvasW: 1000,
      canvasH: 800,
    });
    expect(dropped).toBe(0);
    expect(shapes).toHaveLength(2);
    const [a, b] = shapes.map((s) => ({ x: s.x, y: s.y, w: s.width, h: s.height }));
    expect(rectsCollide(a, b)).toBe(false);
  });

  test('off-canvas shapes are clamped, icons and walls included', () => {
    const { shapes } = repairAdditions({
      existingShapes: [],
      additions: [
        room(950, 750, 200, 200, { id: 'r' }),
        { id: 'i', kind: 'icon', x: 1200, y: -50, icon: 'EXIT' },
        { id: 'w', kind: 'wall', points: [-100, 0, 1500, 900], thickness: 6 },
      ],
      canvasW: 1000,
      canvasH: 800,
    });
    const r = shapes.find((s) => s.kind === 'room');
    expect(r.x + r.width).toBeLessThanOrEqual(1000);
    expect(r.y + r.height).toBeLessThanOrEqual(800);
    const icon = shapes.find((s) => s.kind === 'icon');
    expect(icon).toMatchObject({ x: 1000, y: 0 });
    const wall = shapes.find((s) => s.kind === 'wall');
    expect(wall.points).toEqual([0, 0, 1000, 800]);
  });

  test('duplicate icons on top of existing ones are dropped', () => {
    const existing = [{ id: 'e', kind: 'icon', x: 500, y: 400, icon: 'EXIT' }];
    const { shapes, dropped } = repairAdditions({
      existingShapes: existing,
      additions: [
        { id: 'dup', kind: 'icon', x: 510, y: 405, icon: 'EXIT' },
        { id: 'ok', kind: 'icon', x: 100, y: 100, icon: 'ENTRANCE' },
      ],
      canvasW: 1000,
      canvasH: 800,
    });
    expect(dropped).toBe(1);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].icon).toBe('ENTRANCE');
  });

  test('rectIoU is 1 for identical rects and 0 for disjoint ones', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(rectIoU(a, { ...a })).toBe(1);
    expect(rectIoU(a, { x: 500, y: 500, w: 10, h: 10 })).toBe(0);
  });
});
