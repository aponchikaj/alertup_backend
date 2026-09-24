import { jest } from '@jest/globals';
import { enqueue, drain } from './analyticsQueue.js';

/**
 * Pure unit tests for the fire-and-forget analytics queue — no database, no
 * Express. `enqueue`/`drain` are a cross-feature seam (search logging here,
 * route-request logging in B13, realtime-event persistence in B15), so its
 * failure behaviour is tested in isolation from any one caller.
 */
describe('analyticsQueue', () => {
  test('enqueue does not run fn synchronously; drain waits for it to finish', async () => {
    let ran = false;
    enqueue('test-task', async () => {
      ran = true;
    });
    // Scheduled, not executed inline in the caller's stack.
    expect(ran).toBe(false);

    await drain();
    expect(ran).toBe(true);
  });

  test('a synchronously-throwing fn never throws out of enqueue', () => {
    expect(() => {
      enqueue('sync-throw', () => {
        throw new Error('boom');
      });
    }).not.toThrow();
  });

  test('a rejected fn is swallowed — drain resolves, nothing escapes as an unhandled rejection', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    enqueue('rejects', () => Promise.reject(new Error('db is down')));
    await expect(drain()).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('rejects'),
      expect.any(Error)
    );
    errSpy.mockRestore();
  });

  test('drain resolves immediately when nothing is pending', async () => {
    await expect(drain()).resolves.toBeUndefined();
  });

  test('drain waits for a task enqueued by another task still in flight', async () => {
    const order = [];
    enqueue('outer', async () => {
      order.push('outer-start');
      enqueue('inner', async () => {
        order.push('inner');
      });
      order.push('outer-end');
    });
    await drain();
    expect(order).toEqual(['outer-start', 'outer-end', 'inner']);
  });
});
