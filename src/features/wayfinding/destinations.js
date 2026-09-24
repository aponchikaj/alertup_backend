/**
 * Resolve a `to` query token to a routable node, and parse the (future
 * multi-stop) `to` query parameter into an ordered list of such tokens.
 *
 * A destination token is one of:
 *   - a raw node id
 *   - `poi:<poiId>`     — resolved to that POI's node
 *   - `ext:<code>`      — an integrator-supplied stable code, resolved
 *                         against `Poi.externalId` scoped to the building
 *                         first, then `Node.externalId`
 *
 * No cross-building leakage: `ext:` lookups are always scoped by
 * `buildingId` in the query itself (both `Poi` and `Node` carry
 * `@@unique([buildingId, externalId])`), so the same code reused by two
 * buildings never resolves to the wrong one. `poi:<id>` and raw node ids are
 * intentionally NOT scoped here — the caller (wayfinding.routes.js) already
 * checks the resolved node against the graph loaded for the origin's
 * building, and rejects with the existing "Destination is not in this
 * building." message, which byte-for-byte preserves today's behaviour.
 */

import prisma from '../../db/prisma.js';
import { isId } from '../../utils/ids.js';

const MAX_DESTINATIONS = 8;

const poiSummary = (poi) => (poi ? { id: poi.id, name: poi.name, category: poi.category } : null);

/**
 * @param {string} buildingId the origin's building — only `ext:` lookups are
 *   actually scoped by it; see the module doc.
 * @param {string} raw one destination token from the `to` query param
 * @returns {Promise<{ok:true, nodeId:string, poi:{id,name,category}|null}
 *                   | {ok:false, status:400|404, message:string}>}
 */
export async function resolveDestination(buildingId, raw) {
  const value = typeof raw === 'string' ? raw : String(raw ?? '');

  if (value.startsWith('poi:')) {
    const poiId = value.slice(4);
    if (!isId(poiId)) return { ok: false, status: 400, message: 'Invalid destination.' };

    const poi = await prisma.poi.findUnique({
      where: { id: poiId },
      select: { id: true, name: true, category: true, nodeId: true },
    });
    if (!poi) return { ok: false, status: 404, message: 'Destination not found.' };

    return { ok: true, nodeId: poi.nodeId, poi: poiSummary(poi) };
  }

  if (value.startsWith('ext:')) {
    const code = value.slice(4);
    if (!code) return { ok: false, status: 400, message: 'Invalid destination.' };

    const poi = await prisma.poi.findFirst({
      where: { buildingId, externalId: code },
      select: { id: true, name: true, category: true, nodeId: true },
    });
    if (poi) return { ok: true, nodeId: poi.nodeId, poi: poiSummary(poi) };

    const node = await prisma.node.findFirst({
      where: { buildingId, externalId: code },
      select: { id: true, poi: { select: { id: true, name: true, category: true } } },
    });
    if (node) return { ok: true, nodeId: node.id, poi: poiSummary(node.poi) };

    return { ok: false, status: 404, message: 'Destination not found.' };
  }

  if (!isId(value)) {
    return { ok: false, status: 400, message: 'Invalid destination node id.' };
  }
  return { ok: true, nodeId: value, poi: null };
}

/**
 * Parse the `to` query param — a string, a repeated array of strings, or
 * absent — into an ordered, capped list of destination tokens. Adjacent
 * duplicates collapse (a client re-sending the same stop twice in a row);
 * non-adjacent repeats (a round trip back through an earlier stop) are kept.
 *
 * Multi-destination routing itself is B12 — today's callers only ever look
 * at `[0]` — but the parsing is shared groundwork for it.
 *
 * @param {{to?: string|string[]}} query `req.query`
 * @returns {string[]} at most 8 entries
 */
export function parseDestinations(query = {}) {
  const raw = query?.to;
  if (raw === undefined || raw === null || raw === '') return [];

  const values = (Array.isArray(raw) ? raw : [raw])
    .map((v) => String(v).trim())
    .filter(Boolean);

  const deduped = [];
  for (const value of values) {
    if (deduped.length > 0 && deduped[deduped.length - 1] === value) continue;
    deduped.push(value);
  }

  return deduped.slice(0, MAX_DESTINATIONS);
}
