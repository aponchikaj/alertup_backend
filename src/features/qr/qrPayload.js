// Canonical QR payload: qr_{buildingId}_{floorNumber}_{nodeId}
//
// This exact format is printed on physical stickers in buildings — it can
// never change shape. The parser regex is greedy around the floor number,
// which is safe only while ids contain no underscores (true for both Mongo
// ObjectId hex and cuid). build() asserts that invariant so a future id
// scheme can't silently break parsing.

const QR_PATTERN = /^qr_(.+)_(\d+)_(.+)$/;

export function buildQrSlug(buildingId, floorNumber, nodeId) {
  if (String(buildingId).includes('_') || String(nodeId).includes('_')) {
    throw new Error('IDs used in QR payloads must not contain underscores');
  }
  const floor = Number(floorNumber);
  if (!Number.isInteger(floor) || floor < 0) {
    throw new Error('QR payloads require a non-negative integer floor number');
  }
  return `qr_${buildingId}_${floor}_${nodeId}`;
}

/**
 * @returns {{buildingId: string, floorNumber: number, nodeId: string} | null}
 */
export function parseQrSlug(qrId) {
  if (typeof qrId !== 'string') return null;
  const match = qrId.match(QR_PATTERN);
  if (!match) return null;
  return {
    buildingId: match[1],
    floorNumber: parseInt(match[2], 10),
    nodeId: match[3],
  };
}

export function buildScanUrl(baseUrl, buildingId, floorNumber, nodeId) {
  const slug = buildQrSlug(buildingId, floorNumber, nodeId);
  return `${String(baseUrl).replace(/\/+$/, '')}/scan/route/${slug}`;
}
