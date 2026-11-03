import {
  parseRoutingQuery,
  buildRoutingContext,
  visibilityAllowed,
  composeFilters,
} from './profiles.js';
import { buildGraph } from '../../tests/graphFixtures.js';

describe('parseRoutingQuery', () => {
  test('accessible=true aliases profile=wheelchair', () => {
    const result = parseRoutingQuery({ accessible: 'true' });
    expect(result.ok).toBe(true);
    expect(result.name).toBe('wheelchair');
  });

  test('accessible=true overrides an explicit profile', () => {
    const result = parseRoutingQuery({ profile: 'elevator_first', accessible: 'true' });
    expect(result.name).toBe('wheelchair');
  });

  test('unknown profile name is rejected with 400', () => {
    const result = parseRoutingQuery({ profile: 'ludicrous_speed' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/ludicrous_speed/);
  });

  test('defaults to the walk profile when nothing is asked for', () => {
    expect(parseRoutingQuery({}).name).toBe('walk');
    expect(parseRoutingQuery().name).toBe('walk');
  });

  test('includeTags/excludeTags accept comma-separated or repeated params', () => {
    expect(parseRoutingQuery({ includeTags: 'quiet,covered' }).includeTags).toEqual([
      'quiet',
      'covered',
    ]);
    expect(parseRoutingQuery({ excludeTags: ['stairs', 'noisy,loud'] }).excludeTags).toEqual([
      'stairs',
      'noisy',
      'loud',
    ]);
    expect(parseRoutingQuery({}).includeTags).toEqual([]);
    expect(parseRoutingQuery({}).excludeTags).toEqual([]);
  });

  test('heading parses to an integer 0-359 or null', () => {
    expect(parseRoutingQuery({ heading: '45' }).heading).toBe(45);
    expect(parseRoutingQuery({ heading: '45.9' }).heading).toBe(45);
    expect(parseRoutingQuery({ heading: '400' }).heading).toBeNull();
    expect(parseRoutingQuery({ heading: '-5' }).heading).toBeNull();
    expect(parseRoutingQuery({ heading: 'north' }).heading).toBeNull();
    expect(parseRoutingQuery({}).heading).toBeNull();
  });

  test('src is whitelisted to sticker|kiosk|web|scan|ai and defaults to web', () => {
    expect(parseRoutingQuery({ src: 'kiosk' }).src).toBe('kiosk');
    expect(parseRoutingQuery({ src: 'sticker' }).src).toBe('sticker');
    expect(parseRoutingQuery({ src: 'bogus' }).src).toBe('web');
    expect(parseRoutingQuery({}).src).toBe('web');
  });
});

describe('visibilityAllowed', () => {
  test('PUBLIC is always allowed', () => {
    expect(visibilityAllowed('PUBLIC', { name: 'walk', audience: 'public' })).toBe(true);
    expect(visibilityAllowed('PUBLIC', { name: 'emergency', audience: 'staff' })).toBe(true);
    expect(visibilityAllowed(null, { name: 'walk', audience: 'public' })).toBe(true);
  });

  test('EMERGENCY_ONLY is allowed only for the emergency profile', () => {
    expect(visibilityAllowed('EMERGENCY_ONLY', { name: 'walk', audience: 'staff' })).toBe(false);
    expect(visibilityAllowed('EMERGENCY_ONLY', { name: 'emergency', audience: 'public' })).toBe(
      true
    );
  });

  test('STAFF is allowed only for the staff audience', () => {
    expect(visibilityAllowed('STAFF', { name: 'walk', audience: 'public' })).toBe(false);
    expect(visibilityAllowed('STAFF', { name: 'walk', audience: 'staff' })).toBe(true);
    expect(visibilityAllowed('STAFF', { name: 'emergency', audience: 'public' })).toBe(false);
  });
});

describe('composeFilters', () => {
  test('returns null when every filter is absent (no filtering)', () => {
    expect(composeFilters(null, undefined)).toBeNull();
    expect(composeFilters()).toBeNull();
  });

  test('ANDs the supplied filters, skipping null/undefined ones', () => {
    const evenOnly = (edge) => edge.n % 2 === 0;
    const under10 = (edge) => edge.n < 10;
    const combined = composeFilters(evenOnly, null, under10);

    expect(combined({ n: 4 })).toBe(true);
    expect(combined({ n: 5 })).toBe(false);
    expect(combined({ n: 12 })).toBe(false);
  });
});

describe('buildRoutingContext', () => {
  test('unknown profile name is rejected with 400', () => {
    const graph = buildGraph({ nodes: [{ id: 'a' }], edges: [] });
    const ctx = buildRoutingContext(graph, { name: 'not-a-profile' });
    expect(ctx.ok).toBe(false);
    expect(ctx.status).toBe(400);
    expect(ctx.error).toMatch(/not-a-profile/);
  });

  test('a public walk profile refuses an EMERGENCY_ONLY edge; the emergency profile includes it', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'exit', x: 100, y: 0, type: 'EMERGENCY_EXIT' },
      ],
      edges: [['start', 'exit', { visibility: 'EMERGENCY_ONLY' }]],
    });
    const edge = graph.adj.get('start')[0];
    const from = graph.nodes.get('start');
    const to = graph.nodes.get('exit');

    const walkCtx = buildRoutingContext(graph, { name: 'walk' });
    expect(walkCtx.ok).toBe(true);
    expect(walkCtx.strictEdgeFilter(edge, from, to)).toBe(false);

    const emergencyCtx = buildRoutingContext(graph, { name: 'emergency' });
    expect(emergencyCtx.strictEdgeFilter(edge, from, to)).toBe(true);
  });

  test('target node visibility (graph.nodes.get(edge.to)) is enforced even when the edge is PUBLIC', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'staffRoom', x: 100, y: 0, visibility: 'STAFF' },
      ],
      edges: [['start', 'staffRoom']],
    });
    const edge = graph.adj.get('start')[0];
    const from = graph.nodes.get('start');
    const to = graph.nodes.get('staffRoom');

    const publicCtx = buildRoutingContext(graph, { name: 'walk', audience: 'public' });
    expect(publicCtx.strictEdgeFilter(edge, from, to)).toBe(false);

    const staffCtx = buildRoutingContext(graph, { name: 'walk', audience: 'staff' });
    expect(staffCtx.strictEdgeFilter(edge, from, to)).toBe(true);
  });

  test('excludeTags blocks the only route under strict; the tagConstraintsRelaxed fallback allows it, in fallback order', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'goal', x: 100, y: 0, type: 'POI' },
      ],
      edges: [['start', 'goal', { tags: ['service'] }]],
    });
    const edge = graph.adj.get('start')[0];
    const from = graph.nodes.get('start');
    const to = graph.nodes.get('goal');

    const ctx = buildRoutingContext(graph, { name: 'walk', excludeTags: ['service'] });
    expect(ctx.strictEdgeFilter(edge, from, to)).toBe(false);
    expect(ctx.fallbacks.map((f) => f.label)).toEqual(['tagConstraintsRelaxed']);
    expect(ctx.fallbacks[0].edgeFilter(edge, from, to)).toBe(true);
  });

  test('fallback chain order is strict -> tagConstraintsRelaxed -> accessibleRouteUnavailable', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'goal', x: 100, y: 0, type: 'POI' },
      ],
      edges: [['start', 'goal', { tags: ['service'], accessible: false }]],
    });
    const edge = graph.adj.get('start')[0];
    const from = graph.nodes.get('start');
    const to = graph.nodes.get('goal');

    const ctx = buildRoutingContext(graph, {
      name: 'wheelchair',
      excludeTags: ['service'],
    });

    expect(ctx.strictEdgeFilter(edge, from, to)).toBe(false);
    expect(ctx.fallbacks.map((f) => f.label)).toEqual([
      'tagConstraintsRelaxed',
      'accessibleRouteUnavailable',
    ]);
    // tags relaxed but accessibility still enforced -> still refused
    expect(ctx.fallbacks[0].edgeFilter(edge, from, to)).toBe(false);
    // accessibility relaxed too -> allowed
    expect(ctx.fallbacks[1].edgeFilter(edge, from, to)).toBe(true);
  });

  test('visibility is never relaxed, even in the final fallback', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'goal', x: 100, y: 0, type: 'POI' },
      ],
      edges: [
        ['start', 'goal', { visibility: 'STAFF', accessible: false, tags: ['service'] }],
      ],
    });
    const edge = graph.adj.get('start')[0];
    const from = graph.nodes.get('start');
    const to = graph.nodes.get('goal');

    const ctx = buildRoutingContext(graph, {
      name: 'wheelchair',
      excludeTags: ['service'],
      audience: 'public',
    });

    expect(ctx.strictEdgeFilter(edge, from, to)).toBe(false);
    expect(ctx.fallbacks.length).toBeGreaterThan(0);
    for (const fallback of ctx.fallbacks) {
      expect(fallback.edgeFilter(edge, from, to)).toBe(false);
    }
  });

  test('overlay edgeMultiplier is folded into costFn and every fallback costFn', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'goal', x: 100, y: 0, type: 'POI' },
      ],
      edges: [['start', 'goal', { edgeId: 'e1', tags: ['service'] }]],
    });
    const edge = graph.adj.get('start')[0];
    const from = graph.nodes.get('start');
    const to = graph.nodes.get('goal');

    const baseCtx = buildRoutingContext(graph, { name: 'walk', excludeTags: ['service'] });
    const overlay = {
      edgeMultiplier: new Map([['e1', 5]]),
      blockedEdgeIds: new Set(),
      blockedNodeIds: new Set(),
    };
    const overlaidCtx = buildRoutingContext(graph, {
      name: 'walk',
      excludeTags: ['service'],
      overlay,
    });

    expect(overlaidCtx.costFn(edge, from, to)).toBeCloseTo(
      baseCtx.costFn(edge, from, to) * 5,
      6
    );
    expect(overlaidCtx.fallbacks[0].costFn(edge, from, to)).toBeCloseTo(
      overlaidCtx.costFn(edge, from, to),
      6
    );
  });

  test('overlay blockedEdgeIds blocks strict and every fallback edgeFilter', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'goal', x: 100, y: 0, type: 'POI' },
      ],
      edges: [['start', 'goal', { edgeId: 'e1', tags: ['service'] }]],
    });
    const edge = graph.adj.get('start')[0];
    const from = graph.nodes.get('start');
    const to = graph.nodes.get('goal');

    const overlay = {
      edgeMultiplier: new Map(),
      blockedEdgeIds: new Set(['e1']),
      blockedNodeIds: new Set(),
    };
    const ctx = buildRoutingContext(graph, {
      name: 'walk',
      excludeTags: ['service'],
      overlay,
    });

    expect(ctx.strictEdgeFilter(edge, from, to)).toBe(false);
    expect(ctx.fallbacks.length).toBeGreaterThan(0);
    for (const fallback of ctx.fallbacks) {
      expect(fallback.edgeFilter(edge, from, to)).toBe(false);
    }
  });

  test('overlay blockedNodeIds blocks edges reaching that node', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'mid', x: 50, y: 0 },
        { id: 'goal', x: 100, y: 0, type: 'POI' },
      ],
      edges: [
        ['start', 'mid'],
        ['mid', 'goal'],
      ],
    });
    const edge = graph.adj.get('start')[0];
    const from = graph.nodes.get('start');
    const to = graph.nodes.get('mid');

    const overlay = {
      edgeMultiplier: new Map(),
      blockedEdgeIds: new Set(),
      blockedNodeIds: new Set(['mid']),
    };
    const ctx = buildRoutingContext(graph, { name: 'walk', overlay });
    expect(ctx.strictEdgeFilter(edge, from, to)).toBe(false);
  });

  test('a null overlay behaves exactly like no overlay', () => {
    const graph = buildGraph({
      nodes: [
        { id: 'start', x: 0, y: 0 },
        { id: 'goal', x: 100, y: 0, type: 'POI' },
      ],
      edges: [['start', 'goal']],
    });
    const edge = graph.adj.get('start')[0];
    const from = graph.nodes.get('start');
    const to = graph.nodes.get('goal');

    const ctx = buildRoutingContext(graph, { name: 'walk', overlay: null });
    expect(ctx.strictEdgeFilter(edge, from, to)).toBe(true);
    expect(Number.isFinite(ctx.costFn(edge, from, to))).toBe(true);
  });
});
