import { lineOfSight, smoothPolyline, smoothSegment } from './smoothing.js';

const node = (id, x, y, extra = {}) => ({ id, x, y, type: 'NORMAL', ...extra });

describe('lineOfSight', () => {
  test('true when nothing lies between the two points', () => {
    expect(lineOfSight(0, 0, 100, 0, [])).toBe(true);
  });

  test('false when a wall segment crosses the line', () => {
    const walls = [[50, -50, 50, 50]];
    expect(lineOfSight(0, 0, 100, 0, walls)).toBe(false);
  });

  test('true when the wall runs alongside but does not cross', () => {
    const walls = [[0, 50, 100, 50]];
    expect(lineOfSight(0, 0, 100, 0, walls)).toBe(true);
  });
});

describe('smoothPolyline', () => {
  test('a collinear zig-zag lattice collapses to two points when no wall intersects', () => {
    const nodes = [
      node('a', 0, 0),
      node('b', 10, 5),
      node('c', 20, -5),
      node('d', 30, 5),
      node('e', 40, 0),
    ];
    const result = smoothPolyline(nodes, [], { isProtected: () => false });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('e');
  });

  test('a wall between the ends keeps the intermediate corner', () => {
    // A wall runs straight down at x=20 from y=-100 to y=100, blocking any
    // direct line from the start (x=0) to the end (x=40). The corner node at
    // (20, 40) goes around it, well clear of the wall's own y-range.
    const nodes = [node('start', 0, 0), node('corner', 20, 40), node('end', 40, 0)];
    const walls = [[20, -100, 20, 100]];
    const result = smoothPolyline(nodes, walls, { isProtected: () => false });
    expect(result.map((n) => n.id)).toEqual(['start', 'corner', 'end']);
  });

  test('transit and POI nodes are never dropped even with a clear line of sight', () => {
    const nodes = [
      node('start', 0, 0),
      node('transit', 10, 0, { type: 'TRANSIT' }),
      node('poi', 20, 0, { hasPoi: true }),
      node('end', 30, 0),
    ];
    const isProtected = (n) => n.type === 'TRANSIT' || n.hasPoi;
    const result = smoothPolyline(nodes, [], { isProtected });
    expect(result.map((n) => n.id)).toEqual(['start', 'transit', 'poi', 'end']);
  });

  test('the first and last node are always kept', () => {
    const nodes = [node('start', 0, 0), node('mid', 5, 0), node('end', 10, 0)];
    const result = smoothPolyline(nodes, [], { isProtected: () => false });
    expect(result[0].id).toBe('start');
    expect(result.at(-1).id).toBe('end');
  });

  test('a single node or empty list passes through unchanged', () => {
    expect(smoothPolyline([], [], {})).toEqual([]);
    const single = [node('only', 1, 1)];
    expect(smoothPolyline(single, [], {})).toEqual(single);
  });
});

describe('smoothSegment', () => {
  const wallFloor = () => ({
    drawing: {
      shapes: [{ kind: 'wall', points: [20, -100, 20, 100], thickness: 4 }],
    },
  });

  test('a floor without drawn walls or outline returns the node polyline unsmoothed', () => {
    const segmentNodes = [node('start', 0, 0), node('mid', 10, 5), node('end', 40, 0)];
    const imageOnlyFloor = { drawing: null };
    const result = smoothSegment(segmentNodes, imageOnlyFloor);
    expect(result.smoothed).toBe(false);
    expect(result.points).toEqual([
      { x: 0, y: 0, nodeId: 'start' },
      { x: 10, y: 5, nodeId: 'mid' },
      { x: 40, y: 0, nodeId: 'end' },
    ]);
  });

  test('a floor with an empty shapes array (no wall/outline) is also unsmoothed', () => {
    const segmentNodes = [node('start', 0, 0), node('mid', 10, 5), node('end', 40, 0)];
    const noGeometryFloor = { drawing: { shapes: [{ kind: 'icon', x: 1, y: 1, icon: 'WC' }] } };
    const result = smoothSegment(segmentNodes, noGeometryFloor);
    expect(result.smoothed).toBe(false);
    expect(result.points.map((p) => p.nodeId)).toEqual(['start', 'mid', 'end']);
  });

  test('a wall keeps the corner and reports smoothed: true', () => {
    const segmentNodes = [
      node('start', 0, 0),
      node('corner', 20, 40),
      node('end', 40, 0),
    ];
    const result = smoothSegment(segmentNodes, wallFloor());
    expect(result.smoothed).toBe(true);
    expect(result.points.map((p) => p.nodeId)).toEqual(['start', 'corner', 'end']);
  });

  test('protected node types (TRANSIT, EMERGENCY_EXIT, POI, ENTRANCE) and hasPoi survive smoothing', () => {
    const segmentNodes = [
      node('start', 0, 0),
      node('transit', 10, 0, { type: 'TRANSIT' }),
      node('exit', 15, 0, { type: 'EMERGENCY_EXIT' }),
      node('poiNode', 20, 0, { type: 'POI' }),
      node('entrance', 25, 0, { type: 'ENTRANCE' }),
      node('hasPoiFlag', 27, 0, { hasPoi: true }),
      node('end', 30, 0),
    ];
    // Floor has an outline so the segment goes through the smoothing path,
    // but no walls, so line-of-sight is clear the whole way — collapsing
    // would be the naive result if protection did not apply.
    const outlineOnlyFloor = {
      drawing: { shapes: [{ kind: 'outline', points: [0, -50, 100, -50, 100, 50, 0, 50] }] },
    };
    const result = smoothSegment(segmentNodes, outlineOnlyFloor);
    expect(result.smoothed).toBe(true);
    expect(result.points.map((p) => p.nodeId)).toEqual([
      'start',
      'transit',
      'exit',
      'poiNode',
      'entrance',
      'hasPoiFlag',
      'end',
    ]);
  });
});
