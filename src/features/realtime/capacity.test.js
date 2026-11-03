import { subscribe, atCapacity, makeRoom, closeAll, _setCapsForTests } from './broadcaster.js';

/* ============================================================================
   D15 (research 004) — a full building makes room instead of refusing.

   The old behaviour answered the NEWEST client with 503 once 200 streams were
   open, so whoever opened streams first (an attacker with a script) kept the
   slots and real occupants were pushed out. A per-IP cap is not an option —
   a building's Wi-Fi puts hundreds of real occupants behind one IP. Instead
   the newcomer takes the oldest slot of the IP holding the MOST slots; that
   stream is told to fall back to polling (which now always works). Squatting
   buys nothing, and a shared IP only loses slots when it holds the most.
   ========================================================================= */

afterEach(() => {
  closeAll();
  _setCapsForTests(null);
});

const open = (buildingId, ip, evicted) =>
  subscribe(buildingId, () => {}, { ip, onEvict: () => evicted.push(ip) });

test('a full building evicts the oldest stream of the IP holding the most slots', () => {
  _setCapsForTests({ perBuilding: 3, total: 100 });
  const evicted = [];
  open('b1', 'squatter', evicted);
  open('b1', 'squatter', evicted);
  open('b1', 'occupant', evicted);
  expect(atCapacity('b1')).toBe(true);

  expect(makeRoom('b1')).toBe(true);

  expect(evicted).toEqual(['squatter']);
  expect(atCapacity('b1')).toBe(false);
});

test('a server-wide cap evicts across buildings the same way', () => {
  _setCapsForTests({ perBuilding: 100, total: 3 });
  const evicted = [];
  open('b1', 'squatter', evicted);
  open('b2', 'squatter', evicted);
  open('b3', 'occupant', evicted);

  expect(makeRoom('b4')).toBe(true);

  expect(evicted).toEqual(['squatter']);
});

test('nothing is evicted when there is room', () => {
  _setCapsForTests({ perBuilding: 3, total: 100 });
  const evicted = [];
  open('b1', 'a', evicted);

  expect(makeRoom('b1')).toBe(true);
  expect(evicted).toEqual([]);
});

test('a stream with no eviction hook cannot be evicted, so the newcomer is refused', () => {
  _setCapsForTests({ perBuilding: 1, total: 100 });
  subscribe('b1', () => {});

  expect(makeRoom('b1')).toBe(false);
});
