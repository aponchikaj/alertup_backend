import { EventEmitter } from 'node:events';
import { nextSeq, append } from './eventLog.js';

// In-process pub/sub, one channel per building. All emergency/log writers
// publish here after their DB write commits; SSE routes subscribe.
//
// Single-instance deployment today makes this authoritative. Scale path: swap
// the EventEmitter internals for Postgres LISTEN/NOTIFY behind the same
// publish/subscribe API — nothing above this module changes.

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const channelKey = (buildingId) => `building:${buildingId}`;

// Connection accounting for SSE caps.
const perBuilding = new Map();
let totalSubscribers = 0;

export const MAX_SUBSCRIBERS_PER_BUILDING = 200;
export const MAX_SUBSCRIBERS_TOTAL = 1000;

export function subscriberCount(buildingId) {
  return buildingId ? perBuilding.get(String(buildingId)) || 0 : totalSubscribers;
}

export function atCapacity(buildingId) {
  return (
    totalSubscribers >= MAX_SUBSCRIBERS_TOTAL ||
    (perBuilding.get(String(buildingId)) || 0) >= MAX_SUBSCRIBERS_PER_BUILDING
  );
}

/**
 * Emit first, persist asynchronously: live subscribers get the frame
 * immediately with an in-memory monotonic seq attached, and the durable
 * write to `RealtimeEvent` (for `Last-Event-ID`/`?sinceSeq` replay) happens
 * after, ordered per-building — see eventLog.js for why. A lost persist only
 * degrades replay for a reconnecting client; it never delays or fails this
 * broadcast.
 *
 * @param {string} buildingId
 * @param {string} event   e.g. 'emergency_started'
 * @param {object} data    JSON-serializable payload
 * @returns {number} the seq assigned to this frame
 */
export function publish(buildingId, event, data = {}) {
  const seq = nextSeq(buildingId, event);
  emitter.emit(channelKey(buildingId), { event, data, seq });
  append(buildingId, seq, event, data);
  return seq;
}

/**
 * @param {string} buildingId
 * @param {(msg: {event: string, data: object}) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribe(buildingId, listener) {
  const key = channelKey(buildingId);
  const id = String(buildingId);
  emitter.on(key, listener);
  perBuilding.set(id, (perBuilding.get(id) || 0) + 1);
  totalSubscribers += 1;

  let active = true;
  return function unsubscribe() {
    if (!active) return;
    active = false;
    emitter.off(key, listener);
    const remaining = (perBuilding.get(id) || 1) - 1;
    if (remaining <= 0) perBuilding.delete(id);
    else perBuilding.set(id, remaining);
    totalSubscribers = Math.max(0, totalSubscribers - 1);
    emitter.emit(`unsubscribed:${key}`);
  };
}

const closers = new Set();

/** SSE routes register a closer so SIGTERM can end open streams cleanly. */
export function registerCloser(close) {
  closers.add(close);
  return () => closers.delete(close);
}

export function closeAll() {
  for (const close of [...closers]) {
    try {
      close();
    } catch {
      // stream already gone
    }
  }
  closers.clear();
  emitter.removeAllListeners();
  perBuilding.clear();
  totalSubscribers = 0;
}

/** TEST-ONLY. Number of closers currently registered — used to prove a
 *  connection that tore itself down early didn't leak an entry that nothing
 *  will ever call or remove. */
export function _closerCountForTests() {
  return closers.size;
}
