import {
  planAutoConnect,
  segmentsIntersect,
  wallSegments,
} from './autoConnect.js';

/* The auto-connector's promises: the floor ends up ONE component, existing
   work is respected, and no connection ever crosses a drawn wall. */

const n = (id, x, y) => ({ id, x, y });

describe('segmentsIntersect', () => {
  test('crossing segments intersect; parallel ones do not', () => {
    expect(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 0, 5, 10, 5)).toBe(false);
  });

  test('segments that merely touch at an endpoint do not count', () => {
    expect(segmentsIntersect(0, 0, 10, 0, 10, 0, 20, 0)).toBe(false);
  });
});

describe('planAutoConnect', () => {
  test('connects a scattered floor into one component', () => {
    const nodes = [n('a', 0, 0), n('b', 100, 0), n('c', 200, 0), n('d', 50, 300)];
    const planned = planAutoConnect(nodes, [], null);

    // Union-find over the plan: everything reachable from 'a'.
    const adj = new Map(nodes.map((x) => [x.id, []]));
    for (const [p, q] of planned) {
      adj.get(p).push(q);
      adj.get(q).push(p);
    }
    const seen = new Set(['a']);
    const stack = ['a'];
    while (stack.length) {
      for (const next of adj.get(stack.pop())) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    expect(seen.size).toBe(nodes.length);
  });

  test('never duplicates existing connections and builds on them', () => {
    const nodes = [n('a', 0, 0), n('b', 100, 0), n('c', 200, 0)];
    const existing = [{ sourceNodeId: 'a', targetNodeId: 'b' }];
    const planned = planAutoConnect(nodes, existing, null);
    // a-b exists; only c needs joining.
    expect(planned).toContainEqual(['b', 'c']);
    expect(planned).not.toContainEqual(['a', 'b']);
    expect(planned).not.toContainEqual(['b', 'a']);
  });

  test('a drawn wall blocks connections across it — even for connectivity', () => {
    // Two nodes with a vertical wall between them: the truthful result is
    // two components, not a route through concrete.
    const nodes = [n('a', 0, 50), n('b', 200, 50)];
    const drawing = {
      shapes: [{ kind: 'wall', points: [100, 0, 100, 100], thickness: 6 }],
    };
    expect(planAutoConnect(nodes, [], drawing)).toEqual([]);
  });

  test('routes around walls when a clear pair exists', () => {
    // a-b blocked by a wall, but both can reach c below the wall's end.
    const nodes = [n('a', 0, 50), n('b', 200, 50), n('c', 100, 400)];
    const drawing = {
      shapes: [{ kind: 'wall', points: [100, 0, 100, 100], thickness: 6 }],
    };
    const planned = planAutoConnect(nodes, [], drawing);
    const key = (p, q) => [p, q].sort().join(':');
    const keys = planned.map(([p, q]) => key(p, q));
    expect(keys).toContain('a:c');
    expect(keys).toContain('b:c');
    expect(keys).not.toContain('a:b');
  });

  test('shortcut pass adds nearby cross-links but respects the distance cap', () => {
    // A tight square: MST gives 3 edges; shortcuts close the square.
    const nodes = [n('a', 0, 0), n('b', 100, 0), n('c', 100, 100), n('d', 0, 100)];
    const planned = planAutoConnect(nodes, [], null);
    expect(planned.length).toBeGreaterThanOrEqual(4);

    // Distant node: connected by MST (one long edge), but never showered
    // with shortcuts beyond the cap.
    const far = planAutoConnect([n('a', 0, 0), n('b', 5000, 0)], [], null);
    expect(far).toEqual([['a', 'b']]);
  });

  test('wallSegments flattens multi-point runs into segment pairs', () => {
    const drawing = {
      shapes: [{ kind: 'wall', points: [0, 0, 10, 0, 10, 10], thickness: 4 }],
    };
    expect(wallSegments(drawing)).toEqual([
      [0, 0, 10, 0],
      [10, 0, 10, 10],
    ]);
  });
});
