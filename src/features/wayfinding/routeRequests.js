/**
 * RouteRequest analytics (B13): what visitors actually asked for, so a
 * building owner can see which destinations people search for and which
 * routes fail. A failed route is the most valuable row here — it's how an
 * owner learns people keep asking for somewhere unreachable — so this must be
 * called on every outcome, not just the success path.
 *
 * Goes through `analyticsQueue.enqueue`, the same seam `searchEvent` writes
 * use: the write runs off the response path and can never fail (or delay) the
 * request that triggered it.
 *
 * Every call site is expected to only call this once `buildingId` is already
 * known to be real — e.g. after an origin `Node` (whose own `buildingId`
 * column is FK-backed) or a `Building` row has already been loaded. Calling
 * it with a caller-supplied, unverified building id would reopen the same
 * unauthenticated error-log tap the `/pois` search endpoint's 404 guard
 * exists to close (an anonymous caller driving unbounded failed FK writes).
 */

import prisma from '../../db/prisma.js';
import { enqueue } from '../../services/analyticsQueue.js';

/**
 * @param {object} params
 * @param {string} params.buildingId already confirmed to exist
 * @param {string|null} [params.fromNodeId]
 * @param {string|null} [params.to] a single destination token, or — for a
 *   multi-stop request — a JSON-encoded array of every requested token IN
 *   REQUEST ORDER (see the module doc on `wayfinding.routes.js` call sites
 *   for why order is preserved rather than collapsed to just the last stop)
 * @param {string} params.profile the resolved routing profile name
 * @param {'WAYFINDING'|'EVACUATION'} params.mode
 * @param {string} [params.src] defaults to 'web'; validated upstream by
 *   `parseRoutingQuery`'s `VALID_SRC` whitelist for the HTTP call sites
 * @param {boolean} params.found
 * @param {number|null} [params.distanceM]
 * @param {number|null} [params.durationSec]
 */
export function recordRouteRequest({
  buildingId,
  fromNodeId = null,
  to = null,
  profile,
  mode,
  src = 'web',
  found,
  distanceM = null,
  durationSec = null,
}) {
  enqueue('route-request', () =>
    prisma.routeRequest.create({
      data: {
        buildingId,
        fromNodeId,
        to,
        profile,
        mode,
        src,
        found: Boolean(found),
        distanceM,
        durationSec,
      },
    })
  );
}
