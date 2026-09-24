/**
 * Fire-and-forget analytics queue.
 *
 * Any write that is a side effect of an anonymous, public read — logging a
 * POI search (this slice), a route request (B13), or persisting a realtime
 * event (B15) — must never be able to fail the request it rides along with,
 * and must never become a bare floating promise the process can silently
 * unhandled-reject on. `enqueue`/`drain` is the one seam every one of those
 * callers goes through instead of rolling its own try/catch-and-ignore.
 *
 *   enqueue('search-event', () => prisma.searchEvent.create({ data }));
 *
 * Contract:
 *  - `label` identifies the caller in the failure log only — it carries no
 *    behaviour.
 *  - `fn` is invoked on a microtask, never synchronously in the caller's own
 *    stack frame, so a route handler can call `enqueue(...)` and return its
 *    response immediately without waiting on the write.
 *  - Whatever `fn` returns (sync value, promise, thrown error, rejection) is
 *    fully absorbed here. A failure is logged with `label` and swallowed; it
 *    never throws into the caller and never surfaces as an unhandled
 *    rejection.
 *  - Every in-flight task is tracked until it settles, so `drain()` gives
 *    tests a deterministic way to wait for all outstanding writes (including
 *    ones a task itself enqueues) before asserting on the database.
 */

const pending = new Set();

/**
 * Schedule `fn` to run without blocking or being able to fail the caller.
 * @param {string} label short, stable name for this kind of write (used only in error logs)
 * @param {() => any} fn the work to run — may be sync or return a Promise
 * @returns {Promise<void>} resolves once `fn` has settled (success or swallowed failure);
 *   callers are not expected to await this — it exists mainly so `drain()` can.
 */
export function enqueue(label, fn) {
  const task = Promise.resolve()
    .then(() => fn())
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[analyticsQueue] task "${label}" failed:`, err);
    });
  pending.add(task);
  task.finally(() => pending.delete(task));
  return task;
}

/**
 * TEST-ONLY. Not for use in route/handler code.
 *
 * Wait for every currently-tracked task to settle. Loops because a task can
 * itself `enqueue` another task while draining is in progress.
 *
 * This exists so a test can force a deterministic point where every
 * outstanding analytics write has landed before asserting on the database.
 * A request handler must never await it: that would turn a fire-and-forget
 * write back into something the response waits on, and would block on every
 * OTHER caller's in-flight tasks too, not just its own. B13 and B15 should
 * each `enqueue(...)` their own write the same way this file's callers do,
 * not reach for `drain()`.
 */
export async function drain() {
  while (pending.size > 0) {
    await Promise.allSettled(Array.from(pending));
  }
}
