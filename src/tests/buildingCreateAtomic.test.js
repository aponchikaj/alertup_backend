import { jest } from '@jest/globals';

// BE-38: building create committed the building and its roles, then created
// floors one by one. A failure mid-loop left a half-built building behind
// (and the client saw "Server error"). The plan-count check also ran before
// the insert with nothing holding it, so parallel requests could all pass it.

let failOnCall = 0;
let calls = 0;
jest.unstable_mockModule('qrcode', () => ({
  default: {
    toDataURL: jest.fn(async () => {
      calls += 1;
      if (failOnCall && calls === failOnCall) throw new Error('qr render failed');
      return 'data:image/png;base64,AAAA';
    }),
  },
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');
const { default: prisma } = await import('../db/prisma.js');
const { createUser } = await import('./helpers.js');

const create = (cookie, name, floors) =>
  request(app).post('/api/building/new').set('Cookie', cookie).send({ buildingName: name, floorNames: floors });

beforeEach(() => {
  failOnCall = 0;
  calls = 0;
});

test('a failure while creating floors leaves no building behind', async () => {
  const { cookie, user } = await createUser({ plan: 'BUSINESS' });
  failOnCall = 2; // the second floor's QR
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  const res = await create(cookie, 'Half Built', ['Ground', 'First', 'Second']);
  errors.mockRestore();

  expect(res.body.success).toBe(false);
  expect(await prisma.building.count({ where: { ownerId: user.id } })).toBe(0);
  expect(await prisma.floor.count()).toBe(0);
  expect(await prisma.role.count()).toBe(0);
});

test('parallel creates cannot exceed the plan building limit', async () => {
  const { cookie, user } = await createUser(); // FREE: 1 building
  const results = await Promise.all(
    ['One', 'Two', 'Three', 'Four'].map((n) => create(cookie, `Tower ${n}`, ['Ground'])),
  );
  expect(results.filter((r) => r.body.success === true)).toHaveLength(1);
  expect(await prisma.building.count({ where: { ownerId: user.id } })).toBe(1);
});
