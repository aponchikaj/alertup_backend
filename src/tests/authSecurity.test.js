import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createUser, TEST_PASSWORD } from './helpers.js';

/**
 * Regression tests for the authentication and authorization defects found in
 * the audit, Prisma edition. Responses use the { success, message, data? }
 * envelope with real HTTP status codes.
 *
 * Note on rate limiters: each limiter is an in-memory, per-process store, so
 * the number of requests per limited endpoint in this file must stay under the
 * per-IP budget (authLimiter/loginLimiter/emailLimiter: 5 per window).
 */

const userWithPassword = (id) =>
  prisma.user.findUnique({ where: { id }, omit: { password: false } });

describe('password reset', () => {
  const seedVerifiedReset = async (userId, code, overrides = {}) =>
    prisma.verification.create({
      data: {
        userId,
        type: 'reset',
        codeHash: await bcrypt.hash(String(code), 12),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        verified: true,
        ...overrides,
      },
    });

  it('rejects a password change that does not present the code', async () => {
    const { user } = await createUser();
    await seedVerifiedReset(user.id, 123456);

    const res = await request(app)
      .post('/api/reset/password')
      .send({ user: user.email, newPassword: 'attacker-chosen' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);

    // The original password must still be in place.
    const after = await userWithPassword(user.id);
    expect(await bcrypt.compare(TEST_PASSWORD, after.password)).toBe(true);
  });

  it('rejects a password change presenting the wrong code', async () => {
    const { user } = await createUser();
    await seedVerifiedReset(user.id, 123456);

    const res = await request(app)
      .post('/api/reset/password')
      .send({ user: user.email, newPassword: 'attacker-chosen', code: '999999' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);

    const after = await userWithPassword(user.id);
    expect(await bcrypt.compare(TEST_PASSWORD, after.password)).toBe(true);
  });

  it('rejects a verified-but-expired reset record', async () => {
    const { user } = await createUser();
    await seedVerifiedReset(user.id, 123456, {
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await request(app)
      .post('/api/reset/password')
      .send({ user: user.email, newPassword: 'attacker-chosen', code: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);

    const after = await userWithPassword(user.id);
    expect(await bcrypt.compare(TEST_PASSWORD, after.password)).toBe(true);
  });

  it('accepts a password change with the correct, unexpired code', async () => {
    const { user } = await createUser();
    await seedVerifiedReset(user.id, 123456);

    const res = await request(app)
      .post('/api/reset/password')
      .send({ user: user.email, newPassword: 'BrandNewPass1!', code: '123456' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = await userWithPassword(user.id);
    expect(await bcrypt.compare('BrandNewPass1!', after.password)).toBe(true);
    // Sessions issued before the reset must stop working, and any
    // attacker-added trusted addresses must be dropped.
    expect(after.tokenVersion).toBe(1);
    expect(after.trustedIps).toEqual([]);
    // Consumed reset codes must be destroyed.
    expect(
      await prisma.verification.count({ where: { userId: user.id, type: 'reset' } })
    ).toBe(0);
  });

  it('does not reveal whether an email is registered', async () => {
    const res = await request(app)
      .post('/api/reset/send-code')
      .send({ user: 'nobody-here@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Verification code sent.');
  });
});

describe('whoami token handling', () => {
  it('rejects a token carrying no userID instead of matching an arbitrary user', async () => {
    // A user must exist, since the original bug returned whichever row came first.
    await createUser();

    const adminToken = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/me')
      .set('Cookie', [`userToken=${adminToken}`]);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects a session issued before a password reset', async () => {
    const { user } = await createUser();
    const staleToken = jwt.sign(
      { userID: user.id, tokenVersion: 0 },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });

    const res = await request(app)
      .get('/api/me')
      .set('Cookie', [`userToken=${staleToken}`]);

    expect(res.status).toBe(401);
  });

  it('answers 401, not 200, when no token is present', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('login', () => {
  it('rejects a query-operator object in place of an email', async () => {
    await createUser();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: { $ne: null }, password: TEST_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('does not return the session token in the body for a normal browser', async () => {
    const { user } = await createUser();

    const res = await request(app)
      .post('/api/auth/login')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0 Safari/537.36')
      .send({ email: user.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeUndefined();
    expect(res.body.data.user.email).toBe(user.email);
    expect(res.headers['set-cookie'].join()).toContain('userToken=');
  });

  it('answers 401 with no cookie for a wrong password', async () => {
    const { user } = await createUser();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'not-the-password' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('email change', () => {
  it('will not move an address the code was not sent to onto the account', async () => {
    const { user, cookie } = await createUser();
    const victim = await createUser({ email: 'victim@example.com' });

    // Attacker requested a code for an address they control.
    await prisma.verification.create({
      data: {
        userId: user.id,
        type: 'change email',
        codeHash: await bcrypt.hash('123456', 12),
        pendingEmail: 'attacker@evil.example.com',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const res = await request(app)
      .put('/api/settings/email')
      .set('Cookie', cookie)
      .send({ newEmail: victim.user.email, userCode: '123456' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.email).toBe(user.email);
  });

  it('rejects an email already used by another account', async () => {
    const { cookie } = await createUser();
    const other = await createUser();

    const res = await request(app)
      .post('/api/settings/email')
      .set('Cookie', cookie)
      .send({ newEmail: other.user.email });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });
});

describe('registration', () => {
  it('maps the legacy "Individual" userType string onto the enum', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        userType: 'Individual',
        name: 'New',
        lastname: 'Person',
        email: 'new-person@example.com',
        password: 'secret1',
        country: 'Georgia',
        countryCode: '+995',
        phone: '500123456',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const created = await prisma.user.findUnique({
      where: { email: 'new-person@example.com' },
    });
    expect(created.userType).toBe('INDIVIDUAL');
    // Non-applicable name fields keep the legacy filler.
    expect(created.company).toBe('****');
  });

  it('answers 409 for a duplicate email', async () => {
    const { user } = await createUser();

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        userType: 'Individual',
        name: 'Dup',
        lastname: 'Licate',
        email: user.email,
        password: 'secret1',
        country: 'Georgia',
        countryCode: '+995',
        phone: '500123456',
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe('Email already exists.');
  });
});
