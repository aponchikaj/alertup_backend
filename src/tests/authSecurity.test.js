import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

import app from '../../server.js';
import USERS from '../models/user.model.js';
import VERIFICATIONS from '../models/verificatios.model.js';
import BUILDINGS from '../models/building.model.js';
import { createUser, createOwnerWithBuilding, TEST_PASSWORD } from './helpers.js';

/**
 * Regression tests for the authentication and authorization defects found in
 * the audit. Each test fails against the original code.
 */

describe('password reset', () => {
  const seedVerifiedReset = async (userId, code, overrides = {}) =>
    VERIFICATIONS.create({
      verificationBy: userId,
      verificationType: 'reset',
      verificationCode: await bcrypt.hash(String(code), 12),
      expires: Date.now() + 10 * 60 * 1000,
      verified: true,
      ...overrides,
    });

  it('rejects a password change that does not present the code', async () => {
    const { user } = await createUser();
    await seedVerifiedReset(user._id, 123456);

    const res = await request(app)
      .post('/api/reset/password')
      .send({ user: user.email, newPassword: 'attacker-chosen' });

    expect(res.body.success).toBe(false);

    // The original password must still be in place.
    const after = await USERS.findById(user._id).select('+password');
    expect(await bcrypt.compare(TEST_PASSWORD, after.password)).toBe(true);
  });

  it('rejects a password change presenting the wrong code', async () => {
    const { user } = await createUser();
    await seedVerifiedReset(user._id, 123456);

    const res = await request(app)
      .post('/api/reset/password')
      .send({ user: user.email, newPassword: 'attacker-chosen', code: '999999' });

    expect(res.body.success).toBe(false);

    const after = await USERS.findById(user._id).select('+password');
    expect(await bcrypt.compare(TEST_PASSWORD, after.password)).toBe(true);
  });

  it('rejects a verified-but-expired reset record', async () => {
    const { user } = await createUser();
    await seedVerifiedReset(user._id, 123456, { expires: Date.now() - 1000 });

    const res = await request(app)
      .post('/api/reset/password')
      .send({ user: user.email, newPassword: 'attacker-chosen', code: '123456' });

    expect(res.body.success).toBe(false);

    const after = await USERS.findById(user._id).select('+password');
    expect(await bcrypt.compare(TEST_PASSWORD, after.password)).toBe(true);
  });

  it('accepts a password change with the correct, unexpired code', async () => {
    const { user } = await createUser();
    await seedVerifiedReset(user._id, 123456);

    const res = await request(app)
      .post('/api/reset/password')
      .send({ user: user.email, newPassword: 'BrandNewPass1!', code: '123456' });

    expect(res.body.success).toBe(true);

    const after = await USERS.findById(user._id).select('+password');
    expect(await bcrypt.compare('BrandNewPass1!', after.password)).toBe(true);
    // Sessions issued before the reset must stop working.
    expect(after.tokenVersion).toBe(1);
  });

  it('does not reveal whether an email is registered', async () => {
    const res = await request(app)
      .post('/api/reset/send-code')
      .send({ user: 'nobody-here@example.com' });

    expect(res.body.message).toBe('Verification code sent.');
  });
});

describe('whoami token handling', () => {
  it('rejects a token carrying no userID instead of matching an arbitrary user', async () => {
    // A user must exist, since the bug returned whichever document came first.
    await createUser();

    const adminToken = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/me')
      .set('Cookie', [`userToken=${adminToken}`]);

    expect(res.status).toBe(401);
  });

  it('rejects a session issued before a password reset', async () => {
    const { user } = await createUser();
    const staleToken = jwt.sign(
      { userID: user._id, tokenVersion: 0 },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );

    await USERS.findByIdAndUpdate(user._id, { $inc: { tokenVersion: 1 } });

    const res = await request(app)
      .get('/api/me')
      .set('Cookie', [`userToken=${staleToken}`]);

    expect(res.status).toBe(401);
  });

  it('answers 401, not 200, when no token is present', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
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

    expect(res.body.Success).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.headers['set-cookie'].join()).toContain('userToken=');
  });
});

describe('email change', () => {
  it('will not move an address the code was not sent to onto the account', async () => {
    const { user, cookie } = await createUser();
    const victim = await createUser({ email: 'victim@example.com' });

    // Attacker requested a code for an address they control.
    await VERIFICATIONS.create({
      verificationBy: user._id,
      verificationType: 'change email',
      verificationCode: await bcrypt.hash('123456', 12),
      pendingEmail: 'attacker@evil.example.com',
      expires: Date.now() + 10 * 60 * 1000,
    });

    const res = await request(app)
      .put('/api/settings/email')
      .set('Cookie', cookie)
      .send({ newEmail: victim.user.email, userCode: '123456' });

    expect(res.body.Success).toBe(false);

    const after = await USERS.findById(user._id);
    expect(after.email).toBe(user.email);
  });

  it('rejects an email already used by another account', async () => {
    const { user, cookie } = await createUser();
    const other = await createUser();

    const res = await request(app)
      .post('/api/settings/email')
      .set('Cookie', cookie)
      .send({ newEmail: other.user.email });

    expect(res.body.Success).toBe(false);
  });
});

describe('building scan', () => {
  it('honors deactivation instead of silently reactivating', async () => {
    const { building } = await createOwnerWithBuilding();
    await BUILDINGS.findByIdAndUpdate(building._id, { isDeactivated: true });

    const res = await request(app).get(`/api/building/scan/${building._id}/1`);

    expect(res.status).toBe(410);

    const after = await BUILDINGS.findById(building._id);
    expect(after.isDeactivated).toBe(true);
  });
});

describe('floor map route', () => {
  it('does not create floor documents for a building that does not exist', async () => {
    const Floor = (await import('../models/floor.model.js')).default;
    const missingBuildingId = '507f1f77bcf86cd799439011';

    const res = await request(app)
      .get(`/api/route/building/${missingBuildingId}/floor/3`);

    expect(res.status).toBe(404);
    expect(await Floor.countDocuments({})).toBe(0);
  });
});
