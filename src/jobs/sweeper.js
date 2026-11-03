import prisma from '../db/prisma.js';
import { purgeOlderThan as purgeRealtimeEvents } from '../features/realtime/eventLog.js';

// Replaces the Mongo TTL index on verifications. Lookups already filter
// expiresAt > now(); this sweep is hygiene so expired rows don't accumulate.
// Idempotent deletes make it safe under multiple instances.

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const STALE_INVITE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// AI transcripts exist for memory and budgeting, and both only look back 24
// hours, so a month is already generous. Conversations opened during an active
// emergency are exempt — see below.
export const AI_CONVERSATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// `SearchEvent.query` is raw, visitor-typed search text with no bound before
// this. In a hospital, clinic or government building that text is a sensitive
// category on its own, and paired with a timestamp it is quasi-identifying
// even without an IP attached — a low-traffic site's search log can single
// out who searched for what and when. 30 days matches the AI conversation
// window above: enough for an owner to review a month of search-quality
// trends (what visitors couldn't find), short enough to bound how long that
// text sits around.
export const SEARCH_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// FX-019: registration does not prove the registrant owns the address, so an
// account that never verifies its email would otherwise hold that address
// forever — blocking the real owner from signing up or accepting an invite.
// After a week unverified, an account that holds nothing (no buildings,
// memberships or sent invites) is removed and the address is free again.
export const UNVERIFIED_ACCOUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// FX-054: retention for every table that grows with traffic. Audit rows
// (Log.entity set) and emergency logs are the incident record — never swept
// here; they leave only with their building, via IncidentArchive (D3).
export const ROUTE_REQUEST_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const SYSTEM_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const ENDED_CLOSURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const SCAN_EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const INBOX_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

const before = (now, ms) => new Date(now.getTime() - ms);

async function sweep() {
  const now = new Date();
  try {
    await prisma.verification.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    // A revocation outlives its token by nothing: once the JWT's own exp has
    // passed it is rejected regardless (FX-083).
    await prisma.revokedToken.deleteMany({
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
    // Old AI conversations, messages following by cascade.
    //
    // emergencyId is null on an ordinary transcript and set on one opened
    // while a building was being evacuated. The second kind is the only record
    // of what the assistant told occupants during an incident, so it is never
    // swept — it lives until the building itself is deleted.
    await prisma.aiConversation.deleteMany({
      where: {
        emergencyId: null,
        createdAt: { lt: new Date(now.getTime() - AI_CONVERSATION_RETENTION_MS) },
      },
    });
    // Sensitive-text retention (see SEARCH_EVENT_RETENTION_MS above).
    await prisma.searchEvent.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - SEARCH_EVENT_RETENTION_MS) } },
    });
    // Squatted / abandoned sign-ups (see UNVERIFIED_ACCOUNT_TTL_MS above).
    await prisma.user.deleteMany({
      where: {
        verified: false,
        createdAt: { lt: new Date(now.getTime() - UNVERIFIED_ACCOUNT_TTL_MS) },
        ownedBuildings: { none: {} },
        memberships: { none: {} },
        invitesSent: { none: {} },
      },
    });
    // Traffic-proportional tables (FX-054, constants above).
    await prisma.routeRequest.deleteMany({ where: { createdAt: { lt: before(now, ROUTE_REQUEST_RETENTION_MS) } } });
    await prisma.log.deleteMany({
      where: { entity: null, isEmergency: false, createdAt: { lt: before(now, SYSTEM_LOG_RETENTION_MS) } },
    });
    await prisma.closure.deleteMany({ where: { endsAt: { lt: before(now, ENDED_CLOSURE_RETENTION_MS) } } });
    await prisma.scanEvent.deleteMany({ where: { scannedAt: { lt: before(now, SCAN_EVENT_RETENTION_MS) } } });
    await prisma.contact.deleteMany({ where: { createdAt: { lt: before(now, INBOX_RETENTION_MS) } } });
    await prisma.report.deleteMany({ where: { createdAt: { lt: before(now, INBOX_RETENTION_MS) } } });
    // Durable SSE replay backlog — see eventLog.js for the retention window.
    await purgeRealtimeEvents();
  } catch (err) {
    console.error('Sweeper error:', err.message);
  }
}

/** Run one sweep now. Used by startSweeper's timers and by operators/tests. */
export const sweepOnce = sweep;

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
