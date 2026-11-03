// Server-Sent Events plumbing shared by the realtime and AI routes.

export const HEARTBEAT_INTERVAL_MS = 25000; // safely under proxy idle timeouts

export function initSse(res, { retryMs = 3000 } = {}) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  if (retryMs) res.write(`retry: ${retryMs}\n\n`);
}

/**
 * @param {object} [options]
 * @param {number|string} [options.id] SSE `id:` field — the frame's replay
 *   seq. Omitted for events that aren't part of the durable log (e.g. the
 *   initial `state` snapshot), so a client's Last-Event-ID never regresses.
 */
export function sendEvent(res, event, data, { id } = {}) {
  if (id !== undefined && id !== null) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sendData(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Comment-line heartbeat (doubles as dead-socket detection — a failed write
 * fires the response's error/close handlers) plus a named `heartbeat` event
 * carrying `{seq, serverTime}`. The client arms its staleness timer only
 * after the first named heartbeat, so this interval is load-bearing, not
 * cosmetic.
 *
 * `seq` is what lets a client notice it fell behind even before it
 * reconnects — but ONLY if the caller's `getSeq` returns a value that can
 * actually be ahead of what the client has seen, i.e. the building's true
 * current high-water sequence (see `eventLog.currentSeq`), not this one
 * connection's own last-sent id. A connection-local value would just mirror
 * whatever the client already has and could never signal a shortfall.
 *
 * @param {object} [options]
 * @param {() => number} [options.getSeq] returns the seq to report in this
 *   heartbeat; defaults to 0 when not provided.
 * @returns {() => void} stop
 */
export function startHeartbeat(res, intervalMs = HEARTBEAT_INTERVAL_MS, { getSeq } = {}) {
  const timer = setInterval(() => {
    try {
      res.write(': hb\n\n');
      sendEvent(res, 'heartbeat', {
        seq: getSeq ? getSeq() : 0,
        serverTime: new Date().toISOString(),
      });
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
