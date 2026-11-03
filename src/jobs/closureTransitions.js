import prisma from '../db/prisma.js';
import { publish } from '../features/realtime/broadcaster.js';
import { closureChangedEvent, invalidateClosures } from '../features/wayfinding/closures.js';

/*
 * Scheduled closures take and leave effect on their own clock. Routing already
 * honours that (getActiveClosures filters by time on every read), but open
 * scan pages only re-route when told, so each transition is announced here
 * (BE-28 follow-up).
 */

const TICK_MS = 15 * 1000;

/**
 * Announce every closure whose start or end fell in (since, now]. A start is
 * only announced when it was scheduled (startsAt after createdAt): a closure
 * that starts on creation was already announced by the editor write.
 */
export async function announceClosureTransitions(since, now = new Date()) {
  const window = { gt: since, lte: now };
  const [started, ended] = await Promise.all([
    prisma.closure.findMany({ where: { startsAt: window } }),
    prisma.closure.findMany({ where: { endsAt: window } }),
  ]);
  const events = [
    ...started.filter((row) => row.startsAt > row.createdAt).map((row) => [row, 'started']),
    ...ended.map((row) => [row, 'ended']),
  ];
  for (const [row, action] of events) {
    invalidateClosures(row.buildingId);
    publish(row.buildingId, 'closure_changed', closureChangedEvent(row, action));
  }
  return events.length;
}

let timer = null;

export function startClosureTransitions() {
  if (timer) return;
  let last = new Date();
  timer = setInterval(async () => {
    const now = new Date();
    try {
      await announceClosureTransitions(last, now);
      last = now;
    } catch (err) {
      // Keep `last` so the next tick retries this window.
      console.error('Closure transition tick failed:', err.message);
    }
  }, TICK_MS);
  timer.unref?.();
}

export function stopClosureTransitions() {
  clearInterval(timer);
  timer = null;
}
