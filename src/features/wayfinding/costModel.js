/**
 * Pure routing cost model.
 *
 * Pixel weights (`edge.cost`) answer "how far on the canvas"; they cannot
 * answer "how long will this take", because a flight of stairs and a 400 px
 * corridor are the same number today. This module turns an edge plus the two
 * nodes it joins into seconds, using per-building tuning (`Building.routingProfile`)
 * layered under a named profile (walk, wheelchair, elevator_first, …).
 *
 * No I/O, no Prisma: every input is passed in, so the whole model is unit
 * testable and safe to call inside the Dijkstra inner loop.
 */

/** Tuning knobs a building may override. Anything not listed here is rejected. */
export const DEFAULT_ROUTING_PROFILE = Object.freeze({
  walkSpeedMps: 1.4,
  stairsSpeedMps: 0.5,
  escalatorSpeedMps: 0.5,
  stairsRunMPerFloor: 8,
  escalatorRunMPerFloor: 8,
  escalatorEntrySec: 3,
  elevatorWaitSec: 30,
  elevatorPerFloorSec: 5,
  elevatorEvacuationRated: false,
  secondaryRankMultiplier: 1.5,
  northOffsetDeg: 0,
});

/** Named profiles a request may ask for; the first is the default. */
export const PROFILE_NAMES = Object.freeze([
  'walk',
  'wheelchair',
  'elevator_first',
  'min_floor_changes',
  'emergency',
]);

const DEFAULT_PROFILE_NAME = PROFILE_NAMES[0];

// Keys that must be strictly positive — a zero speed is a division by zero and
// a zero run length silently makes stairs free.
const POSITIVE_KEYS = new Set([
  'walkSpeedMps',
  'stairsSpeedMps',
  'escalatorSpeedMps',
  'stairsRunMPerFloor',
  'escalatorRunMPerFloor',
  'secondaryRankMultiplier',
]);

/**
 * Validate a building's stored `routingProfile` JSON.
 *
 * @param {unknown} json
 * @returns {{ok: boolean, errors: string[], value: object}} `value` holds only
 *   the keys that passed, so a caller that tolerates partial input (the graph
 *   loader) can apply them while a caller that does not (the PUT route) can
 *   reject on `ok === false`.
 */
export function validateRoutingProfile(json) {
  const errors = [];
  const value = {};

  if (json === null || json === undefined) return { ok: true, errors, value };
  if (typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, errors: ['routingProfile must be an object.'], value };
  }

  for (const [key, raw] of Object.entries(json)) {
    if (!Object.hasOwn(DEFAULT_ROUTING_PROFILE, key)) {
      errors.push(`Unknown routing profile key "${key}".`);
      continue;
    }
    if (typeof DEFAULT_ROUTING_PROFILE[key] === 'boolean') {
      if (typeof raw !== 'boolean') {
        errors.push(`"${key}" must be a boolean.`);
        continue;
      }
      value[key] = raw;
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      errors.push(`"${key}" must be a finite number.`);
      continue;
    }
    if (POSITIVE_KEYS.has(key) ? raw <= 0 : raw < 0) {
      errors.push(
        POSITIVE_KEYS.has(key)
          ? `"${key}" must be greater than 0.`
          : `"${key}" cannot be negative.`
      );
      continue;
    }
    value[key] = raw;
  }

  return { ok: errors.length === 0, errors, value };
}

/**
 * Layer a named profile over a building's overrides over the defaults.
 *
 * @param {object|null} buildingJson `Building.routingProfile`
 * @param {string} name one of PROFILE_NAMES; anything else falls back to 'walk'
 * @returns {object} the resolved profile: every DEFAULT_ROUTING_PROFILE key
 *   plus `name`, `requireAccessible`, `transitMultiplier`, `blockedTransit`
 *   and `floorChangePenaltySec`.
 */
export function resolveProfile(buildingJson, name = DEFAULT_PROFILE_NAME) {
  const { value: overrides } = validateRoutingProfile(buildingJson);
  const profileName = PROFILE_NAMES.includes(name) ? name : DEFAULT_PROFILE_NAME;

  const profile = {
    ...DEFAULT_ROUTING_PROFILE,
    ...overrides,
    name: profileName,
    requireAccessible: false,
    transitMultiplier: {},
    blockedTransit: [],
    floorChangePenaltySec: 0,
  };

  switch (profileName) {
    case 'wheelchair':
      profile.requireAccessible = true;
      break;
    case 'elevator_first':
      profile.transitMultiplier = { STAIRS: 3, ESCALATOR: 2 };
      break;
    case 'min_floor_changes':
      profile.floorChangePenaltySec = 600;
      break;
    case 'emergency':
      // Lifts are off-limits in a fire unless the building says its cars are
      // evacuation rated.
      profile.blockedTransit = profile.elevatorEvacuationRated ? [] : ['ELEVATOR'];
      break;
    default:
      break;
  }

  return profile;
}

const levelOf = (node) => node?.level ?? node?.floorNumber ?? 0;

/**
 * Floors spanned by a transit edge — at least one, because a stair flight that
 * reports the same level on both ends still costs a flight to climb.
 */
export function floorDelta(from, to) {
  return Math.max(1, Math.abs(levelOf(from) - levelOf(to)));
}

/**
 * Seconds to traverse one edge from `from` to `to` under `profile`.
 * Returns Infinity when the profile blocks that transit type.
 */
export function edgeDurationSec(edge, from, to, profile = resolveProfile(null)) {
  const transitType = edge?.transitType || 'WALKWAY';
  if (profile.blockedTransit?.includes(transitType)) return Infinity;

  const crossFloor = Boolean(from && to && from.floorId !== to.floorId);
  const delta = floorDelta(from, to);

  let seconds;
  switch (transitType) {
    case 'STAIRS':
      seconds = (profile.stairsRunMPerFloor * delta) / profile.stairsSpeedMps;
      break;
    case 'ESCALATOR':
      seconds =
        profile.escalatorEntrySec +
        (profile.escalatorRunMPerFloor * delta) / profile.escalatorSpeedMps;
      break;
    case 'ELEVATOR':
      seconds = profile.elevatorWaitSec + profile.elevatorPerFloorSec * delta;
      break;
    default: {
      // Cross-floor edges carry no meaningful length, so an unmeasured walkway
      // is free rather than NaN.
      const lengthM = Number.isFinite(edge?.lengthM) ? edge.lengthM : 0;
      seconds = lengthM / profile.walkSpeedMps;
      break;
    }
  }

  if (crossFloor) seconds += profile.floorChangePenaltySec || 0;

  const multiplier = profile.transitMultiplier?.[transitType];
  if (Number.isFinite(multiplier)) seconds *= multiplier;

  return seconds;
}

/**
 * A Dijkstra `costFn` for a resolved profile: duration in seconds, with
 * secondary (service corridor, back-of-house) edges penalised so the router
 * prefers the main route when both are about as fast.
 */
export function makeCostFn(profile) {
  return (edge, from, to) => {
    const seconds = edgeDurationSec(edge, from, to, profile);
    if (!Number.isFinite(seconds)) return Infinity;
    return edge?.rank === 'SECONDARY'
      ? seconds * profile.secondaryRankMultiplier
      : seconds;
  };
}
