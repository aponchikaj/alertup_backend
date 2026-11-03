import { jest } from '@jest/globals';

/* FX-027 — integration coverage for src/routes/admin.js beyond the auth
   bypass regressions in adminAuth.test.js: login/logout, every CRUD route's
   happy path, validation (400/422) and not-found (404). Login shares
   authLimiter (5 per IP), so each login carries its own X-Forwarded-For. */

const mail = jest.fn(async () => ({ success: true }));
jest.unstable_mockModule('../services/sendEmail.js', () => ({ default: mail }));

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');
const { default: prisma } = await import('../db/prisma.js');
const { default: config } = await import('../config/index.js');
const { createUser, createBuilding, createFloor, adminCookie, createOwnerWithBuilding } = await import('./helpers.js');

const MISSING = 'cxxxxxxxxxxxxxxxxxxxxxxxx';
let ip = 1;
const login = (body) => request(app).post('/api/admin/login').set('X-Forwarded-For', `10.99.0.${ip++}`).send(body);
const admin = (method, path) => request(app)[method](path).set('Cookie', adminCookie());
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => mail.mockClear());

describe('login / logout / isAdmin', () => {
  test('valid credentials set an httpOnly admin cookie that unlocks isAdmin', async () => {
    const res = await login({ user: config.admin.user, password: config.admin.pass });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('adminToken='));
    expect(cookie).toMatch(/HttpOnly/);

    const check = await request(app).get('/api/admin/isAdmin').set('Cookie', cookie.split(';')[0]);
    expect(check.status).toBe(200);
    await settle();
    expect(mail).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['missing fields', {}],
    ['wrong password', { user: 'test-admin', password: 'nope' }],
    ['wrong user', { user: 'root', password: 'whatever' }],
  ])('401 for %s, no cookie set', async (_label, body) => {
    const res = await login(body);
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('logout clears the cookie', async () => {
    const res = await request(app).post('/api/admin/logout');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).toMatch(/^adminToken=;/);
  });

  test('isAdmin is 401 without a cookie', async () => {
    expect((await request(app).get('/api/admin/isAdmin')).status).toBe(401);
  });
});

describe('POST /api/admin/sendMail', () => {
  test('sends an escaped message to an existing user (email matched case-insensitively)', async () => {
    const { user } = await createUser({ email: 'target@example.com' });
    const res = await admin('post', '/api/admin/sendMail').send({
      user: '  TARGET@example.com ',
      subject: '<b>Hi</b>',
      text: 'Body',
    });
    expect(res.status).toBe(200);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0][0]).toBe(user.email);
    expect(mail.mock.calls[0][4]).toContain('&lt;b&gt;Hi&lt;/b&gt;');
  });

  test('400 for missing fields, 404 for an unknown user, 502 when the provider fails', async () => {
    expect((await admin('post', '/api/admin/sendMail').send({ user: 'x@y.z' })).status).toBe(400);
    expect((await admin('post', '/api/admin/sendMail').send({ user: 'nobody@x.co', subject: 's', text: 't' })).status).toBe(404);

    await createUser({ email: 'target@example.com' });
    mail.mockRejectedValueOnce(new Error('down'));
    const res = await admin('post', '/api/admin/sendMail').send({ user: 'target@example.com', subject: 's', text: 't' });
    expect(res.status).toBe(502);
  });

  test('401 without an admin session', async () => {
    const res = await request(app).post('/api/admin/sendMail').send({ user: 'a', subject: 's', text: 't' });
    expect(res.status).toBe(401);
    expect(mail).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/dashboard', () => {
  test('counts users, reports and buildings', async () => {
    await createOwnerWithBuilding();
    await createUser();
    await prisma.report.create({ data: { email: 'a@b.co', message: 'm', reason: 'r' } });
    const res = await admin('get', '/api/admin/dashboard');
    expect(res.body.data).toEqual({ USERS_COUNT: 2, REPORTS_COUNT: 1, BUILDINGS_COUNT: 1 });
  });
});

describe('users', () => {
  test('list: search across name/email, paging, limit capped at 100, no password hashes', async () => {
    await createUser({ name: 'Zurab', email: 'zurab@example.com' });
    await createUser({ name: 'Ana', email: 'ana@example.com' });
    await createUser({ name: 'Other', company: 'ZURABCO' });

    const res = await admin('get', '/api/admin/users?q=zurab');
    expect(res.status).toBe(200);
    expect(res.body.data.totalUsers).toBe(2);
    expect(res.body.data.users.every((u) => u.password === undefined)).toBe(true);

    const paged = await admin('get', '/api/admin/users?limit=1&page=2');
    expect(paged.body.data).toMatchObject({ page: 2, totalPages: 3, totalUsers: 3 });
    expect(paged.body.data.users).toHaveLength(1);

    const repeated = await admin('get', '/api/admin/users?q=ana&q=zurab&limit=5000&page=-3');
    expect(repeated.body.data).toMatchObject({ page: 1, totalUsers: 1 });
  });

  test('get one: 200, 400 for a malformed id, 404 for an unknown one', async () => {
    const { user } = await createUser();
    const res = await admin('get', `/api/admin/user/${user.id}`);
    expect(res.body.data.id).toBe(user.id);
    expect(res.body.data.password).toBeUndefined();
    expect((await admin('get', '/api/admin/user/bad')).status).toBe(400);
    expect((await admin('get', `/api/admin/user/${MISSING}`)).status).toBe(404);
  });

  test('update: writes allowed fields, maps phoneNumber → phone, validates plan', async () => {
    const { user } = await createUser();
    const res = await admin('put', `/api/admin/user/${user.id}`).send({
      name: 'New',
      phoneNumber: '599000000',
      verified: false,
      plan: 'BUSINESS',
    });
    expect(res.status).toBe(200);
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row).toMatchObject({ name: 'New', phone: '599000000', verified: false, plan: 'BUSINESS' });

    const badPlan = await admin('put', `/api/admin/user/${user.id}`).send({ plan: 'ENTERPRISE' });
    expect(badPlan.status).toBe(422);
    expect((await prisma.user.findUnique({ where: { id: user.id } })).plan).toBe('BUSINESS');

    expect((await admin('put', '/api/admin/user/bad').send({})).status).toBe(400);
    expect((await admin('put', `/api/admin/user/${MISSING}`).send({ name: 'x' })).status).toBe(404);
  });

  // BUG FX-027-3: admin.js:323-329 copies name/verified/etc. into the Prisma update without type checks, so `verified: "yes"` is a Prisma validation error → 500 instead of a 400/422.
  test('update: a wrongly typed field is a client error, not a 500', async () => {
    const { user } = await createUser();
    const res = await admin('put', `/api/admin/user/${user.id}`).send({ verified: 'yes' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('delete: removes the user, their buildings and their invites elsewhere; archives incidents; emails them', async () => {
    const { user, building } = await createOwnerWithBuilding();
    await createFloor(building.id);
    await prisma.emergencyEvent.create({ data: { buildingId: building.id } });
    const other = await createOwnerWithBuilding();
    await prisma.buildingInvite.create({
      data: {
        buildingId: other.building.id,
        email: 'x@y.co',
        roleId: other.roles.Viewer.id,
        tokenHash: `hash-${Date.now()}`,
        expiresAt: new Date(Date.now() + 3600e3),
        invitedById: user.id,
      },
    });

    const res = await admin('delete', `/api/admin/user/${user.id}`).send({ reason: '<i>spam</i>' });
    expect(res.status).toBe(200);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
    expect(await prisma.building.count({ where: { id: building.id } })).toBe(0);
    expect(await prisma.buildingInvite.count()).toBe(0);
    expect(await prisma.building.count({ where: { id: other.building.id } })).toBe(1);
    expect(await prisma.incidentArchive.count()).toBeGreaterThan(0);

    await settle();
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0][4]).toContain('&lt;i&gt;spam&lt;/i&gt;');
  });

  test('delete: 400 malformed id, 404 unknown id', async () => {
    expect((await admin('delete', '/api/admin/user/bad')).status).toBe(400);
    expect((await admin('delete', `/api/admin/user/${MISSING}`)).status).toBe(404);
  });
});

describe('buildings', () => {
  test('list with search and the legacy shape', async () => {
    const { user } = await createUser();
    await createBuilding(user.id, { name: 'Harbor Tower' });
    await createBuilding(user.id, { name: 'Library' });

    const all = await admin('get', '/api/admin/buildings');
    expect(all.body.data.totalUsers).toBe(2); // legacy key name for the total
    const hit = await admin('get', '/api/admin/buildings?q=harbor');
    expect(hit.body.data.buildings).toHaveLength(1);
    expect(hit.body.data.buildings[0]).toMatchObject({ buildingName: 'Harbor Tower', owner: user.id, maps: [] });
  });

  test('get one: 200 / 400 / 404', async () => {
    const { building } = await createOwnerWithBuilding();
    await createFloor(building.id, { name: 'Ground' });
    const res = await admin('get', `/api/admin/buildings/${building.id}`);
    expect(res.body.data.maps[0].floor).toBe('Ground');
    expect((await admin('get', '/api/admin/buildings/bad')).status).toBe(400);
    expect((await admin('get', `/api/admin/buildings/${MISSING}`)).status).toBe(404);
  });

  test('delete cascades and archives; 400 / 404 otherwise', async () => {
    const { building } = await createOwnerWithBuilding();
    await createFloor(building.id);
    await prisma.emergencyEvent.create({ data: { buildingId: building.id } });

    const res = await admin('delete', `/api/admin/buildings/${building.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.building.count()).toBe(0);
    expect(await prisma.floor.count()).toBe(0);
    expect(await prisma.incidentArchive.count()).toBeGreaterThan(0);

    expect((await admin('delete', '/api/admin/buildings/bad')).status).toBe(400);
    expect((await admin('delete', `/api/admin/buildings/${MISSING}`)).status).toBe(404);
  });
});

describe('reports and contacts', () => {
  test('reports: list newest first, delete, 400 / 404', async () => {
    const old = await prisma.report.create({ data: { email: 'a@b.co', message: 'old', createdAt: new Date(2020, 0, 1) } });
    await prisma.report.create({ data: { email: 'a@b.co', message: 'new' } });

    const list = await admin('get', '/api/admin/reports');
    expect(list.body.data.map((r) => r.message)).toEqual(['new', 'old']);

    expect((await admin('delete', `/api/admin/reports/${old.id}`)).status).toBe(200);
    expect(await prisma.report.count()).toBe(1);
    expect((await admin('delete', `/api/admin/reports/${old.id}`)).status).toBe(404);
    expect((await admin('delete', '/api/admin/reports/bad')).status).toBe(400);
  });

  test('contacts: list, delete, 400 / 404', async () => {
    const c = await prisma.contact.create({ data: { email: 'a@b.co', message: 'hi', contactType: 'sales' } });
    const list = await admin('get', '/api/admin/contacts');
    expect(list.body.data).toHaveLength(1);

    expect((await admin('delete', `/api/admin/contacts/${c.id}`)).status).toBe(200);
    expect((await admin('delete', `/api/admin/contacts/${c.id}`)).status).toBe(404);
    expect((await admin('delete', '/api/admin/contacts/bad')).status).toBe(400);
  });

  test('a user session cannot delete reports or contacts', async () => {
    const { cookie } = await createUser();
    const c = await prisma.contact.create({ data: { email: 'a@b.co' } });
    const res = await request(app).delete(`/api/admin/contacts/${c.id}`).set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(await prisma.contact.count()).toBe(1);
  });
});
