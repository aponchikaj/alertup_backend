import {
  analyzeFloor,
  describeFloorForPrompt,
  pointInPolygon,
} from '../features/ai/floorAnalysis.js';

/* The analyzer is the designer's eyes: if the free-space map is wrong the
   model designs into walls, so the geometry here is worth pinning down. */

describe('pointInPolygon', () => {
  const square = [0, 0, 100, 0, 100, 100, 0, 100];

  test('classifies inside and outside', () => {
    expect(pointInPolygon(50, 50, square)).toBe(true);
    expect(pointInPolygon(150, 50, square)).toBe(false);
    expect(pointInPolygon(-1, 50, square)).toBe(false);
  });
});

describe('analyzeFloor', () => {
  test('empty floor: zero occupancy, one free rect covering the canvas', () => {
    const analysis = analyzeFloor(null, 1000, 800);
    expect(analysis.occupiedRatio).toBe(0);
    expect(analysis.rooms).toHaveLength(0);
    expect(analysis.freeRects.length).toBeGreaterThan(0);
    const [biggest] = analysis.freeRects;
    expect(biggest).toMatchObject({ x: 0, y: 0, w: 1000, h: 800 });
  });

  test('free rects never overlap existing rooms', () => {
    // Left half occupied by a big hall; free space must be on the right.
    const drawing = {
      version: 1,
      shapes: [{ id: 'a', kind: 'room', x: 0, y: 0, width: 500, height: 800, name: 'Hall' }],
    };
    const analysis = analyzeFloor(drawing, 1000, 800);
    expect(analysis.occupiedRatio).toBeGreaterThan(0.4);
    expect(analysis.freeRects.length).toBeGreaterThan(0);
    for (const rect of analysis.freeRects) {
      // No free rect may reach into the hall's columns.
      expect(rect.x).toBeGreaterThanOrEqual(500);
    }
  });

  test('the outline confines free space to the footprint', () => {
    // Footprint covers only the top-left quarter of the canvas.
    const drawing = {
      version: 1,
      shapes: [{ id: 'o', kind: 'outline', points: [0, 0, 500, 0, 500, 400, 0, 400] }],
    };
    const analysis = analyzeFloor(drawing, 1000, 800);
    for (const rect of analysis.freeRects) {
      expect(rect.x + rect.w).toBeLessThanOrEqual(500);
      expect(rect.y + rect.h).toBeLessThanOrEqual(400);
    }
  });

  test('walls block free space along their line', () => {
    const drawing = {
      version: 1,
      shapes: [{ id: 'w', kind: 'wall', points: [500, 0, 500, 800], thickness: 6 }],
    };
    const analysis = analyzeFloor(drawing, 1000, 800);
    // No free rect straddles the vertical wall at x=500.
    for (const rect of analysis.freeRects) {
      const crossesWall = rect.x < 500 && rect.x + rect.w > 525;
      expect(crossesWall).toBe(false);
    }
  });
});

describe('describeFloorForPrompt', () => {
  test('names, positions and free areas reach the prompt', () => {
    const drawing = {
      version: 1,
      shapes: [
        { id: 'a', kind: 'room', x: 0, y: 0, width: 300, height: 200, name: 'Lobby' },
        { id: 'b', kind: 'shop', x: 700, y: 0, width: 300, height: 200, name: 'Zara' },
        { id: 'c', kind: 'icon', x: 980, y: 400, icon: 'EXIT' },
      ],
    };
    const analysis = analyzeFloor(drawing, 1000, 800);
    const text = describeFloorForPrompt(analysis, 1000, 800);
    expect(text).toContain('"Lobby" at (0,0) size 300x200');
    expect(text).toContain('"Zara"');
    expect(text).toContain('EXIT at (980,400)');
    expect(text).toContain('FREE AREAS');
    expect(text).toContain('Occupancy:');
  });

  test('an empty floor still reports its free canvas', () => {
    const text = describeFloorForPrompt(analyzeFloor(null, 1000, 800), 1000, 800);
    expect(text).toContain('FREE AREAS');
    expect(text).toContain('(0,0) size 1000x800');
  });
});
