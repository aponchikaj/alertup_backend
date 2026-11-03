/**
 * Process-level safety net (FX-044).
 *
 * Node crashes the process on an unhandled promise rejection. This backend
 * runs on ONE Fly machine and holds every live emergency stream in memory,
 * so a crash drops every occupant's feed at once. A rejection nobody awaited
 * is a bug to fix, not a reason to evacuate the server: log it and keep
 * serving.
 *
 * Uncaught synchronous exceptions are deliberately left to Node's default
 * (exit): after one of those the process state is unknown, and Fly restarts
 * the machine.
 */
const installed = new WeakSet();

export function installProcessGuards({ target = process, log = console.error } = {}) {
  if (installed.has(target)) return;
  installed.add(target);

  target.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
    log('Unhandled promise rejection (server kept running):', detail);
  });
}
