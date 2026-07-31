// ID validation replacing mongoose.isValidObjectId.
// Two shapes coexist after the Postgres migration:
//  - 24-char hex: rows migrated from Mongo keep their ObjectId string as PK
//    (printed QR codes embed these — they must resolve forever)
//  - cuid: new rows (25+ chars, starts with "c", lowercase alphanumeric)
// Neither contains "_", which the qr_{buildingId}_{floor}_{nodeId} parser
// relies on.

const OBJECT_ID_RE = /^[0-9a-f]{24}$/;
const CUID_RE = /^c[a-z0-9]{20,}$/;

export function isLegacyId(value) {
  return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

export function isId(value) {
  return (
    typeof value === 'string' && (OBJECT_ID_RE.test(value) || CUID_RE.test(value))
  );
}
