import prisma from '../db/prisma.js';
import { createUser, createBuilding } from './helpers.js';
import { AI_BUDGETS, checkAiBudget } from '../services/aiBudget.js';

/* ============================================================================
   Why budgets are not IP-shaped.

   aiDailyLimiter caps 150 requests/day per IP. Everyone on a building's own
   wifi leaves through one address, so in a busy building that single budget is
   shared by every occupant — and it runs out fastest exactly when the building
   is busiest. emergencyActionLimiter already allows for shared NAT (30/min,
   with a comment saying so); the AI limiter never did.

   So the daily budget is scoped to the thing actually being consumed: the
   building for anonymous visitors, the account for signed-in users. The
   per-IP burst limiter stays, but only as anti-abuse.
   ========================================================================= */

/** Record `count` user turns against a scope, optionally backdated. */
const seedUsage = async (count, { buildingId = null, userId = null, agedHours = 0 } = {}) => {
  const at = new Date(Date.now() - agedHours * 60 * 60 * 1000);
  const conversation = await prisma.aiConversation.create({
    data: { agentId: 'wayfinder', buildingId, userId, createdAt: at },
  });
  await prisma.aiMessage.createMany({
    data: Array.from({ length: count }, () => ({
      conversationId: conversation.id,
      role: 'user',
      content: 'where is the pharmacy',
      createdAt: at,
    })),
  });
  return conversation;
};

describe('anonymous visitors are budgeted per building', () => {
  test('allows a visitor while the building is under budget', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    await seedUsage(3, { buildingId: building.id });

    const result = await checkAiBudget({ buildingId: building.id });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe('building');
    expect(result.used).toBe(3);
  });

  test('denies once the building has spent its daily budget', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    await seedUsage(AI_BUDGETS.anonymousPerBuildingPerDay, { buildingId: building.id });

    const result = await checkAiBudget({ buildingId: building.id });

    expect(result.ok).toBe(false);
    expect(result.scope).toBe('building');
  });

  test('one building exhausting its budget does not starve another', async () => {
    const { user } = await createUser();
    const { building: busy } = await createBuilding(user.id);
    const { building: quiet } = await createBuilding(user.id);
    await seedUsage(AI_BUDGETS.anonymousPerBuildingPerDay, { buildingId: busy.id });

    expect((await checkAiBudget({ buildingId: busy.id })).ok).toBe(false);
    expect((await checkAiBudget({ buildingId: quiet.id })).ok).toBe(true);
  });

  test('yesterday does not count against today', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    await seedUsage(AI_BUDGETS.anonymousPerBuildingPerDay, {
      buildingId: building.id,
      agedHours: 25,
    });

    const result = await checkAiBudget({ buildingId: building.id });

    expect(result.ok).toBe(true);
    expect(result.used).toBe(0);
  });
});

describe('signed-in users are budgeted per account', () => {
  test('a user is budgeted across buildings, not per building', async () => {
    const { user } = await createUser();
    const { building: a } = await createBuilding(user.id);
    await seedUsage(AI_BUDGETS.authenticatedPerUserPerDay, {
      buildingId: a.id,
      userId: user.id,
    });

    const { building: b } = await createBuilding(user.id);
    const result = await checkAiBudget({ buildingId: b.id, userId: user.id });

    expect(result.ok).toBe(false);
    expect(result.scope).toBe('user');
  });

  test("one user's spend does not count against another's", async () => {
    const { user: heavy } = await createUser();
    const { user: light } = await createUser();
    const { building } = await createBuilding(heavy.id);
    await seedUsage(AI_BUDGETS.authenticatedPerUserPerDay, {
      buildingId: building.id,
      userId: heavy.id,
    });

    expect((await checkAiBudget({ buildingId: building.id, userId: heavy.id })).ok).toBe(false);
    expect((await checkAiBudget({ buildingId: building.id, userId: light.id })).ok).toBe(true);
  });
});

describe('what counts as spend', () => {
  test('only user turns are billed, not assistant replies or tool results', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const conversation = await seedUsage(1, { buildingId: building.id });
    await prisma.aiMessage.createMany({
      data: [
        { conversationId: conversation.id, role: 'assistant', content: 'the pharmacy is on 2' },
        { conversationId: conversation.id, role: 'tool', content: '{"pois":[]}' },
      ],
    });

    const result = await checkAiBudget({ buildingId: building.id });

    expect(result.used).toBe(1);
  });

  test('a surface with no building and no user is left to the IP limiter', async () => {
    const result = await checkAiBudget({});

    expect(result.ok).toBe(true);
    expect(result.scope).toBe('none');
  });
});
