/**
 * Pure parsers for the map-editor's newer fields.
 *
 * Every function returns `{ok: true, value}` or `{ok: false, error}` so a
 * route reads the same way for all of them:
 *
 *     const tags = parseTags(req.body.tags);
 *     if (!tags.ok) return fail(res, 422, tags.error);
 *     data.tags = tags.value;
 *
 * The routes decide *whether* a field is part of a write (`!== undefined`);
 * these decide whether the value is legal. `null` consistently means "clear
 * it" rather than "reject it", because the editor's UI has a clear button for
 * every one of these and a PATCH is the only way to press it.
 *
 * No Prisma, no Express: the enums are duplicated from schema.prisma on
 * purpose so the validation is unit-testable without a database.
 */

const DIRECTIONS = ['BOTH', 'FORWARD', 'REVERSE'];
const RANKS = ['PRIMARY', 'SECONDARY'];
const VISIBILITIES = ['PUBLIC', 'STAFF', 'EMERGENCY_ONLY'];

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_EXTERNAL_ID_LENGTH = 64;
export const MAX_ALIASES = 20;
export const MAX_NAME_LENGTH = 120;

const bad = (error) => ({ ok: false, error });
const good = (value) => ({ ok: true, value });

/**
 * Enum parser factory. Accepts any casing and surrounding whitespace — the
 * editor sends canonical values, integrations send whatever they have.
 */
const enumParser = (label, allowed) => (raw) => {
  if (typeof raw !== 'string') {
    return bad(`${label} must be one of ${allowed.join(', ')}.`);
  }
  const value = raw.trim().toUpperCase();
  if (!allowed.includes(value)) {
    return bad(`${label} must be one of ${allowed.join(', ')}.`);
  }
  return good(value);
};

export const parseDirection = enumParser('direction', DIRECTIONS);
export const parseRank = enumParser('rank', RANKS);
export const parseVisibility = enumParser('visibility', VISIBILITIES);

/**
 * Routing tags ("stroller", "staff_only", "step_free"). Lowercased so
 * `includeTags=Stroller` and a tag typed as "STROLLER" are the same thing,
 * and de-duplicated so the array stays a set.
 *
 * @param {unknown} raw
 * @returns {{ok: true, value: string[]}|{ok: false, error: string}}
 */
export function parseTags(raw) {
  if (raw === null) return good([]);
  if (!Array.isArray(raw)) return bad('tags must be an array of strings.');
  if (raw.some((tag) => typeof tag !== 'string')) {
    return bad('tags must be an array of strings.');
  }

  const cleaned = [];
  for (const tag of raw) {
    const value = tag.trim().toLowerCase();
    if (!value) continue;
    if (value.length > MAX_TAG_LENGTH) {
      return bad(`Each tag must be ${MAX_TAG_LENGTH} characters or fewer.`);
    }
    if (!cleaned.includes(value)) cleaned.push(value);
  }
  if (cleaned.length > MAX_TAGS) {
    return bad(`At most ${MAX_TAGS} tags are allowed.`);
  }
  return good(cleaned);
}

/**
 * An integrator-supplied stable code (booth number, catalog SKU). Unique per
 * building at the database level, so the caller must map P2002 to a 409.
 *
 * @param {unknown} raw
 * @returns {{ok: true, value: string|null}|{ok: false, error: string}}
 */
export function parseExternalId(raw) {
  if (raw === null) return good(null);
  if (typeof raw !== 'string') {
    return bad('externalId must be a string, or null to clear it.');
  }
  const value = raw.trim();
  if (!value) return good(null);
  if (value.length > MAX_EXTERNAL_ID_LENGTH) {
    return bad(`externalId must be ${MAX_EXTERNAL_ID_LENGTH} characters or fewer.`);
  }
  return good(value);
}

const NAME_KEYS = ['en', 'ka'];

/**
 * Localized POI names: `{en?, ka?, aliases[]}`.
 *
 * Unknown keys are rejected rather than dropped — a typo'd locale that
 * silently vanishes is a shop whose Georgian name never shows up and nobody
 * can explain why.
 *
 * @param {unknown} raw
 * @returns {{ok: true, value: {en?: string, ka?: string, aliases: string[]}|null}
 *          |{ok: false, error: string}}
 */
export function parsePoiNames(raw) {
  if (raw === null) return good(null);
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('names must be an object like { en, ka, aliases }.');
  }

  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'aliases') continue;
    if (!NAME_KEYS.includes(key)) {
      return bad(`Unknown names key "${key}". Allowed: en, ka, aliases.`);
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') return bad(`names.${key} must be a string.`);
    const trimmed = value.trim().slice(0, MAX_NAME_LENGTH);
    if (trimmed) out[key] = trimmed;
  }

  const rawAliases = raw.aliases;
  const aliases = [];
  if (rawAliases !== undefined && rawAliases !== null) {
    if (!Array.isArray(rawAliases) || rawAliases.some((a) => typeof a !== 'string')) {
      return bad('names.aliases must be an array of strings.');
    }
    for (const alias of rawAliases) {
      const value = alias.trim().slice(0, MAX_NAME_LENGTH);
      if (!value) continue;
      // Case-insensitive de-duplication, first spelling wins — the editor
      // shows aliases back to the owner, so keep their capitalisation.
      if (aliases.some((existing) => existing.toLowerCase() === value.toLowerCase())) {
        continue;
      }
      aliases.push(value);
    }
    if (aliases.length > MAX_ALIASES) {
      return bad(`At most ${MAX_ALIASES} aliases are allowed.`);
    }
  }
  if (aliases.length > 0) out.aliases = aliases;

  return good(Object.keys(out).length > 0 ? { ...out, aliases } : null);
}

/**
 * The lowercase blob POI search matches against: display name, keywords, the
 * translated names and every alias, de-duplicated and space separated.
 *
 * Mirrors the shape the slice-1 migration backfilled
 * (`lower(name || ' ' || keywords)`) and extends it with `names`, so a shop
 * saved through the editor is findable by its Georgian name too.
 *
 * @param {{name?: string, keywords?: string[], names?: object|null}} poi
 * @returns {string}
 */
export function buildSearchText({ name, keywords, names } = {}) {
  const parts = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const lowered = value.trim().toLowerCase();
    if (lowered && !parts.includes(lowered)) parts.push(lowered);
  };

  push(name);
  for (const keyword of Array.isArray(keywords) ? keywords : []) push(keyword);
  if (names && typeof names === 'object' && !Array.isArray(names)) {
    for (const key of NAME_KEYS) push(names[key]);
    for (const alias of Array.isArray(names.aliases) ? names.aliases : []) push(alias);
  }

  return parts.join(' ');
}
