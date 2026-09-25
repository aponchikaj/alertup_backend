// Accountability trail for editor and emergency changes: who changed what,
// when, and to what.
//
// `writeAudit` must always be called with a Prisma **transaction client**
// (the `tx` argument `prisma.$transaction(async (tx) => ...)` hands you), and
// in the SAME transaction as the write it describes. That is the entire
// point: if the domain write fails, the audit row must not exist either — a
// row for a change that never happened is worse than no row — and if the
// domain write succeeds, the audit row must exist unconditionally. A queue or
// a fire-and-forget call after the transaction commits cannot guarantee
// either half of that.
//
// Deliberately NOT built on `src/services/analyticsQueue.js`: analytics may
// be dropped on failure (best-effort, off the hot path); an audit row may
// not be.

const MAX_PAYLOAD_BYTES = 8 * 1024;

/**
 * Resolve `{ actorUserId, actorType }` for an authenticated request.
 *
 * `whoami` populates `req.user` for signed-in requests; some emergency
 * occupant endpoints (`recordAction`) are deliberately anonymous and have no
 * `req.user` at all, which is SYSTEM, not USER-with-no-id — the schema's
 * ActorType enum exists precisely so those two cases are distinguishable in
 * the log rather than both being a null actorUserId.
 *
 * @param {{user?: {id?: string}}} req
 * @returns {{actorUserId: string|null, actorType: 'USER'|'SYSTEM'}}
 */
export function actorFromReq(req) {
  const userId = req?.user?.id ?? null;
  return {
    actorUserId: userId,
    actorType: userId ? 'USER' : 'SYSTEM',
  };
}

/**
 * Fit a JSON-serializable payload inside a byte budget without producing
 * invalid JSON. Small payloads (the overwhelming majority — a handful of
 * scalar fields) pass through untouched. A payload that overflows the budget
 * is replaced with a `{ truncated: true, preview }` envelope holding as much
 * of the original JSON text as fits, so a reviewer can still see the start of
 * what changed without the row blowing past the column's practical size.
 *
 * @param {unknown} payload
 * @param {number} [maxBytes]
 * @returns {unknown}
 */
export function truncatePayload(payload, maxBytes = MAX_PAYLOAD_BYTES) {
  if (payload === undefined || payload === null) return null;

  let json;
  try {
    json = JSON.stringify(payload);
  } catch {
    // Circular or otherwise unserializable — never let a logging concern
    // crash the write it is describing.
    return { truncated: true, preview: '[unserializable payload]' };
  }
  if (Buffer.byteLength(json, 'utf8') <= maxBytes) return payload;

  // The budget has to bound the size of what actually gets stored — the
  // ENVELOPE re-serialized with `preview` inside it, quotes and all — not the
  // raw preview text. A preview built from JSON (full of `"`) roughly doubles
  // in size once re-escaped as a JSON *string value*, so binary-search the
  // longest prefix whose re-serialized envelope still fits, rather than
  // guessing a cut length from the raw text's byte length.
  const fits = (len) =>
    Buffer.byteLength(JSON.stringify({ truncated: true, preview: json.slice(0, len) }), 'utf8') <=
    maxBytes;

  let lo = 0;
  let hi = json.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return { truncated: true, preview: json.slice(0, lo) };
}

/**
 * Write one audit row. Call this with a transaction client, in the same
 * transaction as the write it describes — see the module note above.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {object} params
 * @param {string} params.buildingId
 * @param {string|null} [params.actorUserId]
 * @param {'USER'|'SYSTEM'|'INTEGRATION'} [params.actorType]
 * @param {string} params.entity - the model this row is about (e.g. "Edge").
 * @param {string} params.entityId
 * @param {string} params.action - e.g. "create", "update", "delete", "trigger".
 * @param {unknown} [params.payload] - JSON-serializable; truncated to 8 KB.
 *   Callers must build this from already-validated/parsed fields, never from
 *   a raw request body, so a field that could carry a secret (password,
 *   token, session cookie) is never in scope to log by accident.
 * @param {import('@prisma/client').LogType} [params.type]
 * @param {boolean} [params.isEmergency] - keep false (the default) for audit
 *   rows: `POST /api/administration/logs/clear/:id` deletes only
 *   `isEmergency: true` rows, and an audit row surviving that clear is the
 *   whole point of this module.
 */
export async function writeAudit(
  tx,
  {
    buildingId,
    actorUserId = null,
    actorType = 'SYSTEM',
    entity,
    entityId,
    action,
    payload = null,
    type = 'SYSTEM',
    isEmergency = false,
  }
) {
  // `tx.log?.create` alone does not discriminate: the global PrismaClient has
  // it too, and passing that in would write a row that commits on its own,
  // immune to any rollback of the write it is meant to describe — exactly the
  // failure mode this module exists to prevent. A Prisma interactive
  // transaction client has no `$transaction` method (nor `$connect`,
  // `$disconnect`, `$on`, `$use`, `$extends`); the global client does. That is
  // the property that actually distinguishes them.
  if (!tx || typeof tx.log?.create !== 'function' || typeof tx.$transaction === 'function') {
    throw new Error(
      'writeAudit requires a Prisma transaction client — the `tx` argument of ' +
        'prisma.$transaction(async (tx) => ...) — not the global prisma client. ' +
        'Got something with a $transaction method, which the global client has ' +
        'and a transaction client does not.'
    );
  }
  if (!buildingId) throw new Error('writeAudit requires buildingId.');
  if (!entity) throw new Error('writeAudit requires entity.');
  if (!entityId) throw new Error('writeAudit requires entityId.');
  if (!action) throw new Error('writeAudit requires action.');

  return tx.log.create({
    data: {
      buildingId,
      type,
      isEmergency,
      message: `${entity}.${action}`,
      actorUserId,
      actorType,
      entity,
      entityId,
      payload: truncatePayload(payload),
    },
  });
}
