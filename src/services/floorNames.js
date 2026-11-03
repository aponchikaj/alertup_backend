// A floor's printed QR code opens /building/<buildingId>/<floorName> in the
// web app, and that URL cannot change once a sticker is on a wall. These
// names are taken by static pages at the same depth, which win the route
// match, so a floor called one of them could never be opened from its code
// (FX-095). Keep in step with the /building/:buildingId/<page> routes in the
// frontend's App.tsx.
export const RESERVED_FLOOR_NAMES = Object.freeze(['nodes', 'members', 'logs', 'analytics']);

/** An error message when `name` collides with an app page, else null. */
export function reservedFloorNameError(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().toLowerCase();
  return RESERVED_FLOOR_NAMES.includes(n)
    ? `"${name.trim()}" is reserved; choose another floor name.`
    : null;
}
