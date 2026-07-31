import prisma from '../db/prisma.js';

// Replaces the Mongo TTL index on verifications. Lookups already filter
// expiresAt > now(); this sweep is hygiene so expired rows don't accumulate.
// Idempotent deletes make it safe under multiple instances.

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const STALE_INVITE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function sweep() {
  const now = new Date();
  try {
    await prisma.verification.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    // Expired PENDING invites older than ~30 days; expiry itself is derived
    // from expiresAt at read time, this is just cleanup.
    await prisma.buildingInvite.deleteMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: new Date(now.getTime() - STALE_INVITE_AGE_MS) },
      },
    });
  } catch (err) {
    console.error('Sweeper error:', err.message);
  }
}

let timer = null;

export function startSweeper() {
  if (timer) return;
  timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref?.();
  // One pass shortly after boot to clear anything left from downtime.
  setTimeout(sweep, 30 * 1000).unref?.();
}

export function stopSweeper() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
