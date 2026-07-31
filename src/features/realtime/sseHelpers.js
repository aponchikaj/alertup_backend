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

export function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sendData(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Comment-line heartbeat; doubles as dead-socket detection (a failed write
 * fires the response's error/close handlers).
 * @returns {() => void} stop
 */
export function startHeartbeat(res, intervalMs = HEARTBEAT_INTERVAL_MS) {
  const timer = setInterval(() => {
    try {
      res.write(': hb\n\n');
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
