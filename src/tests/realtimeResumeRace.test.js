import http from 'node:http';
import { jest } from '@jest/globals';

/* ============================================================================
   B15 fix round — the subscribe-vs-snapshot race.

   openStream() reads the emergency `state` snapshot before it starts
   forwarding live broadcaster events. If a frame is published in that gap —
   after the snapshot read starts, before the live subscription is actually
   delivering — it used to land in neither: not in the snapshot (already
   read), not live (not yet forwarding). This file pins that gap shut by
   controlling exactly when `getStatus` resolves, so a `publish()` fired
   while it's still pending deterministically lands in the race window.

   This needs its own file: `getStatus` is mocked module-wide via
   `jest.unstable_mockModule`, which would break every other suite that
   exercises `emergencyService.js` for real (trigger/resolve/recordAction).
   ========================================================================= */

let resolveStatus;
const pendingStatus = () =>
  new Promise((resolve) => {
    resolveStatus = resolve;
  });

const getStatus = jest.fn(() => pendingStatus());

// Other server.js route modules (emergency.routes.js, administration.js)
// also import from this module — stub their exports as no-ops so the app
// still wires up; this test never exercises those routes.
jest.unstable_mockModule('../features/emergency/emergencyService.js', () => ({
  getStatus,
  triggerEmergency: jest.fn(),
  resolveEmergency: jest.fn(),
  recordAction: jest.fn(),
}));

const { default: app } = await import('../../server.js');
const { default: prisma } = await import('../db/prisma.js');
const { createUser, createBuilding } = await import('./helpers.js');
const { publish, closeAll, subscriberCount, _closerCountForTests } = await import(
  '../features/realtime/broadcaster.js'
);
const { flush, _resetForTests } = await import('../features/realtime/eventLog.js');

const seedBuilding = async () => {
  const { user } = await createUser();
  const { building } = await createBuilding(user.id);
  return building;
};

const waitFor = async (predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

describe('openStream: nothing published during snapshot/replay setup is lost', () => {
  let server;

  beforeEach(async () => {
    getStatus.mockClear();
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
  });

  afterEach(async () => {
    closeAll();
    _resetForTests();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  test('a frame published while getStatus is still pending is delivered, not dropped', async () => {
    const building = await seedBuilding();
    const port = server.address().port;

    const events = [];
    let buffer = '';
    const req = http.get(
      { port, path: `/api/realtime/buildings/${building.id}/status` },
      (res) => {
        res.on('data', (chunk) => {
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
            if (eventName) {
              events.push({
                id,
                event: eventName,
                data: dataLines.length ? JSON.parse(dataLines.join('\n')) : undefined,
              });
            }
          }
        });
      }
    );

    // Wait until openStream has actually reached (and is blocked inside) the
    // getStatus() await -- this is the exact window subscribe() must already
    // be active for.
    await waitFor(() => getStatus.mock.calls.length > 0);

    const seq = publish(building.id, 'closure_changed', { duringRace: true });
    await flush(building.id);

    // Now let openStream continue past the snapshot read.
    resolveStatus({ isEmergency: false, message: null, emergencyId: null, startedAt: null, counters: null });

    await waitFor(() => events.some((e) => e.event === 'closure_changed'), { timeoutMs: 3000 });
    req.destroy();

    const delivered = events.find((e) => e.event === 'closure_changed');
    expect(delivered).toBeDefined();
    expect(delivered.data).toEqual({ duringRace: true });
    expect(delivered.id).toBe(String(seq));

    // And it must not have been silently dropped from the durable log either.
    const row = await prisma.realtimeEvent.findFirst({ where: { buildingId: building.id, seq: BigInt(seq) } });
    expect(row).not.toBeNull();
  });

  test('a client that disconnects mid-setup does not leak the heartbeat interval or the closer', async () => {
    const building = await seedBuilding();
    const port = server.address().port;

    const req = http.get({ port, path: `/api/realtime/buildings/${building.id}/status` }, () => {});
    // Destroying below happens before the server has sent a single byte
    // (it's still blocked on getStatus), which reliably raises a client-side
    // "socket hang up" error — expected and irrelevant to this test.
    req.on('error', () => {});

    await waitFor(() => getStatus.mock.calls.length > 0);

    // The client vanishes WHILE openStream is still blocked on getStatus —
    // before the real heartbeat interval/closer are ever installed.
    req.destroy();

    // Deterministic: unsubscribe() only runs inside cleanup(), so this
    // proves cleanup already ran against the still-no-op stopHeartbeat/
    // unregister placeholders, while openStream itself is still suspended.
    await waitFor(() => subscriberCount(building.id) === 0);

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    try {
      // Let openStream continue. It still runs to completion — cleanup()
      // having fired early doesn't abort the function — which is exactly
      // where the bug was: it would go on to install a REAL setInterval and
      // a REAL closer entry after cleanup() already ran, and nothing would
      // ever clear either of them again.
      resolveStatus({ isEmergency: false, message: null, emergencyId: null, startedAt: null, counters: null });

      // No further real async work happens after getStatus resolves for a
      // public (includeLogs: false) stream, so a short flush is enough.
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(_closerCountForTests()).toBe(0);
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });
});
