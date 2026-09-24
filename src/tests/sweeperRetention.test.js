import prisma from '../db/prisma.js';
import { createUser, createBuilding } from './helpers.js';
import { sweepOnce, AI_CONVERSATION_RETENTION_MS } from '../jobs/sweeper.js';

/* ============================================================================
   Retention for AI conversations.

   Ordinary transcripts are disposable — they exist for memory and budgeting,
   both of which only look back 24 hours. Conversations opened during an active
   emergency are not transcripts, they are the record of what the assistant
   told occupants while a building was being evacuated. Those are the one thing
   an operator cannot reconstruct from anywhere else, so the sweeper must never
   take them.
   ========================================================================= */

const AGED = new Date(Date.now() - AI_CONVERSATION_RETENTION_MS - 60 * 60 * 1000);

const seedConversation = async ({ buildingId, emergencyId = null, createdAt = new Date() }) => {
  const conversation = await prisma.aiConversation.create({
    data: { agentId: 'wayfinder', buildingId, emergencyId, createdAt, updatedAt: createdAt },
  });
  await prisma.aiMessage.create({
    data: { conversationId: conversation.id, role: 'user', content: 'where is the exit' },
  });
  return conversation;
};

describe('AI conversation retention', () => {
  test('sweeps an ordinary conversation past the retention window', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const stale = await seedConversation({ buildingId: building.id, createdAt: AGED });

    await sweepOnce();

    expect(await prisma.aiConversation.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  test('keeps an emergency conversation of the same age — it is the audit record', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const audit = await seedConversation({
      buildingId: building.id,
      emergencyId: 'emergency-123',
      createdAt: AGED,
    });

    await sweepOnce();

    const kept = await prisma.aiConversation.findUnique({ where: { id: audit.id } });
    expect(kept).not.toBeNull();
    expect(kept.emergencyId).toBe('emergency-123');
  });

  test('keeps a recent conversation', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const fresh = await seedConversation({ buildingId: building.id });

    await sweepOnce();

    expect(await prisma.aiConversation.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  test('sweeping a conversation takes its messages with it', async () => {
    const { user } = await createUser();
    const { building } = await createBuilding(user.id);
    const stale = await seedConversation({ buildingId: building.id, createdAt: AGED });

    await sweepOnce();

    expect(await prisma.aiMessage.count({ where: { conversationId: stale.id } })).toBe(0);
  });

  test('still sweeps expired verifications', async () => {
    const { user } = await createUser();
    const expired = await prisma.verification.create({
      data: {
        userId: user.id,
        type: '2fa',
        codeHash: 'hash',
        expiresAt: new Date(Date.now() - 60 * 1000),
      },
    });

    await sweepOnce();

    expect(await prisma.verification.findUnique({ where: { id: expired.id } })).toBeNull();
  });
});
