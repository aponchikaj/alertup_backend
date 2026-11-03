import { jest } from '@jest/globals';
import { installProcessGuards } from '../utils/processGuards.js';

/* ============================================================================
   FX-044 — one stray rejected promise must not restart the only machine.

   Node's default for an unhandled rejection is to crash the process. AlertUp
   runs on exactly one Fly machine, and every live emergency feed is held in
   that process, so a crash drops every occupant's stream at once. A rejection
   nobody awaited is logged and the server keeps serving.
   ========================================================================= */

test('logs an unhandled rejection instead of crashing', () => {
  const target = { listeners: {}, on(event, fn) { this.listeners[event] = fn; } };
  const log = jest.fn();

  installProcessGuards({ target, log });
  target.listeners.unhandledRejection(new Error('boom'), Promise.resolve());

  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('Unhandled promise rejection'),
    expect.stringContaining('boom')
  );
});

test('installs once, however often it is called', () => {
  const on = jest.fn();
  const target = { on };

  installProcessGuards({ target, log: jest.fn() });
  installProcessGuards({ target, log: jest.fn() });

  expect(on).toHaveBeenCalledTimes(1);
});
