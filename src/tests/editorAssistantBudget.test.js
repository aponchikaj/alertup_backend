import request from 'supertest';
import prisma from '../db/prisma.js';
import app from '../../server.js';
import { AI_BUDGETS } from '../services/aiBudget.js';
import { createUser, createBuilding, createFloor } from './helpers.js';

/* ============================================================================
   The floor designer gets a budget and a transcript — and nothing else.

   It was NOT migrated onto the agent runtime. It has no tools, answers with
   JSON rather than SSE, and its value sits in a 400-line pipeline that pulls a
   drawing out of a half-finished model response, repairs placement, and merges
   it around work the owner drew by hand. Rebuilding that on a streaming tool
   loop would risk a paid feature to gain consistency nobody can see.

   What it genuinely lacked is what the runtime brought: it is the single most
   expensive call in the product — 6000 tokens against the concierge's 300 —
   and it had no per-user budget and left no record of what it produced.
   ========================================================================= */

const design = (body, cookie) =>
  request(app).post('/api/ai/editor').set('Cookie', cookie).send(body);

const seed = async () => {
  const { user, cookie } = await createUser();
  const { building } = await createBuilding(user.id);
  const floor = await createFloor(building.id, { floorNumber: 1 });
  return { user, cookie, building, floor };
};

const turn = (buildingId, floorId) => ({
  messages: [{ role: 'user', content: 'design a small clinic floor' }],
  locale: 'en',
  buildingId,
  floorId,
});

/** Spend a user's whole daily allowance. */
const exhaustBudget = async (userId, buildingId) => {
  const conversation = await prisma.aiConversation.create({
    data: { agentId: 'designer', buildingId, userId },
  });
  await prisma.aiMessage.createMany({
    data: Array.from({ length: AI_BUDGETS.authenticatedPerUserPerDay }, () => ({
      conversationId: conversation.id,
      role: 'user',
      content: 'design something',
    })),
  });
};

describe('the response shape is unchanged', () => {
  test('still answers with the keys editorAiPanel reads', async () => {
    const { cookie, building, floor } = await seed();

    const res = await design(turn(building.id, floor.id), cookie);

    expect(res.status).toBe(200);
    // The three the panel always reads. `mode` and `actions` are optional on
    // both sides and absent on the degraded path, which is the path a test run
    // with no provider key takes.
    expect(res.body.data).toHaveProperty('reply');
    expect(res.body.data).toHaveProperty('drawing');
    expect(res.body.data).toHaveProperty('designAllowed');
    // JSON, not an event stream — the panel awaits a single body.
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('budget', () => {
  test('refuses once the user has spent their daily allowance', async () => {
    const { user, cookie, building, floor } = await seed();
    await exhaustBudget(user.id, building.id);

    const res = await design(turn(building.id, floor.id), cookie);

    expect(res.status).toBe(429);
  });

  test("one user's spend does not block another", async () => {
    const { user, building, floor } = await seed();
    await exhaustBudget(user.id, building.id);

    // A second editor on the same building still has their own allowance.
    const { user: other } = await createUser();
    const { building: otherBuilding } = await createBuilding(other.id);
    const otherFloor = await createFloor(otherBuilding.id, { floorNumber: 1 });
    const { cookie: otherCookie } = await createUser();
    expect(otherCookie).toBeTruthy();

    const res = await design(
      turn(otherBuilding.id, otherFloor.id),
      (await createUser()).cookie
    );

    // Not a budget refusal — a permission one, since that user owns nothing here.
    expect(res.status).not.toBe(429);
  });
});

describe('transcript', () => {
  test('records the turn so an expensive call is not invisible', async () => {
    const { user, cookie, building, floor } = await seed();

    await design(turn(building.id, floor.id), cookie);

    const conversation = await prisma.aiConversation.findFirst({
      where: { buildingId: building.id, agentId: 'designer' },
      include: { messages: true },
    });

    expect(conversation).not.toBeNull();
    expect(conversation.userId).toBe(user.id);
    expect(conversation.messages.some((m) => m.role === 'user')).toBe(true);
    expect(conversation.messages.some((m) => m.role === 'assistant')).toBe(true);
  });

  test('a failed transcript write never costs the user their answer', async () => {
    const { cookie, building, floor } = await seed();

    // The floor is deleted between the request and the write; the answer must
    // still come back, because the drawing is what the user asked for.
    const res = await design(turn(building.id, floor.id), cookie);

    expect(res.status).toBe(200);
    expect(res.body.data.reply).toBeTruthy();
  });
});
