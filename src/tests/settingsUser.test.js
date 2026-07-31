import request from 'supertest';
import bcrypt from 'bcrypt';

import app from '../../server.js';
import prisma from '../db/prisma.js';
import {
  createUser,
  createOwnerWithBuilding,
  addMember,
  TEST_PASSWORD,
} from './helpers.js';

/**
 * Settings + /api/me + 2FA flows against the Prisma-backed routes.
 *
 * SENDGRID_API_KEY is blanked by setup.js, so every real send attempt fails;
 * routes that respond before emailing still succeed, and routes that gate on
 * the email (2FA activation) answer "Couldn't sent email." while still having
 * created the verification row — which is what these tests lean on.
 */

describe('GET /api/me', () => {
  it('returns the legacy-shaped user object without the password', async () => {
    const { user, cookie } = await createUser();

    const res = await request(app).get('/api/me').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const me = res.body.data;
    expect(me.id).toBe(user.id);
    expect(me.email).toBe(user.email);
    expect(me.name).toBe(user.name);
    expect(me.lastname).toBe(user.lastname);
    expect(me.userType).toBe('INDIVIDUAL');
    expect(me.country).toBe('Georgia');
    expect(me.countryCode).toBe('+995');
    // Legacy key `phones`, sourced from the new `phone` column.
    expect(me.phones).toBe('500000000');
    expect(me.verified).toBe(true);
    expect(me.TwoFactorEnabled).toBe(false);
    expect(me.password).toBeUndefined();
  });
});

describe('GET /api/settings', () => {
  it('returns the settings payload with the legacy keys', async () => {
    const { cookie, user } = await createUser();

    const res = await request(app).get('/api/settings').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      country: 'Georgia',
      phone: '500000000',
      verified: true,
      userType: 'INDIVIDUAL',
      name: user.name,
      lastname: user.lastname,
      company: user.company,
      TwoFactorEnabled: false,
    });
  });
});

describe('PUT /api/settings/changePassword', () => {
  it('bumps tokenVersion so the old cookie stops working, and re-issues a session', async () => {
    const { user, cookie } = await createUser();

    const res = await request(app)
      .put('/api/settings/changePassword')
      .set('Cookie', cookie)
      .send({ oldPassword: TEST_PASSWORD, newPassword: 'NewPass12' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const after = await prisma.user.findUnique({
      where: { id: user.id },
      omit: { password: false },
    });
    expect(after.tokenVersion).toBe(1);
    expect(after.trustedIps).toEqual([]);
    expect(await bcrypt.compare('NewPass12', after.password)).toBe(true);

    // The pre-change cookie carries tokenVersion 0 and must be dead.
    const stale = await request(app).get('/api/me').set('Cookie', cookie);
    expect(stale.status).toBe(401);

    // The response re-issued a cookie for the caller's own session.
    const newCookie = res.headers['set-cookie'];
    expect(newCookie.join()).toContain('userToken=');
    const fresh = await request(app).get('/api/me').set('Cookie', newCookie);
    expect(fresh.status).toBe(200);
  });

  it('rejects the wrong old password', async () => {
    const { cookie } = await createUser();

    const res = await request(app)
      .put('/api/settings/changePassword')
      .set('Cookie', cookie)
      .send({ oldPassword: 'wrong-password', newPassword: 'NewPass12' });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('2FA activation flow', () => {
  it('activate creates a hashed 5-minute code, verify enables 2FA and clears trustedIps', async () => {
    const { user, cookie } = await createUser({ trustedIps: ['203.0.113.7'] });

    // With no SendGrid key the activation email fails, but the verification
    // row must already exist by then (same ordering the old route had).
    const activateRes = await request(app)
      .post('/api/2fa/activate')
      .set('Cookie', cookie);
    expect(activateRes.body.success).toBe(false);
    expect(activateRes.body.message).toBe("Couldn't sent email.");

    const pending = await prisma.verification.findFirst({
      where: { userId: user.id, type: '2fa-activation' },
    });
    expect(pending).not.toBeNull();
    expect(pending.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The emailed code is unknown (random, stored hashed) — pin it to a known
    // value to drive the verify step.
    await prisma.verification.update({
      where: { id: pending.id },
      data: { codeHash: await bcrypt.hash('123456', 12) },
    });

    const verifyRes = await request(app)
      .post('/api/2fa/verify')
      .set('Cookie', cookie)
      .send({ verificationCode: '123456', verificationType: 'activate' });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.success).toBe(true);

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.twoFactorEnabled).toBe(true);
    // Pre-2FA trusted addresses must not survive activation.
    expect(after.trustedIps).toEqual([]);

    // The consumed code must be gone.
    expect(
      await prisma.verification.count({
        where: { userId: user.id, type: '2fa-activation' },
      })
    ).toBe(0);
  });

  it('completes a 2FA login with a valid code and trusts the address', async () => {
    const { user } = await createUser({ twoFactorEnabled: true });
    await prisma.verification.create({
      data: {
        userId: user.id,
        type: '2fa',
        codeHash: await bcrypt.hash('654321', 12),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    const res = await request(app)
      .post('/api/auth/login/2fa')
      .send({ email: user.email, verificationCode: '654321' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(user.email);
    expect(res.headers['set-cookie'].join()).toContain('userToken=');

    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after.trustedIps.length).toBe(1);

    // The one-time code is consumed.
    expect(
      await prisma.verification.count({ where: { userId: user.id, type: '2fa' } })
    ).toBe(0);
  });
});

describe('POST /api/settings/account (deletion)', () => {
  it('requires the correct password and removes the user with their buildings', async () => {
    const { user, cookie, building, roles } = await createOwnerWithBuilding();
    const other = await createUser();
    const someRole = Object.values(roles)[0];
    await addMember(building.id, other.user.id, someRole.id);

    const wrong = await request(app)
      .post('/api/settings/account')
      .set('Cookie', cookie)
      .send({ password: 'not-it' });
    expect(wrong.status).toBe(401);

    const res = await request(app)
      .post('/api/settings/account')
      .set('Cookie', cookie)
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers['set-cookie'].join()).toContain('userToken=;');

    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.building.findUnique({ where: { id: building.id } })).toBeNull();
    expect(await prisma.buildingMember.count({ where: { buildingId: building.id } })).toBe(0);
    // The member's own account survives.
    expect(await prisma.user.findUnique({ where: { id: other.user.id } })).not.toBeNull();
  });
});
