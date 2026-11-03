import {
  TURN_TABLE,
  bearing,
  classifyTurn,
  douglasPeucker,
  pickLandmark,
  buildInstructions,
} from './instructions.js';
import { assembleRoute } from './routeAssembler.js';
import { resolveProfile } from './costModel.js';
import { buildGraph } from '../../tests/graphFixtures.js';

/* ============================================================================
   Turn classification — the Valhalla bands.
   ----------------------------------------------------------------------------
   `deltaDeg` is the CLOCKWISE turn from the incoming bearing to the outgoing
   one, so a small delta is a right turn and a large one is a left turn. The
   band edges below are the ones the brief pins, taken from Valhalla's
   `Turn::GetType`: each pair is the last degree of one band and the first
   degree of the next, so an off-by-one in either direction fails.
   ========================================================================= */

describe('classifyTurn', () => {
  test('0 and a straight-ahead wrap are straight', () => {
    expect(classifyTurn(0)).toBe('straight');
    expect(classifyTurn(359)).toBe('straight');
    expect(classifyTurn(360)).toBe('straight');
  });

  test.each([
    [10, 'straight'],
    [11, 'slight_right'],
    [44, 'slight_right'],
    [45, 'right'],
    [135, 'right'],
    [136, 'sharp_right'],
    [159, 'sharp_right'],
    [160, 'uturn'],
    [200, 'uturn'],
    [201, 'sharp_left'],
    [224, 'sharp_left'],
    [225, 'left'],
    [315, 'left'],
    [316, 'slight_left'],
    [349, 'slight_left'],
    [350, 'straight'],
  ])('%i° is %s', (deg, kind) => {
    expect(classifyTurn(deg)).toBe(kind);
  });

  test('normalises deltas outside 0-359', () => {
    expect(classifyTurn(-90)).toBe('left');
    expect(classifyTurn(450)).toBe('right');
  });

  test('TURN_TABLE bands are contiguous and cover every degree', () => {
    for (let deg = 0; deg < 360; deg += 1) {
      const band = TURN_TABLE.find((b) => deg >= b.from && deg <= b.to);
      expect(classifyTurn(deg)).toBe(band ? band.kind : 'straight');
    }
  });
});

describe('bearing', () => {
  test('0 is up the map and angles run clockwise', () => {
    const origin = { x: 100, y: 100 };
    expect(bearing(origin, { x: 100, y: 0 })).toBe(0); // up
    expect(bearing(origin, { x: 200, y: 100 })).toBe(90); // right
    expect(bearing(origin, { x: 100, y: 200 })).toBe(180); // down
    expect(bearing(origin, { x: 0, y: 100 })).toBe(270); // left
  });

  test('a zero-length step has no bearing', () => {
    expect(bearing({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull();
  });
});

describe('douglasPeucker', () => {
  test('drops vertices that wander less than eps off the straight line', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 50, y: 5 }, // 5 px off a 200 px line
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ];
    expect(douglasPeucker(line, 20)).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ]);
  });

  test('keeps a corner that is further than eps off the chord', () => {
    const corner = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 200 },
    ];
    expect(douglasPeucker(corner, 20)).toEqual(corner);
  });

  test('preserves endpoints and their nodeIds', () => {
    const pts = [
      { x: 0, y: 0, nodeId: 'a' },
      { x: 10, y: 0, nodeId: 'b' },
      { x: 20, y: 0, nodeId: 'c' },
    ];
    const kept = douglasPeucker(pts, 5);
    expect(kept).toHaveLength(2);
    expect(kept[0].nodeId).toBe('a');
    expect(kept[1].nodeId).toBe('c');
  });

  test('returns short inputs untouched', () => {
    expect(douglasPeucker([], 5)).toEqual([]);
    expect(douglasPeucker([{ x: 1, y: 1 }], 5)).toEqual([{ x: 1, y: 1 }]);
  });
});

/* ============================================================================
   Landmarks.
   ----------------------------------------------------------------------------
   Every fixture below walks EAST (+x). Map y grows downward, so "right of the
   walker" is +y and "left" is -y.
   ========================================================================= */

const PREV = { x: 0, y: 0 };
const TURN = { x: 200, y: 0 };
const poi = (id, name, x, y, category = 'shop') => ({ id, name, category, x, y });

describe('pickLandmark', () => {
  test('a landmark on the turn side beats a closer one on the wrong side', () => {
    const onSide = poi('p1', 'Coffee Bar', 200, 100); // right, 100 px away
    const wrongSide = poi('p2', 'Flower Shop', 200, -40); // left, 40 px away

    const picked = pickLandmark(TURN, PREV, [wrongSide, onSide], [], {
      radiusPx: 300,
      side: 'right',
    });

    expect(picked).toMatchObject({ poiId: 'p1', name: 'Coffee Bar', side: 'right' });
  });

  test('reports which side of the walker the landmark is on', () => {
    const left = poi('p3', 'Info Desk', 200, -80);
    expect(
      pickLandmark(TURN, PREV, [left], [], { radiusPx: 300, side: 'left' })
    ).toMatchObject({ side: 'left' });
  });

  test('relation is before / at / after along the approach', () => {
    const rel = (x) =>
      pickLandmark(TURN, PREV, [poi('p', 'Kiosk', x, 80)], [], {
        radiusPx: 400,
        side: 'right',
      }).relation;

    expect(rel(100)).toBe('before'); // still short of the turn
    expect(rel(200)).toBe('at'); // level with it
    expect(rel(320)).toBe('after'); // past it
  });

  test('ignores anything outside the radius', () => {
    const far = poi('p4', 'Far Shop', 200, 400);
    expect(pickLandmark(TURN, PREV, [far], [], { radiusPx: 100, side: 'right' })).toBeNull();
  });

  test('a wall in the way loses to a visible landmark further away', () => {
    const hidden = poi('p5', 'Hidden Shop', 200, 60);
    const visible = poi('p6', 'Visible Shop', 60, 150);
    // A short wall directly in front of the near shop only — the sightline to
    // the far one passes to the side of it.
    const walls = [[180, 30, 230, 30]];

    const picked = pickLandmark(TURN, PREV, [hidden, visible], walls, {
      radiusPx: 400,
      side: 'right',
    });

    expect(picked.poiId).toBe('p6');
  });

  test('a repeated name loses to a unique one', () => {
    const picked = pickLandmark(
      TURN,
      PREV,
      [poi('p7', 'Kiosk', 200, 40), poi('p8', 'Kiosk', 210, 60), poi('p9', 'Coffee Bar', 200, 150)],
      [],
      { radiusPx: 400, side: 'right' }
    );

    expect(picked.name).toBe('Coffee Bar');
  });

  test('a door outranks a shop at the same distance and side', () => {
    const picked = pickLandmark(
      TURN,
      PREV,
      [poi('p10', 'Gift Shop', 190, 100, 'shop'), poi('p11', 'Side Entrance', 210, 100, 'entrance')],
      [],
      { radiusPx: 400, side: 'right' }
    );

    expect(picked.name).toBe('Side Entrance');
  });

  test('no candidates means no landmark', () => {
    expect(pickLandmark(TURN, PREV, [], [], { radiusPx: 300, side: 'right' })).toBeNull();
  });
});

/* ============================================================================
   buildInstructions — the whole feed.
   ========================================================================= */

/** Every fixture floor is 10 px per metre, so 300 px reads as 30 m. */
const SCALE = 10;

const withPoi = (graph, nodeId, poi) => {
  const node = graph.nodes.get(nodeId);
  node.poi = poi;
  node.hasPoi = true;
  return graph;
};

/** a --300px--> b --400px--> c : one right-angle corner, 70 m of corridor. */
function lCorridorGraph() {
  return buildGraph({
    nodes: [
      { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE, type: 'ENTRANCE' },
      { id: 'b', x: 300, y: 0, floorNumber: 1 },
      { id: 'c', x: 300, y: 400, floorNumber: 1 },
    ],
    edges: [
      ['a', 'b'],
      ['b', 'c'],
    ],
  });
}

const buildFor = (graph, path, { routeOpts = {}, ...opts } = {}) => {
  const route = assembleRoute(graph, path, routeOpts);
  return { route, instructions: buildInstructions(route, graph, opts) };
};

describe('buildInstructions', () => {
  test('an L-shaped corridor is depart, right, arrive', () => {
    const graph = lCorridorGraph();
    const { route, instructions } = buildFor(graph, ['a', 'b', 'c']);

    expect(instructions.map((i) => i.kind)).toEqual(['depart', 'right', 'arrive']);
    expect(instructions.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(instructions.every((i) => i.segmentIndex === 0)).toBe(true);
    expect(instructions[1].atNodeId).toBe('b');
    expect(instructions[1].at).toEqual({ x: 300, y: 0 });
  });

  test('the instruction distances sum to the segment distance', () => {
    const graph = lCorridorGraph();
    const { route, instructions } = buildFor(graph, ['a', 'b', 'c']);

    expect(route.segments[0].distanceM).toBe(70);
    expect(instructions.map((i) => i.distanceM)).toEqual([30, 40, 0]);
    const summed = instructions.reduce((total, i) => total + i.distanceM, 0);
    expect(summed).toBeCloseTo(route.segments[0].distanceM, 5);
  });

  test('every instruction carries a non-empty en and ka text', () => {
    const graph = lCorridorGraph();
    const { instructions } = buildFor(graph, ['a', 'b', 'c']);

    for (const instruction of instructions) {
      expect(typeof instruction.text.en).toBe('string');
      expect(instruction.text.en.trim()).not.toBe('');
      expect(typeof instruction.text.ka).toBe('string');
      expect(instruction.text.ka.trim()).not.toBe('');
      // Georgian must actually be Georgian, not an English string copied over.
      expect(instruction.text.ka).toMatch(/[Ⴀ-ჿ]/);
    }
  });

  test('a heading phrases the first instruction against where the visitor is facing', () => {
    const graph = lCorridorGraph();
    const plain = buildFor(graph, ['a', 'b', 'c']).instructions[0];
    // The first leg runs due east (map bearing 90). Facing map-north, the
    // visitor has to turn right before taking a step.
    const facingNorth = buildFor(graph, ['a', 'b', 'c'], { heading: 0 }).instructions[0];

    expect(plain.kind).toBe('depart');
    expect(facingNorth.text.en).not.toBe(plain.text.en);
    expect(facingNorth.text.en).toMatch(/right/i);
    expect(facingNorth.text.ka).toMatch(/მარჯვნივ/);
  });

  // The stepper rotates the arrow from `kind` alone, so a `depart` above the
  // words "Turn right" points the visitor UP while telling them to turn.
  test('a heading that implies a turn makes the first instruction that turn', () => {
    const graph = lCorridorGraph();
    const facingNorth = buildFor(graph, ['a', 'b', 'c'], { heading: 0 }).instructions[0];

    expect(facingNorth.kind).toBe('right');
    expect(facingNorth.text.en).toMatch(/^Turn right/);
  });

  test('a heading that implies a u-turn makes the first instruction a uturn', () => {
    const graph = lCorridorGraph();
    // The first leg runs east; facing west means turning right around.
    const facingWest = buildFor(graph, ['a', 'b', 'c'], { heading: 270 }).instructions[0];

    expect(facingWest.kind).toBe('uturn');
    expect(facingWest.text.en).toMatch(/around/i);
  });

  test('a heading aligned with the first leg keeps the departure a depart', () => {
    const graph = lCorridorGraph();
    const facingEast = buildFor(graph, ['a', 'b', 'c'], { heading: 90 }).instructions[0];

    expect(facingEast.kind).toBe('depart');
  });

  test('a heading already pointing down the corridor leaves the departure plain', () => {
    const graph = lCorridorGraph();
    const plain = buildFor(graph, ['a', 'b', 'c']).instructions[0];
    const facingEast = buildFor(graph, ['a', 'b', 'c'], { heading: 90 }).instructions[0];

    expect(facingEast.text.en).toBe(plain.text.en);
  });

  test("the building's north offset rotates what a heading means", () => {
    const graph = lCorridorGraph();
    // The map is drawn 90° off true north, so a compass reading of 180°
    // points along map bearing 90 — straight down the first leg.
    const profile = resolveProfile({ northOffsetDeg: 90 }, 'walk');
    const first = buildFor(graph, ['a', 'b', 'c'], { heading: 180, profile }).instructions[0];

    expect(first.text.en).toBe(buildFor(graph, ['a', 'b', 'c']).instructions[0].text.en);
  });

  test('two decisions 2 m apart merge into one instruction', () => {
    // East, then two 45° rights 20 px (2 m) apart, ending due south.
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE },
        { id: 'b', x: 300, y: 0, floorNumber: 1 },
        { id: 'c', x: 314.14, y: 14.14, floorNumber: 1 },
        { id: 'd', x: 314.14, y: 214.14, floorNumber: 1 },
      ],
      edges: [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'd'],
      ],
    });

    const { instructions } = buildFor(graph, ['a', 'b', 'c', 'd']);

    // Not depart / slight_right / slight_right / arrive.
    expect(instructions.map((i) => i.kind)).toEqual(['depart', 'right', 'arrive']);
    expect(instructions[1].atNodeId).toBe('b');
  });

  test('a long straight leg is confirmed past a unique landmark', () => {
    const graph = withPoi(
      buildGraph({
        nodes: [
          { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE },
          { id: 'b', x: 1000, y: 0, floorNumber: 1 },
          { id: 'cafe', x: 500, y: 80, floorNumber: 1, type: 'POI' },
        ],
        edges: [['a', 'b']],
      }),
      'cafe',
      { id: 'poi-cafe', name: 'Coffee Bar', category: 'cafe' }
    );

    const { instructions } = buildFor(graph, ['a', 'b']);

    expect(instructions.map((i) => i.kind)).toEqual(['depart', 'straight', 'arrive']);
    expect(instructions[1].landmark).toMatchObject({
      poiId: 'poi-cafe',
      name: 'Coffee Bar',
      side: 'right',
    });
    expect(instructions.reduce((t, i) => t + i.distanceM, 0)).toBeCloseTo(100, 5);
  });

  test('a short straight leg gets no confirmation', () => {
    const graph = withPoi(
      buildGraph({
        nodes: [
          { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE },
          { id: 'b', x: 150, y: 0, floorNumber: 1 },
          { id: 'cafe', x: 75, y: 40, floorNumber: 1, type: 'POI' },
        ],
        edges: [['a', 'b']],
      }),
      'cafe',
      { id: 'poi-cafe', name: 'Coffee Bar', category: 'cafe' }
    );

    expect(buildFor(graph, ['a', 'b']).instructions.map((i) => i.kind)).toEqual([
      'depart',
      'arrive',
    ]);
  });

  test('a turn names the landmark on the side it turns towards', () => {
    const graph = withPoi(lCorridorGraph(), 'c', null);
    withPoi(graph, 'b', null);
    graph.nodes.set('shop', {
      id: 'shop',
      x: 340,
      y: 40,
      type: 'POI',
      label: 'Coffee Bar',
      floorId: 'floor-1',
      floorNumber: 1,
      level: 1,
      hasPoi: true,
      poi: { id: 'poi-shop', name: 'Coffee Bar', category: 'cafe' },
    });

    const { instructions } = buildFor(graph, ['a', 'b', 'c']);

    expect(instructions[1].kind).toBe('right');
    expect(instructions[1].landmark).toMatchObject({ poiId: 'poi-shop', side: 'right' });
    expect(instructions[1].text.en).toContain('Coffee Bar');
    expect(instructions[1].text.ka).toContain('Coffee Bar');
  });

  test('a floor change becomes a transit instruction the stepper can map', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE },
        { id: 's1', x: 300, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 's2', x: 300, y: 0, floorNumber: 2, scale: SCALE, type: 'TRANSIT' },
        { id: 'z', x: 300, y: 400, floorNumber: 2 },
      ],
      edges: [
        ['a', 's1'],
        ['s1', 's2', { transitType: 'STAIRS' }],
        ['s2', 'z'],
      ],
    });

    const { route, instructions } = buildFor(graph, ['a', 's1', 's2', 'z']);
    const transit = instructions.find((i) => i.kind === 'transit');

    expect(transit).toBeDefined();
    expect(transit.floorChange).toEqual({
      fromFloorNumber: 1,
      toFloorNumber: 2,
      transitType: 'STAIRS',
      direction: 'up',
    });
    // `useRouteProgress.buildFeed` falls back to matching this against
    // `transitions[].afterSegmentIndex`, so it must be the segment being left.
    expect(transit.segmentIndex).toBe(route.transitions[0].afterSegmentIndex);
    expect(transit.text.en).toMatch(/stairs/i);

    // Every walk segment owns at least one instruction, or the stepper's feed
    // would skip that step entirely.
    for (let index = 0; index < route.segments.length; index += 1) {
      expect(
        instructions.some((i) => i.kind !== 'transit' && i.segmentIndex === index)
      ).toBe(true);
    }
  });

  // A cross-floor WALKWAY is a legacy row that really exists in production
  // data (see the comment in `costModel.js` on pricing one) — and nothing
  // keeps it off a WHEELCHAIR route, because blocking is by transit type.
  // Calling it "the stairs" would contradict the step-free promise the very
  // same response advertises.
  test('a cross-floor WALKWAY is never spoken as stairs', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE },
        { id: 'w1', x: 300, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 'w2', x: 300, y: 0, floorNumber: 2, scale: SCALE, type: 'TRANSIT' },
        { id: 'z', x: 600, y: 0, floorNumber: 2 },
      ],
      edges: [
        ['a', 'w1'],
        ['w1', 'w2', { transitType: 'WALKWAY' }],
        ['w2', 'z'],
      ],
    });

    const { route, instructions } = buildFor(graph, ['a', 'w1', 'w2', 'z']);
    expect(route.transitions[0].transitType).toBe('WALKWAY');

    const transit = instructions.find((i) => i.kind === 'transit');
    expect(transit.text.en).toMatch(/walkway/i);
    expect(transit.text.en).not.toMatch(/stair/i);
    expect(transit.text.ka).not.toContain('კიბ');
    expect(transit.text.ka).toMatch(/[\u10A0-\u10FF]/);
  });

  test('an unknown transit type falls back to neutral wording, not stairs', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE },
        { id: 't1', x: 300, y: 0, floorNumber: 1, type: 'TRANSIT' },
        { id: 't2', x: 300, y: 0, floorNumber: 2, scale: SCALE, type: 'TRANSIT' },
      ],
      edges: [
        ['a', 't1'],
        ['t1', 't2', { transitType: 'TRAVELATOR' }],
      ],
    });

    const transit = buildFor(graph, ['a', 't1', 't2']).instructions.find(
      (i) => i.kind === 'transit'
    );
    expect(transit.text.en).not.toMatch(/stair/i);
    expect(transit.text.ka).not.toContain('კიბ');
  });

  // Two floor records at the same vertical order — a split level, or a bridge
  // into the neighbouring block. `direction` is 'same', and "up to floor 2"
  // would be a straight lie.
  test('a same-level crossing is not spoken as going up', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE, verticalOrder: 5 },
        { id: 'b1', x: 300, y: 0, floorNumber: 1, type: 'TRANSIT', verticalOrder: 5 },
        { id: 'b2', x: 300, y: 0, floorNumber: 2, scale: SCALE, type: 'TRANSIT', verticalOrder: 5 },
        { id: 'z', x: 600, y: 0, floorNumber: 2, verticalOrder: 5 },
      ],
      edges: [
        ['a', 'b1'],
        ['b1', 'b2', { transitType: 'WALKWAY' }],
        ['b2', 'z'],
      ],
    });

    const { route, instructions } = buildFor(graph, ['a', 'b1', 'b2', 'z']);
    expect(route.transitions[0].direction).toBe('same');

    const transit = instructions.find((i) => i.kind === 'transit');
    expect(transit.floorChange.direction).toBe('same');
    expect(transit.text.en).not.toMatch(/\bup\b/i);
    expect(transit.text.en).not.toMatch(/\bdown\b/i);
    expect(transit.text.en).toMatch(/across/i);
    expect(transit.text.ka.trim()).not.toBe('');
    expect(transit.text.ka).toMatch(/[\u10A0-\u10FF]/);
  });

  test('the arrival names the destination and the side it is on', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE },
        { id: 'b', x: 300, y: 0, floorNumber: 1 },
        { id: 'shop', x: 300, y: -100, floorNumber: 1, type: 'POI' },
      ],
      edges: [['a', 'b']],
    });
    withPoi(graph, 'shop', { id: 'poi-shop', name: 'LC Waikiki', category: 'Apparel' });

    const { instructions } = buildFor(graph, ['a', 'b'], {
      routeOpts: {
        destinationPoi: { id: 'poi-shop', name: 'LC Waikiki', category: 'Apparel' },
      },
    });

    const arrive = instructions.at(-1);
    expect(arrive.kind).toBe('arrive');
    expect(arrive.landmark).toMatchObject({ poiId: 'poi-shop', side: 'left' });
    expect(arrive.text.en).toContain('LC Waikiki');
  });

  test('the last turn is not anchored on the destination itself', () => {
    // "Turn right at Shop B" followed immediately by "You have arrived at
    // Shop B" tells the visitor to steer by the thing they are steering to.
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE },
        { id: 'b', x: 300, y: 0, floorNumber: 1 },
        { id: 'shopb', x: 300, y: 60, floorNumber: 1, type: 'POI' },
      ],
      edges: [
        ['a', 'b'],
        ['b', 'shopb'],
      ],
    });
    const destinationPoi = { id: 'poi-shopb', name: 'Shop B', category: 'shop' };
    withPoi(graph, 'shopb', destinationPoi);

    const { instructions } = buildFor(graph, ['a', 'b', 'shopb'], {
      routeOpts: { destinationPoi },
    });

    const turn = instructions.find((i) => i.kind === 'right');
    expect(turn).toBeDefined();
    expect(turn.landmark).toBeUndefined();
    expect(turn.text.en).not.toContain('Shop B');
  });

  test('a turn beside the destination steers by a different landmark instead', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'a', x: 0, y: 0, floorNumber: 1, scale: SCALE },
        { id: 'b', x: 300, y: 0, floorNumber: 1 },
        { id: 'shopb', x: 300, y: 60, floorNumber: 1, type: 'POI' },
        // Further from the turn than the destination is, so it can only win
        // because the destination is excluded — not on distance.
        { id: 'cafe', x: 300, y: 90, floorNumber: 1, type: 'POI' },
      ],
      edges: [
        ['a', 'b'],
        ['b', 'shopb'],
      ],
    });
    const destinationPoi = { id: 'poi-shopb', name: 'Shop B', category: 'shop' };
    withPoi(graph, 'shopb', destinationPoi);
    withPoi(graph, 'cafe', { id: 'poi-cafe', name: 'Coffee Bar', category: 'cafe' });

    const { instructions } = buildFor(graph, ['a', 'b', 'shopb'], {
      routeOpts: { destinationPoi },
    });

    const turn = instructions.find((i) => i.kind === 'right');
    expect(turn.landmark).toMatchObject({ poiId: 'poi-cafe', name: 'Coffee Bar' });
  });

  test('a route with one node yields a single arrive instruction', () => {
    const graph = lCorridorGraph();
    const { instructions } = buildFor(graph, ['a']);
    expect(instructions.map((i) => i.kind)).toEqual(['arrive']);
  });
});
