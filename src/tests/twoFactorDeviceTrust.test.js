import { jest } from '@jest/globals';

// FX-082: 2FA used to be skipped for any IP in user.trustedIps, and every
// successful login added its IP, so on a shared network (office, campus,
// carrier-grade NAT) the password alone was enough. Trust is now per device:
// a signed, httpOnly cookie set after a completed 2FA, scoped to the user and
// their current tokenVersion, valid 30 days.

const sent = [];
jest.unstable_mockModule('../services/sendEmail.js', () => ({
  default: jest.fn(async (...args) => {
    sent.push(args);
    return { success: true };
  }),
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');
const { default: prisma } = await import('../db/prisma.js');
const { createUser } = await import('./helpers.js');

const cookieNamed = (res, name) =>
  (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? null;

// Each test gets its own client address so the per-IP login limiter (5 per
// 10 minutes) never couples the tests together.
let ip = '10.0.0.1';
let n = 0;
beforeEach(() => {
  n += 1;
  ip = `10.0.0.${n}`;
});

const login = (user, plainPassword, cookies = []) =>
  request(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .set('Cookie', cookies)
    .send({ email: user.email, password: plainPassword });

async function completeTwoFactor(user, plainPassword) {
  sent.length = 0;
  const challenge = await login(user, plainPassword);
  expect(challenge.status).toBe(401);
  expect(challenge.body.message).toBe('2fa');
  const code = String(sent.at(-1)[2]).match(/\b(\d{6})\b/)[1];
  return request(app)
    .post('/api/auth/login/2fa')
    .set('X-Forwarded-For', ip)
    .send({ email: user.email, verificationCode: code });
}

const twoFactorUser = async () => {
  const { user, plainPassword } = await createUser({ twoFactorEnabled: true });
  return { user, plainPassword };
};

test('a previously used IP alone no longer skips 2FA', async () => {
  const { user, plainPassword } = await twoFactorUser();
  await prisma.user.update({ where: { id: user.id }, data: { trustedIps: [ip] } });
  const res = await login(user, plainPassword);
  expect(res.status).toBe(401);
  expect(res.body.message).toBe('2fa');
});

test('completing 2FA sets a device cookie that skips 2FA next time', async () => {
  const { user, plainPassword } = await twoFactorUser();
  const done = await completeTwoFactor(user, plainPassword);
  expect(done.status).toBe(200);
  const device = cookieNamed(done, 'trustedDevice');
  expect(device).toBeTruthy();
  expect(done.headers['set-cookie'].find((c) => c.startsWith('trustedDevice='))).toMatch(/HttpOnly/i);

  const again = await login(user, plainPassword, [device]);
  expect(again.status).toBe(200);
});

test("another user's device cookie does not skip this user's 2FA", async () => {
  const a = await twoFactorUser();
  const b = await twoFactorUser();
  const device = cookieNamed(await completeTwoFactor(a.user, a.plainPassword), 'trustedDevice');
  const res = await login(b.user, b.plainPassword, [device]);
  expect(res.status).toBe(401);
  expect(res.body.message).toBe('2fa');
});

test('a password change (tokenVersion bump) revokes trusted devices', async () => {
  const { user, plainPassword } = await twoFactorUser();
  const device = cookieNamed(await completeTwoFactor(user, plainPassword), 'trustedDevice');
  await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
  const res = await login(user, plainPassword, [device]);
  expect(res.status).toBe(401);
  expect(res.body.message).toBe('2fa');
});

test('a device token is never accepted as a session token', async () => {
  const { user, plainPassword } = await twoFactorUser();
  const device = cookieNamed(await completeTwoFactor(user, plainPassword), 'trustedDevice');
  const raw = device.split('=')[1];
  const asBearer = await request(app).get('/api/settings').set('Authorization', `Bearer ${raw}`);
  expect(asBearer.status).toBe(401);
  const asCookie = await request(app).get('/api/settings').set('Cookie', [`userToken=${raw}`]);
  expect(asCookie.status).toBe(401);
});
