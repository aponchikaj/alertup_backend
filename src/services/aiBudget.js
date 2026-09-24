import prisma from '../db/prisma.js';

/* ============================================================================
   Daily AI budgets, scoped to what is actually being consumed.
   ----------------------------------------------------------------------------
   The per-IP limiters in rateLimiter.js stay, but only as burst anti-abuse.
   They cannot express a daily budget honestly: everyone on a building's own
   wifi leaves through one address, so a single IP budget is shared by every
   occupant and runs out fastest exactly when the building is busiest.
   emergencyActionLimiter already allows for shared NAT; the AI limiter did not.

   So the daily budget is per BUILDING for anonymous visitors (a busy building
   gets a budget proportional to itself, and cannot starve its neighbours) and
   per ACCOUNT for signed-in users (who carry their spend between buildings).
   ========================================================================= */

const DAY_MS = 24 * 60 * 60 * 1000;

export const AI_BUDGETS = Object.freeze({
  anonymousPerBuildingPerDay: 500,
  authenticatedPerUserPerDay: 200,
});

const verdict = (scope, used, limit) => ({ ok: used < limit, scope, used, limit });

/**
 * @param {{buildingId?: string|null, userId?: string|null, now?: Date}} scope
 * @returns {Promise<{ok: boolean, scope: 'user'|'building'|'none', used: number, limit: number}>}
 */
export async function checkAiBudget({ buildingId = null, userId = null, now = new Date() } = {}) {
  const since = new Date(now.getTime() - DAY_MS);

  // Only user turns are billed. Assistant replies and tool results are
  // consequences of a turn already paid for; counting them would make the
  // budget depend on how many tools the agent happened to call.
  const spent = (where) =>
    prisma.aiMessage.count({ where: { role: 'user', createdAt: { gte: since }, ...where } });

  // The account wins when both are known: a signed-in editor working across
  // several buildings should carry one budget, not one per building.
  if (userId) {
    return verdict('user', await spent({ conversation: { userId } }), AI_BUDGETS.authenticatedPerUserPerDay);
  }

  if (buildingId) {
    return verdict(
      'building',
      await spent({ conversation: { buildingId } }),
      AI_BUDGETS.anonymousPerBuildingPerDay
    );
  }

  // The public marketing assistant has neither: it is anonymous and belongs to
  // no building. The per-IP limiter is the only sensible boundary there.
  return { ok: true, scope: 'none', used: 0, limit: Infinity };
}
