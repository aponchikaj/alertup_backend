import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../server.js';
import { adminCredentialsMatch } from '../routes/admin.js';

/* ============================================================================
   FX-046 — admin login hardening.

   - Credentials are compared in constant time (no early exit on the first
     differing character).
   - Admin tokens carry their own audience, so no other token signed with the
     shared JWT secret can ever pass as an admin session.
   - With no admin credentials configured, admin login is disabled outright.
   ========================================================================= */

test('a token signed with the right secret but without the admin audience is refused', async () => {
  const forged = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const res = await request(app).get('/api/admin/isAdmin').set('Cookie', `adminToken=${forged}`);

  expect(res.status).toBe(401);
});

test('a real admin login yields a token that works', async () => {
  const res = await request(app)
    .post('/api/admin/login')
    .set('X-Forwarded-For', '10.77.0.1')
    .send({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASS });
  expect(res.status).toBe(200);
  const cookie = res.headers['set-cookie'].find((c) => c.startsWith('adminToken='));

  const check = await request(app).get('/api/admin/isAdmin').set('Cookie', cookie.split(';')[0]);

  expect(check.status).toBe(200);
});

describe('adminCredentialsMatch', () => {
  const config = { user: 'root', pass: 'correct horse battery' };

  test('accepts the configured pair', () => {
    expect(adminCredentialsMatch('root', 'correct horse battery', config)).toBe(true);
  });

  test.each([
    ['root', 'wrong'],
    ['Root', 'correct horse battery'],
    ['', ''],
    [undefined, undefined],
    [{}, []],
  ])('refuses %p / %p', (user, pass) => {
    expect(adminCredentialsMatch(user, pass, config)).toBe(false);
  });

  test('is disabled when no credentials are configured', () => {
    expect(adminCredentialsMatch('', '', { user: '', pass: '' })).toBe(false);
    expect(adminCredentialsMatch(undefined, undefined, {})).toBe(false);
  });
});
