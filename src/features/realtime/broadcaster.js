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

// TEST-ONLY override of the two caps above (null restores them).
let capsOverride = null;
export function _setCapsForTests(caps) {
  capsOverride = caps;
}
const capPerBuilding = () => capsOverride?.perBuilding ?? MAX_SUBSCRIBERS_PER_BUILDING;
const capTotal = () => capsOverride?.total ?? MAX_SUBSCRIBERS_TOTAL;

export function atCapacity(buildingId) {
  return (
    totalSubscribers >= capTotal() ||
    (perBuilding.get(String(buildingId)) || 0) >= capPerBuilding()
  );
}

/* D15 (research 004): every open stream's slot, so a full building can make
   room instead of refusing the newest client. Insertion order = age. */
const slots = new Set();

/**
 * Free one slot for a newcomer when `buildingId` (or the whole server) is
 * full: evict the OLDEST stream of the IP holding the MOST slots in the full
 * scope. Squatting slots therefore buys nothing, while a building's shared
 * Wi-Fi only loses a slot when it is the biggest holder. The evicted stream
 * is told to fall back to polling, which always works.
 *
 * @returns {boolean} true when there is (now) room; false when nothing
 *   evictable was found and the newcomer must be refused.
 */
export function makeRoom(buildingId) {
  if (!atCapacity(buildingId)) return true;
  const id = String(buildingId);
  const buildingFull = (perBuilding.get(id) || 0) >= capPerBuilding();
  const candidates = [...slots].filter((slot) => slot.onEvict && (!buildingFull || slot.buildingId === id));
  if (candidates.length === 0) return false;

  const perIp = new Map();
  for (const slot of candidates) perIp.set(slot.ip, (perIp.get(slot.ip) || 0) + 1);
  let topIp = null;
  let topCount = 0;
  for (const [ip, count] of perIp) {
    if (count > topCount) {
      topIp = ip;
      topCount = count;
    }
  }
  const victim = candidates.find((slot) => slot.ip === topIp);
  victim.evict();
  return !atCapacity(buildingId);
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
export function subscribe(buildingId, listener, { ip = null, onEvict = null } = {}) {
  const key = channelKey(buildingId);
  const id = String(buildingId);
  emitter.on(key, listener);
  perBuilding.set(id, (perBuilding.get(id) || 0) + 1);
  totalSubscribers += 1;

  let active = true;
  const slot = {
    buildingId: id,
    ip,
    onEvict,
    // Evicting always releases the slot, whatever the stream does with the
    // notice — a newcomer must never be left waiting on a slow socket.
    evict() {
      try {
        onEvict?.();
      } finally {
        unsubscribe();
      }
    },
  };
  slots.add(slot);

  return unsubscribe;
  function unsubscribe() {
    if (!active) return;
    active = false;
    slots.delete(slot);
    emitter.off(key, listener);
    const remaining = (perBuilding.get(id) || 1) - 1;
    if (remaining <= 0) perBuilding.delete(id);
    else perBuilding.set(id, remaining);
    totalSubscribers = Math.max(0, totalSubscribers - 1);
    emitter.emit(`unsubscribed:${key}`);
  }
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
  slots.clear();
  totalSubscribers = 0;
}

/** TEST-ONLY. Number of closers currently registered — used to prove a
 *  connection that tore itself down early didn't leak an entry that nothing
 *  will ever call or remove. */
export function _closerCountForTests() {
  return closers.size;
}
