import { buildQrSlug, parseQrSlug, buildScanUrl } from './qrPayload.js';

const OBJECT_ID = '64a1b2c3d4e5f6a7b8c9d0e1';
const CUID = 'clxyzabc1234567890abcdef1';

describe('qrPayload', () => {
  test('round-trips legacy ObjectId-style ids', () => {
    const slug = buildQrSlug(OBJECT_ID, 3, OBJECT_ID);
    expect(slug).toBe(`qr_${OBJECT_ID}_3_${OBJECT_ID}`);
    expect(parseQrSlug(slug)).toEqual({
      buildingId: OBJECT_ID,
      floorNumber: 3,
      nodeId: OBJECT_ID,
    });
  });

  test('round-trips cuid ids', () => {
    const slug = buildQrSlug(CUID, 0, CUID);
    expect(parseQrSlug(slug)).toEqual({
      buildingId: CUID,
      floorNumber: 0,
      nodeId: CUID,
    });
  });

  test('parses slugs printed in the field (exact legacy format)', () => {
    // This literal shape exists on physical stickers; it must parse forever.
    const parsed = parseQrSlug('qr_68491f2a9c1d2b3e4f5a6b7c_2_68491f2a9c1d2b3e4f5a6b7d');
    expect(parsed).toEqual({
      buildingId: '68491f2a9c1d2b3e4f5a6b7c',
      floorNumber: 2,
      nodeId: '68491f2a9c1d2b3e4f5a6b7d',
    });
  });

  test('rejects ids containing underscores at build time', () => {
    expect(() => buildQrSlug('has_underscore', 1, OBJECT_ID)).toThrow();
    expect(() => buildQrSlug(OBJECT_ID, 1, 'no_pe')).toThrow();
  });

  test('rejects negative or non-integer floors at build time', () => {
    expect(() => buildQrSlug(OBJECT_ID, -1, OBJECT_ID)).toThrow();
    expect(() => buildQrSlug(OBJECT_ID, 1.5, OBJECT_ID)).toThrow();
  });

  test('returns null for malformed slugs', () => {
    expect(parseQrSlug('not-a-slug')).toBeNull();
    expect(parseQrSlug('qr_only_two')).toBeNull();
    expect(parseQrSlug(42)).toBeNull();
  });

  test('buildScanUrl strips trailing slashes from the base', () => {
    expect(buildScanUrl('https://www.alertup.world/', OBJECT_ID, 1, OBJECT_ID)).toBe(
      `https://www.alertup.world/scan/route/qr_${OBJECT_ID}_1_${OBJECT_ID}`
    );
  });
});
