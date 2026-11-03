import { assertKeyInBuilding } from '../services/storage.js';

/* ============================================================================
   FX-014 — a delete may only touch the building's own files.

   `deleteByUrl` used to accept any key under the generic `buildings/` prefix.
   A floor row holding another tenant's asset URL (written through the since-
   removed floor-map PUT, which stored a client-supplied URL) would delete that
   tenant's file when the floor was replaced or removed. Every delete is now
   scoped to `buildings/<thisBuildingId>/`.
   ========================================================================= */

test('a key under this building is allowed', () => {
  expect(() => assertKeyInBuilding('buildings/b1/floors/f1/map-1.png', 'b1')).not.toThrow();
});

test("another building's key is refused", () => {
  expect(() => assertKeyInBuilding('buildings/b2/floors/f9/map-1.png', 'b1')).toThrow(/outside building/);
});

test('a prefix trick (b1 vs b10) is refused', () => {
  expect(() => assertKeyInBuilding('buildings/b10/logos/x.png', 'b1')).toThrow(/outside building/);
});

test('path traversal is refused', () => {
  expect(() => assertKeyInBuilding('buildings/b1/../b2/logos/x.png', 'b1')).toThrow(/outside building/);
});

test('a missing building id is refused rather than widened', () => {
  expect(() => assertKeyInBuilding('buildings/b1/logos/x.png', undefined)).toThrow();
});
