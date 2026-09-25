import http from 'node:http';
import { jest } from '@jest/globals';
import prisma from '../db/prisma.js';
import { createUser, createBuilding } from './helpers.js';
import { publish, subscribe, closeAll } from '../features/realtime/broadcaster.js';
import {
  nextSeq,
  currentSeq,
  currentPublicSeq,
  append,
  flush,
  replaySince,
  purgeOlderThan,
  _resetForTests,
  _awaitSeedForTests,
  REALTIME_EVENT_RETENTION_MS,
} from '../features/realtime/eventLog.js';
import { sendEvent, startHeartbeat } from '../features/realtime/sseHelpers.js';
import { openStream, selectBufferedToForward } from '../features/realtime/realtime.routes.js';
import app from '../../server.js';

/**
 * A minimal fake req/res pair for calling `openStream` directly, bypassing
 * Express/HTTP entirely. Used only where a real HTTP round trip would make
 * an otherwise-cheap assertion (a short heartbeat interval) slow or flaky.
 */
function fakeReqRes({ query = {}, headers = {} } = {}) {
  const closeHandlers = [];
  const req = {
    query,
    get: (name) => headers[name] ?? headers[name.toLowerCase()],
    on: (evt, cb) => {
      if (evt === 'close') closeHandlers.push(cb);
    },
  };
  const writes = [];
  const res = {
    writes,
    set: () => {},
    flushHeaders: () => {},
    write: (chunk) => {
      writes.push(chunk);
      return true;
    },
    on: () => {},
    end: () => {},
  };
  return { req, res, writes, triggerClose: () => closeHandlers.forEach((cb) => cb()) };
}

/** Polls until `prisma.realtimeEvent` has exactly `expectedCount` rows for
 *  `buildingId` — used to land a read deterministically between two known
 *  commits in the per-building write chain, instead of guessing with a delay. */
async function waitForRowCount(buildingId, expectedCount, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = await prisma.realtimeEvent.count({ where: { buildingId } });
    if (count === expectedCount) return;
    if (Date.now() > deadline) {
      throw new Error(`waitForRowCount: expected ${expectedCount} rows, still ${count}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/* ============================================================================
   B15 — resumable SSE.

   A visitor's connection can drop mid-emergency (a lift shaft, a dead phone,
   flaky building wifi). This slice makes the reconnect catch up instead of
   silently showing a stale map: every frame is durably logged with a
   per-building monotonic seq, and a client can ask to resume from either the
   browser's own `Last-Event-ID` header or a `?sinceSeq` query fallback (a
   manual reconnect has no way to set the header itself).
   ========================================================================= */

const seedBuilding = async () => {
  const { user } = await createUser();
  const { building } = await createBuilding(user.id);
  return building;
};

/** Starts `app` on an ephemeral port; caller must `server.close()`. */
const startTestServer = (application) =>
  new Promise((resolve) => {
    const server = application.listen(0, () => resolve(server));
  });

/**
 * Opens a raw HTTP GET against the SSE endpoint and parses `id:`/`event:`/
 * `data:` blocks as they arrive. Resolves once `count` full events have been
 * parsed (state snapshot included), then the caller can inspect them and
 * must destroy the connection itself.
 */
function collectSseEvents(server, path, { headers = {}, count, timeoutMs = 5000 } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Timed out waiting for ${count} SSE events; got ${events.length}`));
    }, timeoutMs);

    const req = http.get({ port, path, headers }, (res) => {
      res.on('data', (chunk) => {
        // A resolved/rejected collector must never keep parsing — more
        // bytes can already be queued on the socket (a subsequent chunk
        // delivered before the caller gets a chance to req.destroy()) and
        // would otherwise silently grow `events` past what was asked for.
        if (settled) return;
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let id;
          let eventName;
          const dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) eventName = line.slice(7);
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          }
          if (eventName || dataLines.length) {
            events.push({
              id,
              event: eventName || 'message',
              data: dataLines.length ? JSON.parse(dataLines.join('\n')) : undefined,
            });
          }
          if (events.length >= count) {
            settled = true;
            clearTimeout(timer);
            resolve({ req, res, events });
            return;
          }
        }
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
  });
}

describe('eventLog: per-building durable sequence', () => {
  afterEach(() => {
    _resetForTests();
  });

  test('nextSeq is monotonically increasing per building and independent across buildings', () => {
    const a1 = nextSeq('bldA', 'closure_changed');
    const a2 = nextSeq('bldA', 'closure_changed');
    const b1 = nextSeq('bldB', 'closure_changed');

    expect(a2).toBeGreaterThan(a1);
    expect(b1).toBeGreaterThan(0);
    // A fresh building's first seq is not influenced by another building's counter.
    expect(b1).not.toBe(a2 + 1);
  });

  test('nextSeq requires an event name — an unclassified event must never silently default to public-visible', () => {
    // This whole fix round existed because "is this event public-visible"
    // lived in two places and drifted. A default that treats a missing
    // event as public-visible is that same bug waiting for one forgotten
    // argument, with the resync storm as its symptom — so a missing event
    // must fail loudly here, not fall back to a guess.
    expect(() => nextSeq('bldA')).toThrow();
  });

  test('append persists every row for concurrent same-building writes without losing any to the unique constraint', async () => {
    const building = await seedBuilding();
    const seqs = Array.from({ length: 8 }, () => nextSeq(building.id, 'closure_changed'));

    // Fire all appends without awaiting individually — this is exactly the
    // "near-simultaneous broadcasts to the same building" case the unique
    // constraint on [buildingId, seq] is there to catch if ordering breaks.
    seqs.forEach((seq) => append(building.id, seq, 'closure_changed', { seq }));

    await flush(building.id);

    const rows = await prisma.realtimeEvent.findMany({
      where: { buildingId: building.id },
      orderBy: { seq: 'asc' },
    });
    expect(rows).toHaveLength(seqs.length);
    expect(rows.map((r) => Number(r.seq))).toEqual([...seqs].sort((x, y) => x - y));
  });

  test('a replaySince interleaved with in-flight appends never observes a hole (deterministic)', async () => {
    // This is the actual property the per-building serial chain buys: since
    // nextSeq() is synchronous and already hands out distinct values, a
    // plain unordered Promise.all of appends would never collide on the
    // unique constraint either — so that alone does not prove the chain is
    // doing anything. What it DOES buy is commit ORDER: seq N's write is
    // guaranteed fully committed before seq N+1's write even starts, so a
    // reader can never observe seq N+1 without also seeing seq N.
    //
    // A prior version of this test raced a read against an un-awaited burst
    // with no control over timing at all — measured (by review) to catch a
    // broken chain only ~58% of the time, and to compare two empty arrays in
    // the passing case. This version makes the "read lands mid-burst" moment
    // exact: one specific write is held open until the test releases it, so
    // the read is GUARANTEED to observe precisely the writes strictly before
    // it and none after.
    const building = await seedBuilding();
    const seqs = Array.from({ length: 20 }, () => nextSeq(building.id, 'closure_changed'));
    const holdAt = 10; // hold back the 11th write (index 10); 0..9 must commit for real first

    let releaseHold;
    const holdGate = new Promise((resolve) => {
      releaseHold = resolve;
    });
    const realCreate = prisma.realtimeEvent.create.bind(prisma.realtimeEvent);
    const spy = jest.spyOn(prisma.realtimeEvent, 'create').mockImplementation(async (args) => {
      if (Number(args.data.seq) === seqs[holdAt]) await holdGate;
      return realCreate(args);
    });

    try {
      const appendPromises = seqs.map((seq) => append(building.id, seq, 'closure_changed', { seq }));

      // Deterministic: writes 0..holdAt-1 are not held, so they run the chain
      // through to a real commit; write `holdAt` is blocked on holdGate, and
      // everything after it is queued behind it in the chain and hasn't
      // even started its `create()` call yet. Waiting for exactly `holdAt`
      // committed rows pins the read to land in that exact gap.
      await waitForRowCount(building.id, holdAt);

      const midFlight = await replaySince(building.id, 0);
      expect(midFlight.events.map((r) => r.seq)).toEqual(seqs.slice(0, holdAt));

      releaseHold();
      await Promise.all(appendPromises);
    } finally {
      spy.mockRestore();
    }

    const final = await replaySince(building.id, 0);
    expect(final.events.map((r) => r.seq)).toEqual(seqs);
  });

  test('a rejected persist does not stop the next append for the same building', async () => {
    const building = await seedBuilding();
    const spy = jest.spyOn(prisma.realtimeEvent, 'create').mockImplementationOnce(() => {
      return Promise.reject(new Error('simulated write failure'));
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const seq1 = nextSeq(building.id, 'closure_changed');
    const seq2 = nextSeq(building.id, 'closure_changed');
    append(building.id, seq1, 'closure_changed', {});
    append(building.id, seq2, 'closure_changed', {});

    await flush(building.id);

    const rows = await prisma.realtimeEvent.findMany({ where: { buildingId: building.id } });
    // seq1's write was rejected; seq2's must still have landed.
    expect(rows.map((r) => Number(r.seq))).toEqual([seq2]);
    expect(errorSpy).toHaveBeenCalled();

    spy.mockRestore();
    errorSpy.mockRestore();
  });

  test('replaySince returns only later events, scoped to one building', async () => {
    const buildingA = await seedBuilding();
    const buildingB = await seedBuilding();

    const seqA1 = nextSeq(buildingA.id, 'closure_changed');
    append(buildingA.id, seqA1, 'closure_changed', { n: 1 });
    const seqA2 = nextSeq(buildingA.id, 'closure_changed');
    append(buildingA.id, seqA2, 'closure_changed', { n: 2 });
    const seqB1 = nextSeq(buildingB.id, 'closure_changed');
    append(buildingB.id, seqB1, 'closure_changed', { n: 'b' });

    await flush(buildingA.id);
    await flush(buildingB.id);

    const missed = await replaySince(buildingA.id, seqA1);
    expect(missed.truncated).toBe(false);
    expect(missed.events).toEqual([{ seq: seqA2, event: 'closure_changed', data: { n: 2 } }]);

    const everythingA = await replaySince(buildingA.id, 0);
    expect(everythingA.events.map((m) => m.seq)).toEqual([seqA1, seqA2]);
  });

  test('replaySince reports truncated when more rows exist than the page limit', async () => {
    const building = await seedBuilding();
    await prisma.realtimeEvent.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        buildingId: building.id,
        seq: BigInt(i + 1),
        event: 'closure_changed',
        data: {},
      })),
    });

    const page = await replaySince(building.id, 0, { limit: 3 });
    expect(page.truncated).toBe(true);
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3]);

    const all = await replaySince(building.id, 0, { limit: 10 });
    expect(all.truncated).toBe(false);
    expect(all.events).toHaveLength(5);
  });

  test('replaySince is NOT truncated when the match count lands exactly on the page limit', async () => {
    const building = await seedBuilding();
    await prisma.realtimeEvent.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        buildingId: building.id,
        seq: BigInt(i + 1),
        event: 'closure_changed',
        data: {},
      })),
    });

    const page = await replaySince(building.id, 0, { limit: 5 });
    expect(page.truncated).toBe(false);
    expect(page.events).toHaveLength(5);
  });

  test('excludeEvents is applied in the query itself, so excluded rows never occupy the page cap', async () => {
    // 597 events a public client never sees, then 3 it does, all within one
    // building's backlog. If the event-type filter were applied AFTER a
    // capped fetch (instead of in the WHERE clause), a 500-row page would be
    // entirely the excluded kind and the 3 that matter would never surface.
    const building = await seedBuilding();
    const rows = Array.from({ length: 600 }, (_, i) => {
      const seq = i + 1;
      return {
        buildingId: building.id,
        seq: BigInt(seq),
        event: seq > 597 ? 'closure_changed' : 'counters_updated',
        data: {},
      };
    });
    await prisma.realtimeEvent.createMany({ data: rows });

    const page = await replaySince(building.id, 0, { excludeEvents: ['counters_updated'] });

    expect(page.truncated).toBe(false);
    expect(page.events).toHaveLength(3);
    expect(page.events.every((e) => e.event === 'closure_changed')).toBe(true);
  });

  test('seeds lastSeq from the DB max on first use, so a restart cannot reissue an already-persisted seq', async () => {
    const building = await seedBuilding();
    // Simulate a prior process having gotten ahead of what a fresh
    // Date.now()-based counter would produce on its own.
    const aheadOfClock = Date.now() + 10_000_000;
    await prisma.realtimeEvent.create({
      data: { buildingId: building.id, seq: BigInt(aheadOfClock), event: 'closure_changed', data: {} },
    });

    // First use after "restart" (in-memory state was cleared) kicks off the
    // DB seed; nextSeq() itself must stay synchronous, so we wait for the
    // seed explicitly before asserting the corrected value.
    nextSeq(building.id, 'closure_changed');
    await _awaitSeedForTests(building.id);

    expect(nextSeq(building.id, 'closure_changed')).toBeGreaterThan(aheadOfClock);
  });

  test('purgeOlderThan removes rows past the window and keeps newer ones', async () => {
    const building = await seedBuilding();
    const old = await prisma.realtimeEvent.create({
      data: {
        buildingId: building.id,
        seq: 1n,
        event: 'closure_changed',
        data: {},
        createdAt: new Date(Date.now() - REALTIME_EVENT_RETENTION_MS - 60 * 1000),
      },
    });
    const recent = await prisma.realtimeEvent.create({
      data: { buildingId: building.id, seq: 2n, event: 'closure_changed', data: {} },
    });

    await purgeOlderThan(REALTIME_EVENT_RETENTION_MS);

    expect(await prisma.realtimeEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.realtimeEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});

describe('broadcaster: seq attached to every published frame', () => {
  afterEach(() => {
    closeAll();
    _resetForTests();
  });

  test('publish delivers to subscribers synchronously with a seq, before persistence settles', async () => {
    const building = await seedBuilding();
    const received = [];
    subscribe(building.id, (msg) => received.push(msg));

    publish(building.id, 'closure_changed', { edgeIds: ['e1'] });

    // Delivered synchronously, in the same tick as publish() — no await needed.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ event: 'closure_changed', data: { edgeIds: ['e1'] } });
    expect(typeof received[0].seq).toBe('number');

    await flush(building.id);
    const rows = await prisma.realtimeEvent.findMany({ where: { buildingId: building.id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].seq)).toBe(received[0].seq);
  });
});

describe('selectBufferedToForward: buffer dedup against replay', () => {
  test('keeps a buffered message whose own persist failed, even though a later seq was replayed', () => {
    // A: published live (buffered) but its DB write failed, so replay never
    // returns it. B: published after A, persisted fine, and IS returned by
    // replay. Comparing against a single high-water number (max replayed
    // seq = B) would wrongly treat A's seq as "covered" and drop it, even
    // though the buffer is the only place A's frame still exists.
    const buffered = [
      { event: 'closure_changed', data: { n: 'A' }, seq: 100 },
      { event: 'closure_changed', data: { n: 'B' }, seq: 101 },
    ];
    const replayedSeqs = new Set([101]); // only B was actually replayed

    const forwarded = selectBufferedToForward(buffered, { sinceSeqFloor: 0, replayedSeqs });

    // A must survive (it was never actually replayed); B must NOT be
    // duplicated (it genuinely was replayed already).
    expect(forwarded.map((m) => m.seq)).toEqual([100]);
  });

  test('drops a buffered message that replay already sent', () => {
    const buffered = [{ event: 'closure_changed', data: {}, seq: 50 }];
    const forwarded = selectBufferedToForward(buffered, {
      sinceSeqFloor: 0,
      replayedSeqs: new Set([50]),
    });
    expect(forwarded).toEqual([]);
  });

  test('drops anything at or below the original resume floor even if never replayed', () => {
    const buffered = [{ event: 'closure_changed', data: {}, seq: 5 }];
    const forwarded = selectBufferedToForward(buffered, {
      sinceSeqFloor: 10,
      replayedSeqs: new Set(),
    });
    expect(forwarded).toEqual([]);
  });

  test('forwards everything on a fresh connect with no resume (floor 0, nothing replayed)', () => {
    const buffered = [
      { event: 'closure_changed', data: {}, seq: 1 },
      { event: 'emergency_started', data: {}, seq: 2 },
    ];
    const forwarded = selectBufferedToForward(buffered, {});
    expect(forwarded.map((m) => m.seq)).toEqual([1, 2]);
  });
});

describe('heartbeat watermark: per stream type, not building-wide', () => {
  afterEach(() => {
    closeAll();
    _resetForTests();
  });

  test('the public stream heartbeat reports the highest PUBLIC-forwardable seq, not the building-wide one', async () => {
    const building = await seedBuilding();

    // The exact shape of a live emergency: a closure change, then member-
    // only counters ticking up afterward (every QR scan/recorded action)
    // with a HIGHER seq. currentSeq(buildingId) would report the counters
    // event's seq; a public client can never have seen that event (it is
    // never forwarded to the public stream) and so can never match it.
    const publicSeq = publish(building.id, 'closure_changed', { n: 1 });
    publish(building.id, 'counters_updated', { scanned: 1 });
    await flush(building.id);

    expect(currentSeq(building.id)).toBeGreaterThan(publicSeq);

    const { req, res, writes, triggerClose } = fakeReqRes();
    await openStream(req, res, building.id, { includeLogs: false, heartbeatIntervalMs: 10 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    triggerClose();

    const out = writes.join('');
    const match = out.match(/event: heartbeat\ndata: (.+)\n\n/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match[1]).seq).toBe(publicSeq);
  });

  test('the member feed heartbeat reports the building-wide seq, since it forwards everything', async () => {
    const building = await seedBuilding();
    const memberSeq = publish(building.id, 'counters_updated', { scanned: 1 });
    await flush(building.id);

    expect(currentPublicSeq(building.id)).toBeLessThan(memberSeq);

    const { req, res, writes, triggerClose } = fakeReqRes();
    await openStream(req, res, building.id, { includeLogs: true, heartbeatIntervalMs: 10 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    triggerClose();

    const out = writes.join('');
    const match = out.match(/event: heartbeat\ndata: (.+)\n\n/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match[1]).seq).toBe(memberSeq);
  });
});

describe('sseHelpers', () => {
  const fakeRes = () => {
    const writes = [];
    return {
      writes,
      write: (chunk) => writes.push(chunk),
    };
  };

  test('sendEvent writes an id line ahead of event/data when id is given', () => {
    const res = fakeRes();
    sendEvent(res, 'closure_changed', { a: 1 }, { id: 42 });
    const out = res.writes.join('');
    expect(out).toBe('id: 42\nevent: closure_changed\ndata: {"a":1}\n\n');
  });

  test('sendEvent omits the id line when no id is given', () => {
    const res = fakeRes();
    sendEvent(res, 'state', { ok: true });
    const out = res.writes.join('');
    expect(out.startsWith('id:')).toBe(false);
    expect(out).toBe('event: state\ndata: {"ok":true}\n\n');
  });

  test('startHeartbeat writes the ": hb" comment and a named heartbeat event with seq + serverTime', () => {
    jest.useFakeTimers();
    try {
      const res = fakeRes();
      const stop = startHeartbeat(res, 1000, { getSeq: () => 7 });

      jest.advanceTimersByTime(1000);
      stop();

      const out = res.writes.join('');
      expect(out).toContain(': hb\n\n');
      expect(out).toContain('event: heartbeat\ndata: ');
      const match = out.match(/event: heartbeat\ndata: (.+)\n\n/);
      const payload = JSON.parse(match[1]);
      expect(payload.seq).toBe(7);
      expect(typeof payload.serverTime).toBe('string');
    } finally {
      // MUST run even on assertion failure — leaked fake timers would starve
      // every setTimeout in the rest of this file (the HTTP tests' own
      // timeouts and server.close() included).
      jest.useRealTimers();
    }
  });
});

describe('realtime resume over HTTP (public status stream)', () => {
  let server;

  beforeEach(async () => {
    server = await startTestServer(app);
  });

  afterEach(async () => {
    closeAll();
    _resetForTests();
    // The SSE responses are kept alive deliberately; destroying the client
    // sockets on the test side isn't always enough for `server.close()`'s own
    // bookkeeping to see them gone in time, so force every connection shut
    // before closing — otherwise `close()` can wait indefinitely.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  test('Last-Event-ID replays only events after it, for that building', async () => {
    const building = await seedBuilding();
    const otherBuilding = await seedBuilding();

    publish(otherBuilding.id, 'closure_changed', { noise: true });
    const firstSeq = publish(building.id, 'closure_changed', { n: 1 });
    const secondSeq = publish(building.id, 'closure_changed', { n: 2 });
    await flush(building.id);
    await flush(otherBuilding.id);

    const { req, events } = await collectSseEvents(
      server,
      `/api/realtime/buildings/${building.id}/status`,
      { headers: { 'Last-Event-ID': String(firstSeq) }, count: 2 }
    );
    req.destroy();

    // Replay is sent BEFORE the fresh `state` snapshot (fix for issue #5:
    // `state` must be the last word, or a stale replayed frame could outlive
    // it), so the replayed closure_changed comes first, `state` last.
    const replayed = events.filter((e) => e.event === 'closure_changed');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].id).toBe(String(secondSeq));
    expect(replayed[0].data).toEqual({ n: 2 });
    expect(events[events.length - 1].event).toBe('state');
  });

  test('?sinceSeq replays only events after it, as a fallback for a manual reconnect', async () => {
    const building = await seedBuilding();
    const firstSeq = publish(building.id, 'closure_changed', { n: 1 });
    const secondSeq = publish(building.id, 'closure_changed', { n: 2 });
    await flush(building.id);

    const { req, events } = await collectSseEvents(
      server,
      `/api/realtime/buildings/${building.id}/status?sinceSeq=${firstSeq}`,
      { count: 2 }
    );
    req.destroy();

    const replayed = events.filter((e) => e.event === 'closure_changed');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].id).toBe(String(secondSeq));
    expect(events[events.length - 1].event).toBe('state');
  });

  // These two request TWO frames and assert what arrives SECOND, rather than
  // requesting one frame and asserting it's `state`. With replay now sent
  // before `state`, requesting only one frame doesn't actually pin the
  // guard: it happens to pass on old, buggy orderings too (where `state` was
  // unconditionally first regardless of whether replay incorrectly ran), so
  // it proves nothing about THIS guard specifically. Publishing a live frame
  // and checking it lands second — after `state`, with nothing from a wrongly
  // triggered replay ahead of it — pins it for real.
  test('an empty ?sinceSeq is treated as no resume point, not as sinceSeq=0', async () => {
    const building = await seedBuilding();
    // If an empty string were coerced to 0, this row would be replayed and
    // would arrive as the FIRST frame (replay is sent before `state`).
    await prisma.realtimeEvent.create({
      data: { buildingId: building.id, seq: 5n, event: 'closure_changed', data: { fromReplay: true } },
    });

    const promise = collectSseEvents(
      server,
      `/api/realtime/buildings/${building.id}/status?sinceSeq=`,
      { count: 2 }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const liveSeq = publish(building.id, 'closure_changed', { live: true });

    const { req, events } = await promise;
    req.destroy();

    expect(events[0].event).toBe('state');
    expect(events[1]).toMatchObject({
      event: 'closure_changed',
      id: String(liveSeq),
      data: { live: true },
    });
  });

  test('a whitespace-only ?sinceSeq is treated as no resume point, not coerced to sinceSeq=0', async () => {
    const building = await seedBuilding();
    // Number('   ') is 0, so without a trim this used to pass both guards
    // and trigger a full replay of the building's retained backlog.
    await prisma.realtimeEvent.create({
      data: { buildingId: building.id, seq: 5n, event: 'closure_changed', data: { fromReplay: true } },
    });

    const promise = collectSseEvents(
      server,
      `/api/realtime/buildings/${building.id}/status?sinceSeq=%20%20`,
      { count: 2 }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const liveSeq = publish(building.id, 'closure_changed', { live: true });

    const { req, events } = await promise;
    req.destroy();

    expect(events[0].event).toBe('state');
    expect(events[1]).toMatchObject({
      event: 'closure_changed',
      id: String(liveSeq),
      data: { live: true },
    });
  });

  test('a non-integer ?sinceSeq does not kill the stream — treated as no resume point', async () => {
    const building = await seedBuilding();

    // Previously: Number.isFinite(1.5) is true, so this reached
    // BigInt(1.5), which throws — after headers were already flushed, so
    // the response was never ended and the client hung forever, unable to
    // even reach the heartbeat that would tell it the stream was dead.
    const promise = collectSseEvents(
      server,
      `/api/realtime/buildings/${building.id}/status?sinceSeq=1.5`,
      { count: 2 }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const seq = publish(building.id, 'closure_changed', { live: true });

    const { req, events } = await promise;
    req.destroy();

    expect(events[0].event).toBe('state');
    expect(events[1]).toMatchObject({ event: 'closure_changed', id: String(seq) });
  });

  test('tells the client to resync when the replay backlog is bigger than one page', async () => {
    const building = await seedBuilding();
    await prisma.realtimeEvent.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        buildingId: building.id,
        seq: BigInt(i + 1),
        event: 'closure_changed',
        data: { n: i + 1 },
      })),
    });

    // 500 replayed frames + the resync signal, before `state` — no live
    // frame here, so nothing else lands ahead of that in the stream.
    const { req, events } = await collectSseEvents(
      server,
      `/api/realtime/buildings/${building.id}/status?sinceSeq=0`,
      { count: 501 }
    );
    req.destroy();

    expect(events).toHaveLength(501);
    expect(events.filter((e) => e.event === 'closure_changed')).toHaveLength(500);
    expect(events[500]).toMatchObject({ event: 'resync_required', data: { reason: 'replay_truncated' } });
  });

  test('the fresh snapshot outlives a stale replayed emergency frame', async () => {
    // A closure_changed replay was already covered above; this is the
    // scenario the review called out specifically: a replayed
    // emergency_started with no matching emergency_ended still in the
    // window would show a false evacuation banner if `state` were sent
    // first (or never re-sent) instead of last.
    const building = await seedBuilding();
    await prisma.realtimeEvent.create({
      data: {
        buildingId: building.id,
        seq: 1n,
        event: 'emergency_started',
        data: { emergencyId: 'stale', message: 'Fire', startedAt: new Date().toISOString() },
      },
    });

    const { req, events } = await collectSseEvents(
      server,
      `/api/realtime/buildings/${building.id}/status?sinceSeq=0`,
      { count: 2 }
    );
    req.destroy();

    expect(events[0].event).toBe('emergency_started');
    expect(events[1].event).toBe('state');
    // The building was never actually put into emergency mode, so the fresh
    // snapshot — sent last — corrects the stale replayed frame.
    expect(events[1].data.isEmergency).toBe(false);
  });

  test('every live frame carries an id equal to its seq', async () => {
    const building = await seedBuilding();

    const promise = collectSseEvents(server, `/api/realtime/buildings/${building.id}/status`, {
      count: 2, // state snapshot + one live frame
    });

    // Give the connection a moment to subscribe before publishing.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const seq = publish(building.id, 'closure_changed', { live: true });

    const { req, events } = await promise;
    req.destroy();

    const live = events.find((e) => e.event === 'closure_changed');
    expect(live).toBeDefined();
    expect(live.id).toBe(String(seq));
  });
});
