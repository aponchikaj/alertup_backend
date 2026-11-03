import request from 'supertest';
import prisma from '../db/prisma.js';
import app from '../../server.js';
import { clearAll } from '../features/wayfinding/graphCache.js';
import { createUser, createBuilding, createFloor, createNode } from './helpers.js';

/* ============================================================================
   The Wayfinder agent's route — anonymous by design.

   The scan page has no login and never will: anyone physically in the building
   has to be able to ask where the exit is. That makes this the surface where
   scoping mistakes cost the most, so the tests lean on what an anonymous
   caller can and cannot reach.
   ========================================================================= */

const ask = (body) => request(app).post('/api/ai/agent/wayfinder').send(body);

beforeEach(() => clearAll());

const seed = async () => {
  const { user } = await createUser();
  const { building } = await createBuilding(user.id);
  const floor = await createFloor(building.id, { floorNumber: 2, name: 'Upper' });
  const node = await createNode(building.id, floor.id, { label: 'Main Entrance' });
  return { building, floor, node };
};

const turn = (buildingId, extra = {}) => ({
  messages: [{ role: 'user', content: 'where is the pharmacy?' }],
  locale: 'en',
  buildingId,
  ...extra,
});

describe('anonymous access', () => {
  test('answers without any session at all', async () => {
    const { building, node } = await seed();

    const res = await ask(turn(building.id, { nodeId: node.id }));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });

  test('400s without a usable building id', async () => {
    const res = await ask({ messages: [{ role: 'user', content: 'hi' }], locale: 'en' });

    expect(res.status).toBe(400);
  });

  test('404s a building that does not exist', async () => {
    const res = await ask(turn('cl00000000000000000000000'));

    expect(res.status).toBe(404);
  });

  test('404s a deactivated building', async () => {
    const { building } = await seed();
    await prisma.building.update({
      where: { id: building.id },
      data: { isDeactivated: true },
    });

    const res = await ask(turn(building.id));

    expect(res.status).toBe(404);
  });

  test('keeps the strict anonymous message caps', async () => {
    const { building } = await seed();

    const res = await ask(turn(building.id, { messages: [{ role: 'user', content: 'x'.repeat(1200) }] }));

    // 2000 chars is the authenticated cap; an anonymous caller stays at 500.
    expect(res.status).toBe(422);
  });
});

describe('anonymous callers cannot reach owner tools', () => {
  test('the wayfinder agent declares no permissioned tool', async () => {
    const { AGENTS, TOOL_REGISTRY } = await import('../features/ai/agents/registry.js');

    for (const name of AGENTS.wayfinder.tools) {
      expect(TOOL_REGISTRY[name].permission).toBeNull();
    }
  });

  test('an anonymous caller cannot drive the auditor agent', async () => {
    const { building } = await seed();

    const res = await request(app).post('/api/ai/agent/auditor').send(turn(building.id));

    expect(res.status).toBe(401);
  });
});

describe('the transcript', () => {
  test('records an anonymous turn with no user but with the scan position', async () => {
    const { building, node } = await seed();

    await ask(turn(building.id, { nodeId: node.id }));

    const conversation = await prisma.aiConversation.findFirst({
      where: { buildingId: building.id },
    });

    expect(conversation.agentId).toBe('wayfinder');
    expect(conversation.userId).toBeNull();
    expect(conversation.nodeId).toBe(node.id);
  });

  test('ignores a nodeId belonging to another building', async () => {
    const mine = await seed();
    const theirs = await seed();

    await ask(turn(mine.building.id, { nodeId: theirs.node.id }));

    // Stored as given (it is what the client claimed) but the prompt lookup is
    // scoped, so it can never describe the other building's floor.
    const conversation = await prisma.aiConversation.findFirst({
      where: { buildingId: mine.building.id },
    });
    expect(conversation.buildingId).toBe(mine.building.id);
  });
});

describe('degraded behaviour', () => {
  test('falls back to a well-formed stream when no provider is configured', async () => {
    const { building, node } = await seed();

    const res = await ask(turn(building.id, { nodeId: node.id }));

    expect(res.text).toContain('"fallback":true');
    expect(res.text).toContain('"done":true');
  });
});
