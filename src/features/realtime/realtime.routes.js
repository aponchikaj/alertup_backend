import { Router } from 'express';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import { requireMembership } from '../../middlewares/requireBuildingPermission.js';
import { fail } from '../../utils/respond.js';
import { isId } from '../../utils/ids.js';
import { sseConnectLimiter } from '../../services/rateLimiter.js';
import { getStatus } from '../emergency/emergencyService.js';
import { subscribe, atCapacity, registerCloser } from './broadcaster.js';
import { replaySince, currentSeq, currentPublicSeq, MEMBER_ONLY_EVENTS } from './eventLog.js';
import { initSse, sendEvent, startHeartbeat } from './sseHelpers.js';

const router = Router();

// SSE endpoints. Every connection gets a `state` snapshot, so reconnects
// self-heal without Last-Event-ID bookkeeping and clients never need a
// separate status fetch.

/**
 * Which buffered live messages should still be forwarded after replay has
 * already run, given the exact set of seqs replay sent and the original
 * resume point the client asked for.
 *
 * Exported and tested on its own: comparing a buffered message's seq against
 * a single "high-water mark" (the max seq replay returned) is wrong whenever
 * replay has a gap in it — e.g. one frame's DB persist failed while a later
 * one succeeded. Replay then returns only the later frame, but a naive
 * high-water check would treat the failed frame's (lower) seq as "already
 * covered" and drop it from the buffer too, even though the buffer is the
 * only place that frame's data still exists. Comparing against the exact
 * SET of replayed seqs has no such blind spot.
 *
 * @param {{event:string,data:object,seq:number}[]} buffered
 * @param {object} [options]
 * @param {number} [options.sinceSeqFloor] the client's original resume point
 *   (0 if none) — anything at or below this is something the client already
 *   claims to have, replayed or not.
 * @param {Set<number>} [options.replayedSeqs] exact seqs replay already sent
 *   for this connection.
 */
export function selectBufferedToForward(buffered, { sinceSeqFloor = 0, replayedSeqs = new Set() } = {}) {
  return buffered.filter((msg) => msg.seq > sinceSeqFloor && !replayedSeqs.has(msg.seq));
}

/**
 * @param {object} [options]
 * @param {boolean} [options.includeLogs]
 * @param {number} [options.heartbeatIntervalMs] test-only override of the
 *   default heartbeat cadence; production call sites never pass this.
 */
export async function openStream(
  req,
  res,
  buildingId,
  { includeLogs = false, heartbeatIntervalMs } = {}
) {
  if (atCapacity(buildingId)) {
    res.set('Retry-After', '30');
    return fail(res, 503, 'Too many live connections for this building. Falling back to polling.');
  }

  const excludedEvents = includeLogs ? [] : MEMBER_ONLY_EVENTS;
  const forwardable = (event) => !excludedEvents.includes(event);

  let lastSeq = 0;
  const deliverLive = ({ event, data, seq }) => {
    if (!forwardable(event)) return;
    try {
      sendEvent(res, event, data, { id: seq });
      lastSeq = seq;
    } catch {
      cleanup(); // eslint-disable-line no-use-before-define
    }
  };

  // Subscribe BEFORE any of the async work below (the snapshot/replay/log
  // history all await) — buffering whatever the broadcaster delivers in the
  // meantime instead of forwarding it. Without this, anything published in
  // that window landed in neither the replay query (already past) nor the
  // live subscription (not yet active) and was lost — the exact gap this
  // feature exists to close. `buffering` flips off only once replay, log
  // history and a fresh `state` have all been sent.
  //
  // Filtered at push time, not just at drain: a message this stream will
  // never forward has no reason to sit in the buffer for the length of the
  // setup window only to be discarded later — bounded and harmless either
  // way, but filtering here means `buffered` actually holds what its name
  // suggests, and `deliverLive`'s own check below becomes pure redundancy
  // rather than the only place this ever gets enforced for buffered frames.
  let buffering = true;
  const buffered = [];
  const unsubscribe = subscribe(buildingId, (msg) => {
    if (!forwardable(msg.event)) return;
    if (buffering) buffered.push(msg);
    else deliverLive(msg);
  });

  let cleaned = false;
  let stopHeartbeat = () => {};
  let unregister = () => {};
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    stopHeartbeat();
    unsubscribe();
    unregister();
  }
  req.on('close', cleanup);
  res.on('error', cleanup);

  try {
    initSse(res);

    // Resume: the browser's own automatic EventSource reconnect sends
    // Last-Event-ID; a manual reconnect (the app re-opening the stream
    // itself) has no way to set that header, so ?sinceSeq is the fallback.
    // This endpoint is public and unauthenticated, so a malformed value
    // (non-integer, negative, empty or whitespace-only) is treated as "no
    // resume point" rather than failing the connection — it must never be
    // able to kill the stream outright. `.trim()` matters here: `Number('
    // ')` is 0, which would otherwise pass both guards below and trigger a
    // full replay of the retained backlog for a value that was never a real
    // sequence number.
    let sinceSeqFloor = 0; // the client's original resume point, for buffer dedup
    let replayWatermark = 0; // furthest seq replay actually reached, for resync_required reporting
    const replayedSeqs = new Set(); // exact seqs already sent via replay
    const resumeRaw = req.get('Last-Event-ID') ?? req.query.sinceSeq;
    if (resumeRaw !== undefined && String(resumeRaw).trim() !== '') {
      const sinceSeq = Number(resumeRaw);
      if (Number.isSafeInteger(sinceSeq) && sinceSeq >= 0) {
        sinceSeqFloor = sinceSeq;
        replayWatermark = sinceSeq;
        const { events: missed, truncated } = await replaySince(buildingId, sinceSeq, {
          excludeEvents: excludedEvents,
        });
        for (const { seq, event, data } of missed) {
          sendEvent(res, event, data, { id: seq });
          lastSeq = seq;
          replayWatermark = seq;
          replayedSeqs.add(seq);
        }
        if (truncated) {
          // More matching rows exist past the page than were sent. Telling
          // the client explicitly beats letting it assume a partial replay
          // means "caught up" — a public client on a bad connection would
          // otherwise silently miss whatever fell past the cap. Not part of
          // the original wire contract; an EventSource client that has no
          // listener for this event name simply ignores it.
          sendEvent(res, 'resync_required', { reason: 'replay_truncated', atSeq: replayWatermark });
        }
      }
      // else: malformed resume value — ignored, stream proceeds fresh.
    }

    // Fresh, authoritative snapshot, computed and sent while STILL
    // buffering (so nothing live can slip in ahead of it). Replay above can
    // carry a stale `emergency_started` with no matching `emergency_ended`
    // if the end fell outside the window — this snapshot is the final word
    // for everything sent so far and must land after it, never before,
    // or a stale replayed frame could outlive the true current state.
    const snapshot = await getStatus(buildingId);

    if (includeLogs) {
      const since = req.query.since ? new Date(String(req.query.since)) : null;
      const logs = await prisma.log.findMany({
        where: {
          buildingId,
          isEmergency: true,
          ...(since && !Number.isNaN(since.getTime())
            ? { createdAt: { gt: since } }
            : snapshot.startedAt
              ? { createdAt: { gte: snapshot.startedAt } }
              : { createdAt: { gt: new Date() } }),
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
      });
      for (const log of logs) {
        sendEvent(res, 'log_appended', {
          id: log.id,
          message: log.message,
          type: log.type,
          createdAt: log.createdAt,
        });
      }
    }

    sendEvent(res, 'state', snapshot);

    // Drain whatever the buffer collected during all of the above, then go
    // live. Anything replay already sent is a duplicate and is dropped;
    // everything else — published while we were awaiting state/replay/log-
    // history — is forwarded exactly like a live frame. Deduped against the
    // exact SET of replayed seqs, not a high-water number: a high-water
    // check would wrongly drop a buffered frame whose own DB persist failed
    // (so replay never actually returned it) just because its seq happens to
    // be below some LATER frame's seq that replay did return.
    for (const msg of selectBufferedToForward(buffered, { sinceSeqFloor, replayedSeqs })) {
      deliverLive(msg);
    }
    buffered.length = 0;
    buffering = false;

    // The heartbeat reports the watermark for THIS stream's own visibility:
    // the member feed forwards every event type, so the building-wide
    // watermark is correct for it; the public stream never forwards
    // log_appended/counters_updated (which fire on every QR scan and every
    // recorded action), so it must be compared against the highest seq among
    // events it could actually have received — otherwise a public client's
    // last-seen id would trail the building-wide watermark permanently and
    // by a lot during a live emergency, exactly when this must not fire.
    // Either way, a client holding a lower value than what its own stream
    // type reports here has missed a frame it was entitled to see and can
    // resync — seq values are wall-clock-scale and non-dense, so only this
    // "am I at the head of MY stream" comparison is meaningful, not
    // arithmetic between consecutive seqs.
    stopHeartbeat = startHeartbeat(res, heartbeatIntervalMs, {
      getSeq: () => (includeLogs ? currentSeq(buildingId) : currentPublicSeq(buildingId)),
    });
    unregister = registerCloser(() => {
      try {
        res.end();
      } catch {
        // already closed
      }
    });
    if (cleaned) {
      // The client disconnected while we were still awaiting replay/state/
      // log-history above — `req.on('close')` already ran `cleanup()`
      // against the no-op placeholders `stopHeartbeat`/`unregister` held at
      // that time, so it did nothing to the interval/closer just installed
      // above. Without this, a client that vanishes mid-setup leaves behind
      // a real 25s `setInterval` writing to a dead socket forever (`res.
      // write()` after disconnect returns silently rather than throwing, so
      // the write-failure catch inside `deliverLive` never catches this
      // either) and a `closers` entry nothing will ever remove — exactly
      // the shape of leak a reconnect storm would multiply.
      stopHeartbeat();
      unregister();
    }
  } catch (err) {
    console.error('Realtime stream error:', err);
    cleanup();
    try {
      // Headers may already be flushed by the time something here throws —
      // in that case `fail()` (a JSON body) can't be sent, but the response
      // must still be ended, or a client that received `state` and nothing
      // else is left holding an open connection that will never say
      // anything again, including the heartbeat that would tell it the
      // stream is dead.
      res.end();
    } catch {
      // socket already gone
    }
  }
}

// Public: emergency state broadcast for scan/route pages. No auth — anyone
// physically in the building must receive the alert.
router.get('/api/realtime/buildings/:buildingId/status', sseConnectLimiter, async (req, res) => {
  try {
    const { buildingId } = req.params;
    if (!isId(buildingId)) return fail(res, 400, 'Invalid building id.');
    const building = await prisma.building.findUnique({
      where: { id: buildingId },
      select: { id: true },
    });
    if (!building) return fail(res, 404, 'Building not found.');
    await openStream(req, res, buildingId, { includeLogs: false });
  } catch (err) {
    console.error('Realtime status stream error:', err);
    // openStream() itself never throws (it ends the response on its own
    // errors) — this only guards a failure before it, e.g. the building
    // lookup above. Still: never assume headers weren't sent by the time an
    // error reaches here.
    if (!res.headersSent) fail(res, 500, 'Server error.');
    else {
      try {
        res.end();
      } catch {
        // socket already gone
      }
    }
  }
});

// Member-only: full feed incl. live emergency logs and counters. Replaces the
// 10-second polling of /api/administration/logs/:id.
router.get(
  '/api/realtime/buildings/:buildingId/feed',
  whoami,
  requireMembership,
  async (req, res) => {
    try {
      await openStream(req, res, req.building.id, { includeLogs: true });
    } catch (err) {
      console.error('Realtime feed stream error:', err);
      if (!res.headersSent) fail(res, 500, 'Server error.');
      else {
        try {
          res.end();
        } catch {
          // socket already gone
        }
      }
    }
  }
);

export default router;
