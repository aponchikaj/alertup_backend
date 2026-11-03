import prisma from '../../db/prisma.js';

/**
 * Durable replay backlog for the SSE emergency/closure feed (`RealtimeEvent`).
 *
 * `broadcaster.publish()` emits to live subscribers immediately using an
 * in-memory monotonic sequence (`nextSeq`), then hands the frame here to be
 * persisted asynchronously. A lost persist only degrades replay — it never
 * blocks or fails the broadcast that already went out, and the `state`
 * snapshot a client gets on connect plus gaps in `heartbeat.seq` are how a
 * client notices it is missing something, even if replay itself comes up
 * short.
 *
 * Ordering matters more than raw delivery speed here, which is why this is
 * NOT routed through `src/services/analyticsQueue.js`. That queue runs every
 * task concurrently on its own microtask with no ordering between tasks and
 * no way to observe a failure — fine for a search-log write nobody replays,
 * wrong for a table with a `@@unique([buildingId, seq])` constraint: two
 * publishes to the same building racing that queue could hit the constraint
 * in either order and the loser would simply vanish, silently, in the one
 * structure whose entire job is "no frame is ever dropped".
 *
 * Instead each building gets its own promise chain — a tiny serial queue:
 *   - writes for one building are strictly ordered, so they can never race
 *     the unique index against each other and never need a retry-on-conflict
 *     loop;
 *   - writes for different buildings stay fully concurrent — no building's
 *     backlog can head-of-line block another's;
 *   - a failed write is logged with exactly which building/seq/event it lost
 *     (not swallowed into an unrelated log line), and — critically — the
 *     chain swallows that failure before continuing, so one bad write never
 *     wedges every later append for that building.
 */

// Mongo TTL replacement pattern, same as verifications/invites in the
// sweeper: the durable replay backlog only needs to outlive a plausible
// reconnect gap (a dead phone, a lift with no signal), not forever.
export const REALTIME_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

// Event types that exist only for the authenticated member feed (live logs,
// live counters — they fire on every QR scan and every recorded occupant
// action). The public stream never forwards them. This lives here, not just
// in the route, because the sequence bookkeeping below needs the exact same
// definition the route's replay filter uses — the two drifting apart is
// exactly how the heartbeat watermark bug happened the first time.
export const MEMBER_ONLY_EVENTS = ['log_appended', 'counters_updated'];

const lastSeq = new Map(); // buildingId -> last allocated seq, ALL events (Number)
const lastPublicSeq = new Map(); // buildingId -> last allocated seq among PUBLIC-visible events only
const chains = new Map(); // buildingId -> tail promise of that building's write chain
const seedPromises = new Map(); // buildingId -> in-flight/settled DB-seed lookup

/**
 * Best-effort, fire-and-forget: on the FIRST use of `buildingId` in this
 * process, look up the true max seq already persisted for it (both overall
 * and restricted to public-visible events) and raise the in-memory
 * watermarks to at least that — so a process restart that happens mid-burst
 * (several seqs allocated within the same wall-clock millisecond, which is
 * exactly when `Date.now()` alone cannot distinguish them) cannot reissue a
 * seq a previous process already persisted and a client may already hold.
 *
 * Deliberately not awaited by `nextSeq`/`currentSeq`/`currentPublicSeq` —
 * doing so would make seq allocation (and therefore `publish()`) depend on a
 * database round trip, which is precisely the "emit before persist" property
 * this feature is built on. The realistic window this leaves open is only
 * the very first synchronous burst in a process's lifetime for one building,
 * before this lookup has had time to resolve; every heartbeat after that
 * (every 25s) is already reporting the corrected value.
 */
function ensureSeeded(id) {
  let promise = seedPromises.get(id);
  if (promise) return promise;
  promise = Promise.all([
    prisma.realtimeEvent.aggregate({ where: { buildingId: id }, _max: { seq: true } }),
    prisma.realtimeEvent.aggregate({
      where: { buildingId: id, event: { notIn: MEMBER_ONLY_EVENTS } },
      _max: { seq: true },
    }),
  ])
    .then(([all, publicOnly]) => {
      const dbMax = all._max.seq;
      if (dbMax !== null && dbMax !== undefined) {
        const dbMaxNum = Number(dbMax);
        if (dbMaxNum > (lastSeq.get(id) || 0)) lastSeq.set(id, dbMaxNum);
      }
      const dbPublicMax = publicOnly._max.seq;
      if (dbPublicMax !== null && dbPublicMax !== undefined) {
        const dbPublicMaxNum = Number(dbPublicMax);
        if (dbPublicMaxNum > (lastPublicSeq.get(id) || 0)) lastPublicSeq.set(id, dbPublicMaxNum);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[eventLog] failed to seed lastSeq for building=${id} from DB:`, err);
    });
  seedPromises.set(id, promise);
  return promise;
}

/**
 * Next seq for `buildingId`. Per-building (the unique constraint is
 * `[buildingId, seq]`, not global), monotonic, and seeded from wall-clock
 * time so a process restart can never reissue a seq a client already saw:
 * `Date.now()` is already far ahead of any small in-memory counter the
 * instant the process comes back up. `ensureSeeded` backstops the one case
 * that alone doesn't cover — a same-millisecond restart — without making
 * this function (or `publish()`, which calls it synchronously) async.
 *
 * `event` is REQUIRED, on purpose, not merely typed as one: it decides
 * whether this seq also advances `lastPublicSeq` (see `currentPublicSeq`).
 * A default that treated a missing event as public-visible would be exactly
 * the kind of silent classification drift this whole fix round exists to
 * remove — its symptom would be the public-watermark resync storm again,
 * just triggered by one forgotten argument instead of two copies of a list.
 *
 * @param {string} buildingId
 * @param {string} event the event type this seq is being allocated for —
 *   used to decide whether it also advances `lastPublicSeq`.
 */
export function nextSeq(buildingId, event) {
  if (typeof event !== 'string' || event.length === 0) {
    throw new TypeError('nextSeq(buildingId, event): event is required');
  }
  const id = String(buildingId);
  ensureSeeded(id);
  const prev = lastSeq.get(id) || 0;
  const seq = Math.max(prev + 1, Date.now());
  lastSeq.set(id, seq);
  if (!MEMBER_ONLY_EVENTS.includes(event)) lastPublicSeq.set(id, seq);
  return seq;
}

/**
 * Highest seq handed out for `buildingId` so far, across ALL event types
 * (0 if none yet known). This is the building's own watermark, not any one
 * connection's. Used by the MEMBER feed's heartbeat, which forwards every
 * event type and so can legitimately compare against this.
 *
 * A PUBLIC stream must use `currentPublicSeq` instead — comparing its own
 * last-seen id (which only ever advances on events it actually receives)
 * against this all-events watermark would show it permanently "behind" by
 * however many `log_appended`/`counters_updated` frames fired in between,
 * even when it hasn't missed a single frame it was ever entitled to see.
 */
export function currentSeq(buildingId) {
  const id = String(buildingId);
  ensureSeeded(id);
  return lastSeq.get(id) || 0;
}

/**
 * Highest seq among PUBLIC-visible events for `buildingId` (0 if none yet).
 * This is the watermark a PUBLIC stream's heartbeat must report: a client
 * holding a lower value than this has missed a frame it was entitled to see;
 * a client at or above it is genuinely at the head of its own stream, even
 * if member-only events have advanced the building's overall sequence past
 * that point in the meantime.
 */
export function currentPublicSeq(buildingId) {
  const id = String(buildingId);
  ensureSeeded(id);
  return lastPublicSeq.get(id) || 0;
}

/** TEST-ONLY. Wait for the DB-seed lookup for `buildingId` — kicked off by
 *  the first `nextSeq`/`currentSeq` call for it — to settle. */
export async function _awaitSeedForTests(buildingId) {
  await ensureSeeded(String(buildingId));
}

/**
 * Queue the durable write for one already-broadcast event. Never throws and
 * never rejects into the caller — failure is logged and absorbed here, and
 * does not stop later appends for this building.
 * @returns {Promise<void>} resolves once this specific write has settled;
 *   callers are not expected to await it (see `flush` for tests).
 */
export function append(buildingId, seq, event, data) {
  const id = String(buildingId);
  const previous = chains.get(id) || Promise.resolve();
  const next = previous
    .catch(() => {}) // a prior failure must never poison the rest of the chain
    .then(() =>
      prisma.realtimeEvent.create({
        data: { buildingId: id, seq: BigInt(seq), event, data },
      })
    )
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[eventLog] failed to persist building=${id} seq=${seq} event="${event}":`,
        err
      );
    });
  chains.set(id, next);
  return next;
}

/**
 * TEST-ONLY. Wait for every write currently queued for `buildingId` (or, if
 * omitted, every building) to settle before asserting on the database.
 */
export async function flush(buildingId) {
  if (buildingId !== undefined) {
    await (chains.get(String(buildingId)) || Promise.resolve());
    return;
  }
  await Promise.allSettled([...chains.values()]);
}

/**
 * Frames a reconnecting client missed for `buildingId`, strictly after
 * `sinceSeq`, oldest first, capped at `limit`. `seq` is converted back to
 * `Number` here — `BigInt` does not survive `JSON.stringify`, and every seq
 * value that reaches this boundary is `Date.now()`-scale, well inside the
 * range a JS number represents exactly.
 *
 * `excludeEvents` filters IN THE QUERY, not after fetching — a public stream
 * excludes member-only event types (`log_appended`, `counters_updated`), and
 * during a live emergency those can dominate the backlog. Filtering after a
 * capped fetch would let them fill the whole page and crowd out the handful
 * of `closure_changed`/`emergency_*` frames a public client actually needs,
 * with no sign anything was dropped; filtering first means the cap only
 * ever counts against rows this caller can actually forward.
 *
 * @returns {Promise<{events: {seq:number,event:string,data:object}[], truncated: boolean}>}
 *   `truncated` is true when more matching rows exist past `limit` — the
 *   caller (the SSE route) uses this to tell a client explicitly that it
 *   isn't fully caught up, rather than letting it assume a partial replay
 *   means "done".
 */
export async function replaySince(buildingId, sinceSeq, { limit = 500, excludeEvents = [] } = {}) {
  const rows = await prisma.realtimeEvent.findMany({
    where: {
      buildingId: String(buildingId),
      seq: { gt: BigInt(sinceSeq) },
      ...(excludeEvents.length ? { event: { notIn: excludeEvents } } : {}),
    },
    orderBy: { seq: 'asc' },
    take: limit + 1, // one extra row to detect truncation without a second count query
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return {
    events: page.map((row) => ({ seq: Number(row.seq), event: row.event, data: row.data })),
    truncated,
  };
}

/** Sweeper hook: delete replay rows older than `ms` (default: full retention). */
export async function purgeOlderThan(ms = REALTIME_EVENT_RETENTION_MS) {
  await prisma.realtimeEvent.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - ms) } },
  });
}

/** TEST-ONLY. Reset in-memory sequence/chain/seed state between test files. */
export function _resetForTests() {
  lastSeq.clear();
  lastPublicSeq.clear();
  chains.clear();
  seedPromises.clear();
}
