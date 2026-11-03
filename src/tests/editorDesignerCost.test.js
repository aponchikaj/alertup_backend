import { jest } from '@jest/globals';

// BE-39: on the Free plan the designer may not return a drawing, yet the
// route still made the full design call (design model, 6000-token budget)
// and threw the drawing away. Free owners now get a chat-sized advice call.

const calls = [];
jest.unstable_mockModule('../features/ai/aiClient.js', () => ({
  aiAvailable: () => true,
  visionAvailable: () => false,
  activeProvider: () => 'gemini',
  modelFor: () => 'test-model',
  chatOnce: jest.fn(async () => ''),
  callWithTools: jest.fn(async () => ({ toolCalls: [] })),
  streamChat: jest.fn(async function* (params) {
    calls.push(params);
    yield 'Draw the corridor first.';
  }),
}));

const { default: request } = await import('supertest');
const { createUser, createBuilding, createFloor } = await import('./helpers.js');
const { default: app } = await import('../../server.js');

const ask = async (plan) => {
  const { user, cookie } = await createUser({ plan });
  const { building } = await createBuilding(user.id);
  const floor = await createFloor(building.id, { floorNumber: 1 });
  calls.length = 0;
  const res = await request(app)
    .post('/api/ai/editor')
    .set('Cookie', cookie)
    .send({ buildingId: building.id, floorId: floor.id, messages: [{ role: 'user', content: 'Design a lobby' }] });
  expect(res.status).toBe(200);
  expect(calls).toHaveLength(1);
  return calls[0];
};

test('a Free owner gets a chat-sized advice call, not the design call', async () => {
  const params = await ask('FREE');
  expect(params.role ?? 'chat').toBe('chat');
  expect(params.maxTokens).toBeLessThanOrEqual(1000);
});

test('a paid owner still gets the full design call', async () => {
  const params = await ask('STARTER');
  expect(params.role).toBe('design');
  expect(params.maxTokens).toBe(6000);
});
