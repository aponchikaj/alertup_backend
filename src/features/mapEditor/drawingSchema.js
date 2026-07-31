/* ============================================================================
   Floor drawing — validation and normalization.
   ----------------------------------------------------------------------------
   The hand-drawn floor plan arrives as JSON from the map editor and is stored
   verbatim in Floor.drawing, then served back to *anonymous visitors* during
   wayfinding. That makes it untrusted input on the way in and rendered output
   on the way out, so nothing here is a passthrough:

     - unknown shape kinds are dropped, not stored (a renderer that switches on
       `kind` must never meet one it has no branch for);
     - every number is coerced and range-checked, so no NaN/Infinity can reach
       an SVG attribute and blank the whole layer;
     - logo URLs are restricted to http(s) and site-absolute paths — `data:`
       and `javascript:` are refused because the renderer puts this string in
       an <image href>, which executes SVG payloads in some browsers;
     - the shape count and serialized size are capped, because this column is
       read on every route request for the building.

   normalizeDrawing returns { ok, drawing, error }. Callers store `drawing`
   (already clean) and never the raw body.
   ========================================================================= */

/** Beyond this the editor is unusable anyway, and the column gets expensive. */
const MAX_SHAPES = 2000;

/** Serialized cap — Floor.drawing is fetched on every route request. */
const MAX_BYTES = 512 * 1024;

/** Coordinate bound. Floors are ~1000x800 units; this is slack, not a fit. */
const MAX_COORD = 100_000;

const MAX_POINTS = 500;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 120;
const MAX_TEXT_LENGTH = 500;

const SHAPE_KINDS = ['wall', 'room', 'shop', 'icon', 'text'];

/** Stamped markers. Kept in sync with the frontend ICON_KINDS. */
const ICON_KINDS = [
  'ELEVATOR',
  'ESCALATOR',
  'STAIRS',
  'DOOR',
  'ENTRANCE',
  'EXIT',
  'WC',
  'INFO',
];

const CURRENT_VERSION = 1;

/** #rgb / #rrggbb only — anything else could be a CSS expression. */
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const finite = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Coordinate: finite, clamped, and rounded to 0.01 to keep the column small. */
const coord = (value, fallback = null) => {
  const n = finite(value);
  if (n === null) return fallback;
  const clamped = Math.min(Math.max(n, -MAX_COORD), MAX_COORD);
  return Math.round(clamped * 100) / 100;
};

/** Positive size. Zero-area shapes are dropped by the caller, not clamped up. */
const size = (value) => {
  const n = coord(value);
  return n === null || n <= 0 ? null : n;
};

const str = (value, maxLength) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
};

const color = (value) => {
  const s = str(value, 7);
  return s && HEX_COLOR.test(s) ? s : null;
};

/**
 * Logo/image URL. Only http(s) and site-absolute paths survive; `data:` is
 * refused outright since an <image href="data:image/svg+xml,..."> is a script
 * execution vector, and protocol-relative `//host` is refused because it
 * inherits a scheme we did not choose.
 */
const imageUrl = (value) => {
  const s = str(value, 2048);
  if (!s) return null;
  if (s.startsWith('//')) return null;
  if (s.startsWith('/')) return s;
  return /^https?:\/\//i.test(s) ? s : null;
};

/** Ids are client-generated; they only have to be short, unique-ish strings. */
const shapeId = (value, index) => str(value, MAX_ID_LENGTH) || `s${index}`;

/** Node link back into the routing graph. Validated as a shape, not an FK — a
 *  stale id renders as an unlinked shape rather than failing the whole save. */
const nodeRef = (value) => str(value, MAX_ID_LENGTH);

const oneOf = (value, allowed) =>
  typeof value === 'string' && allowed.includes(value) ? value : null;

/** Flat [x, y, x, y, ...]; odd tails and non-finite entries are dropped. */
const points = (value) => {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (let i = 0; i + 1 < value.length && out.length < MAX_POINTS * 2; i += 2) {
    const x = coord(value[i]);
    const y = coord(value[i + 1]);
    if (x === null || y === null) continue;
    out.push(x, y);
  }
  // A single point is not a wall.
  return out.length >= 4 ? out : null;
};

/**
 * Normalize one shape. Returns null for anything unusable, which the caller
 * drops silently — a malformed shape must not cost the user the rest of the
 * floor they just drew.
 */
const normalizeShape = (raw, index) => {
  if (!raw || typeof raw !== 'object') return null;

  const kind = oneOf(raw.kind, SHAPE_KINDS);
  if (!kind) return null;

  const base = { id: shapeId(raw.id, index), kind };

  if (kind === 'wall') {
    const pts = points(raw.points);
    if (!pts) return null;
    const thickness = size(raw.thickness);
    return { ...base, points: pts, thickness: thickness ?? 4 };
  }

  if (kind === 'text') {
    const x = coord(raw.x);
    const y = coord(raw.y);
    const text = str(raw.text, MAX_TEXT_LENGTH);
    if (x === null || y === null || !text) return null;
    return { ...base, x, y, text, fontSize: size(raw.fontSize) ?? 16 };
  }

  if (kind === 'icon') {
    const x = coord(raw.x);
    const y = coord(raw.y);
    const icon = oneOf(raw.icon, ICON_KINDS);
    if (x === null || y === null || !icon) return null;
    const shape = { ...base, x, y, icon, size: size(raw.size) ?? 28 };
    const rotation = finite(raw.rotation);
    if (rotation !== null) shape.rotation = ((rotation % 360) + 360) % 360;
    const label = str(raw.label, MAX_NAME_LENGTH);
    if (label) shape.label = label;
    const nodeId = nodeRef(raw.nodeId);
    if (nodeId) shape.nodeId = nodeId;
    return shape;
  }

  // room | shop — both are axis-aligned boxes; shop additionally carries
  // branding and a POI node link.
  const x = coord(raw.x);
  const y = coord(raw.y);
  const width = size(raw.width);
  const height = size(raw.height);
  if (x === null || y === null || width === null || height === null) return null;

  const shape = { ...base, x, y, width, height };
  const name = str(raw.name, MAX_NAME_LENGTH);
  if (name) shape.name = name;
  const fill = color(raw.fill);
  if (fill) shape.fill = fill;
  const stroke = color(raw.stroke);
  if (stroke) shape.stroke = stroke;

  if (kind === 'shop') {
    const logoUrl = imageUrl(raw.logoUrl);
    if (logoUrl) shape.logoUrl = logoUrl;
    const nodeId = nodeRef(raw.nodeId);
    if (nodeId) shape.nodeId = nodeId;
  }

  return shape;
};

/**
 * Validate and normalize a full drawing payload.
 *
 * `null`/`undefined` is a legitimate value — it means "this floor has no
 * drawing" — and is passed through so a PATCH can clear one.
 *
 * @param {unknown} raw
 * @returns {{ok: true, drawing: object|null} | {ok: false, error: string}}
 */
export function normalizeDrawing(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, drawing: null };
  }

  let value = raw;
  // Multipart bodies arrive as strings; JSON bodies arrive parsed.
  if (typeof value === 'string') {
    if (value.length > MAX_BYTES) {
      return { ok: false, error: 'Drawing is too large.' };
    }
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: 'Drawing must be valid JSON.' };
    }
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Drawing must be an object.' };
  }

  const rawShapes = Array.isArray(value.shapes) ? value.shapes : [];
  if (rawShapes.length > MAX_SHAPES) {
    return { ok: false, error: `A floor cannot hold more than ${MAX_SHAPES} shapes.` };
  }

  const shapes = [];
  for (let i = 0; i < rawShapes.length; i += 1) {
    const shape = normalizeShape(rawShapes[i], i);
    if (shape) shapes.push(shape);
  }

  const drawing = { version: CURRENT_VERSION, shapes };

  // Re-check after normalization: names and logo URLs are the parts that grow.
  if (JSON.stringify(drawing).length > MAX_BYTES) {
    return { ok: false, error: 'Drawing is too large.' };
  }

  return { ok: true, drawing };
}

export const DRAWING_LIMITS = { MAX_SHAPES, MAX_BYTES, MAX_COORD };
export { SHAPE_KINDS, ICON_KINDS, CURRENT_VERSION };
