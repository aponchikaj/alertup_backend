import {
  publish,
  subscribe,
  subscriberCount,
  atCapacity,
  registerCloser,
  closeAll,
  MAX_SUBSCRIBERS_PER_BUILDING,
} from './broadcaster.js';

afterEach(() => {
  closeAll();
});

describe('broadcaster', () => {
  test('delivers events only to the matching building channel', () => {
    const gotA = [];
    const gotB = [];
    subscribe('bldA', (msg) => gotA.push(msg));
    subscribe('bldB', (msg) => gotB.push(msg));

    publish('bldA', 'emergency_started', { emergencyId: 'e1' });

    expect(gotA).toEqual([
      { event: 'emergency_started', data: { emergencyId: 'e1' } },
    ]);
    expect(gotB).toEqual([]);
  });

  test('unsubscribe stops delivery and is idempotent', () => {
    const got = [];
    const unsub = subscribe('bld', (msg) => got.push(msg));
    publish('bld', 'x', {});
    unsub();
    unsub();
    publish('bld', 'y', {});
    expect(got).toHaveLength(1);
    expect(subscriberCount('bld')).toBe(0);
  });

  test('tracks per-building and total counts for capacity checks', () => {
    const unsubs = [];
    for (let i = 0; i < 5; i++) unsubs.push(subscribe('bld', () => {}));
    expect(subscriberCount('bld')).toBe(5);
    expect(subscriberCount()).toBe(5);
    expect(atCapacity('bld')).toBe(false);
    unsubs.forEach((u) => u());
    expect(subscriberCount('bld')).toBe(0);
  });

  test('closeAll runs registered closers and resets state', () => {
    let closed = 0;
    subscribe('bld', () => {});
    registerCloser(() => {
      closed += 1;
    });
    closeAll();
    expect(closed).toBe(1);
    expect(subscriberCount()).toBe(0);
  });

  test('capacity constant is sane', () => {
    expect(MAX_SUBSCRIBERS_PER_BUILDING).toBeGreaterThan(0);
  });
});
