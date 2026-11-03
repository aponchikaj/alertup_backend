import { jest } from '@jest/globals';

/* ============================================================================
   FX-041 — the anonymous evacuation brief must not cost one model call per
   request.

   During an incident hundreds of occupants ask from the same few places, so
   the phrased sentence is cached by its exact facts (exit, distance, floors,
   closure flag) and language: a repeat costs nothing, and any change in the
   facts — a new closure, a different exit — is a different key, so the cache
   can never serve a stale exit. A "no route" answer never calls the model:
   the template already says everything there is to say.
   ========================================================================= */

const chatOnce = jest.fn(async () => 'Head to North Exit, about 10 m away.');
jest.unstable_mockModule('../features/ai/aiClient.js', () => ({
  aiAvailable: () => true,
  chatOnce,
  streamChat: jest.fn(),
  callWithTools: jest.fn(),
  visionAvailable: () => false,
  activeProvider: () => 'gemini',
  modelFor: () => 'test-model',
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');
const { clearAll } = await import('../features/wayfinding/graphCache.js');
const { _clearBriefCacheForTests } = await import('../features/ai/evacuationBrief.routes.js');
const { createUser, createBuilding, createFloor, createNode, connectNodes } = await import('./helpers.js');

beforeEach(() => {
  clearAll();
  _clearBriefCacheForTests();
  chatOnce.mockClear();
});

const seed = async ({ withExit = true } = {}) => {
  const { user } = await createUser();
  const { building } = await createBuilding(user.id);
  const floor = await createFloor(building.id, { floorNumber: 1, scalePixelsPerMeter: 50 });
  const here = await createNode(building.id, floor.id, { x: 0, label: 'Lobby' });
  const other = await createNode(building.id, floor.id, {
    x: 500,
    ...(withExit ? { type: 'EMERGENCY_EXIT', label: 'North Exit' } : {}),
  });
  await connectNodes(here, other);
  return { building, here };
};

const brief = (buildingId, nodeId, locale = 'en') =>
  request(app).post('/api/ai/evacuation-brief').send({ buildingId, nodeId, locale });

test('the same facts are phrased once, then served from cache', async () => {
  const { building, here } = await seed();

  const first = await brief(building.id, here.id);
  const second = await brief(building.id, here.id);

  expect(first.body.data.text).toBe('Head to North Exit, about 10 m away.');
  expect(second.body.data.text).toBe(first.body.data.text);
  expect(chatOnce).toHaveBeenCalledTimes(1);
});

test('another language is a separate phrasing', async () => {
  const { building, here } = await seed();

  await brief(building.id, here.id, 'en');
  await brief(building.id, here.id, 'ka');

  expect(chatOnce).toHaveBeenCalledTimes(2);
});

test('a "no route" answer never calls the model', async () => {
  const { building, here } = await seed({ withExit: false });

  const res = await brief(building.id, here.id);

  expect(res.body.data.found).toBe(false);
  expect(chatOnce).not.toHaveBeenCalled();
});
