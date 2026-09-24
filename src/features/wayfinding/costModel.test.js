import {
  DEFAULT_ROUTING_PROFILE,
  PROFILE_NAMES,
  validateRoutingProfile,
  resolveProfile,
  edgeDurationSec,
  makeCostFn,
  floorDelta,
} from './costModel.js';

const nodeOn = (level, floorId = `f${level}`) => ({
  id: `n-${floorId}`,
  floorId,
  floorNumber: level,
  level,
});

describe('costModel', () => {
  test('a walkway edge costs its real length divided by the walking speed', () => {
    const profile = resolveProfile(null, 'walk');
    const from = nodeOn(1, 'f1');
    const to = { ...nodeOn(1, 'f1'), id: 'n-f1-b' };
    const edge = { transitType: 'WALKWAY', lengthM: 14, rank: 'PRIMARY' };

    expect(profile.walkSpeedMps).toBe(DEFAULT_ROUTING_PROFILE.walkSpeedMps);
    expect(edgeDurationSec(edge, from, to, profile)).toBeCloseTo(10, 6);
  });

  test('an elevator costs its wait plus per-floor time times the verticalOrder delta', () => {
    const profile = resolveProfile(null, 'walk');
    const from = nodeOn(0, 'ground');
    const to = nodeOn(3, 'third');
    const edge = { transitType: 'ELEVATOR', lengthM: null, rank: 'PRIMARY' };

    expect(floorDelta(from, to)).toBe(3);
    // 30 s wait + 3 floors x 5 s
    expect(edgeDurationSec(edge, from, to, profile)).toBeCloseTo(45, 6);
  });

  test('the emergency profile makes elevators Infinity unless they are evacuation rated', () => {
    const from = nodeOn(0, 'ground');
    const to = nodeOn(1, 'first');
    const edge = { transitType: 'ELEVATOR', lengthM: null, rank: 'PRIMARY' };

    const unrated = resolveProfile(null, 'emergency');
    expect(unrated.blockedTransit).toEqual(['ELEVATOR']);
    expect(edgeDurationSec(edge, from, to, unrated)).toBe(Infinity);

    const rated = resolveProfile({ elevatorEvacuationRated: true }, 'emergency');
    expect(rated.blockedTransit).toEqual([]);
    expect(edgeDurationSec(edge, from, to, rated)).toBeCloseTo(35, 6);

    // Stairs stay walkable in an emergency.
    expect(
      edgeDurationSec({ transitType: 'STAIRS', rank: 'PRIMARY' }, from, to, unrated)
    ).toBeCloseTo(16, 6);
  });

  test('building overrides win over defaults and unknown keys are rejected', () => {
    const from = nodeOn(1, 'f1');
    const to = { ...nodeOn(1, 'f1'), id: 'n-f1-b' };
    const edge = { transitType: 'WALKWAY', lengthM: 14, rank: 'PRIMARY' };

    const overridden = resolveProfile({ walkSpeedMps: 0.7 }, 'walk');
    expect(overridden.walkSpeedMps).toBe(0.7);
    expect(edgeDurationSec(edge, from, to, overridden)).toBeCloseTo(20, 6);

    expect(validateRoutingProfile({ walkSpeedMps: 0.7 })).toEqual({
      ok: true,
      errors: [],
      value: { walkSpeedMps: 0.7 },
    });

    const rejected = validateRoutingProfile({ walkSpeedMps: 0.7, turboMode: true });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.join(' ')).toContain('turboMode');
    expect(rejected.value).toEqual({ walkSpeedMps: 0.7 });

    // An unknown key stored on the building is ignored, not applied.
    const resolved = resolveProfile({ turboMode: true }, 'walk');
    expect(resolved.turboMode).toBeUndefined();
    expect(resolved.walkSpeedMps).toBe(DEFAULT_ROUTING_PROFILE.walkSpeedMps);

    expect(validateRoutingProfile({ walkSpeedMps: 0 }).ok).toBe(false);
    expect(validateRoutingProfile({ elevatorEvacuationRated: 'yes' }).ok).toBe(false);
    expect(validateRoutingProfile(null)).toEqual({ ok: true, errors: [], value: {} });
    expect(validateRoutingProfile([1, 2]).ok).toBe(false);
  });

  test('makeCostFn charges secondary-rank edges the rank multiplier', () => {
    const profile = resolveProfile(null, 'walk');
    const costFn = makeCostFn(profile);
    const from = nodeOn(1, 'f1');
    const to = { ...nodeOn(1, 'f1'), id: 'n-f1-b' };

    expect(costFn({ transitType: 'WALKWAY', lengthM: 14, rank: 'PRIMARY' }, from, to))
      .toBeCloseTo(10, 6);
    expect(costFn({ transitType: 'WALKWAY', lengthM: 14, rank: 'SECONDARY' }, from, to))
      .toBeCloseTo(15, 6);
    // 30 s wait + 1 floor x 5 s = 35 s, x1.5 for SECONDARY.
    expect(
      costFn({ transitType: 'ELEVATOR', rank: 'SECONDARY' }, nodeOn(1, 'f1'), nodeOn(2, 'f2'))
    ).toBeCloseTo(52.5, 6);
  });

  test('named profiles carry their modifiers', () => {
    expect(PROFILE_NAMES).toEqual([
      'walk',
      'wheelchair',
      'elevator_first',
      'min_floor_changes',
      'emergency',
    ]);
    expect(resolveProfile(null, 'wheelchair').requireAccessible).toBe(true);
    expect(resolveProfile(null, 'elevator_first').transitMultiplier).toEqual({
      STAIRS: 3,
      ESCALATOR: 2,
    });
    expect(resolveProfile(null, 'min_floor_changes').floorChangePenaltySec).toBe(600);
    expect(resolveProfile(null, 'walk').name).toBe('walk');
    expect(resolveProfile(null, 'nonsense').name).toBe('walk');

    // elevator_first triples stairs: 8 m / 0.5 m/s = 16 s -> 48 s.
    const from = nodeOn(0, 'ground');
    const to = nodeOn(1, 'first');
    expect(
      edgeDurationSec(
        { transitType: 'STAIRS', rank: 'PRIMARY' },
        from,
        to,
        resolveProfile(null, 'elevator_first')
      )
    ).toBeCloseTo(48, 6);

    // min_floor_changes adds its penalty to any cross-floor edge.
    expect(
      edgeDurationSec(
        { transitType: 'STAIRS', rank: 'PRIMARY' },
        from,
        to,
        resolveProfile(null, 'min_floor_changes')
      )
    ).toBeCloseTo(616, 6);

    // ...but not to a same-floor walkway.
    expect(
      edgeDurationSec(
        { transitType: 'WALKWAY', lengthM: 14, rank: 'PRIMARY' },
        from,
        { ...from, id: 'other' },
        resolveProfile(null, 'min_floor_changes')
      )
    ).toBeCloseTo(10, 6);
  });

  test('an escalator charges an entry cost on top of its run', () => {
    const profile = resolveProfile(null, 'walk');
    // 3 s entry + 8 m / 0.5 m/s = 19 s
    expect(
      edgeDurationSec(
        { transitType: 'ESCALATOR', rank: 'PRIMARY' },
        nodeOn(0, 'ground'),
        nodeOn(1, 'first'),
        profile
      )
    ).toBeCloseTo(19, 6);
  });

  test('floorDelta never drops below one floor', () => {
    const a = nodeOn(2, 'f2');
    expect(floorDelta(a, { ...a, id: 'b' })).toBe(1);
    expect(floorDelta(nodeOn(-1, 'b1'), nodeOn(2, 'f2'))).toBe(3);
  });
});
