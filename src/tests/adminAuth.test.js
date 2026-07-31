import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createUser, adminCookie } from './helpers.js';

/**
 * Regression tests for the admin authentication bypass.
 *
 * The middleware used to check only that a cookie *named* adminToken existed,
 * without verifying it. Anyone could set `document.cookie = "adminToken=x"` and
 * read every user's personal data, delete accounts, or delete buildings.
 */

const ADMIN_ENDPOINTS = [
  ['get', '/api/admin/dashboard'],
  ['get', '/api/admin/users'],
  ['get', '/api/admin/buildings'],
  ['get', '/api/admin/reports'],
  ['get', '/api/admin/contacts'],
];

describe('admin authentication', () => {
  test.each(ADMIN_ENDPOINTS)(
    '%s %s rejects a forged admin cookie',
    async (method, path) => {
      const res = await request(app)
        [method](path)
        .set('Cookie', ['adminToken=totally-made-up']);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    }
  );

  test.each(ADMIN_ENDPOINTS)('%s %s rejects a missing cookie', async (method, path) => {
    const res = await request(app)[method](path);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ isAdmin: true }, 'not-the-real-secret');

    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', [`adminToken=${forged}`]);

    expect(res.status).toBe(401);
  });

  test('rejects a validly signed token that does not claim isAdmin', async () => {
    // A normal user's session token must not grant admin access, even though
    // it is signed with the same secret.
    const userToken = jwt.sign(
      { userID: 'cxxxxxxxxxxxxxxxxxxxxxxxx' },
      process.env.JWT_SECRET
    );

    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', [`adminToken=${userToken}`]);

    expect(res.status).toBe(403);
  });

  test('a real admin session reaches the protected endpoints', async () => {
    await createUser({ email: 'listed@example.com' });

    const res = await request(app).get('/api/admin/users').set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('the user session cookie is not interchangeable with the admin cookie', async () => {
    const { cookie } = await createUser();

    // A user token in the *user* cookie slot must not unlock admin routes.
    const res = await request(app).get('/api/admin/users').set('Cookie', cookie);

    expect(res.status).toBe(401);
  });

  test('whoami rejects the admin token (no userID claim)', async () => {
    const res = await request(app)
      .get('/api/me')
      .set('Cookie', [`userToken=${jwt.sign({ isAdmin: true }, process.env.JWT_SECRET)}`]);

    expect(res.status).toBe(401);
    expect(await prisma.user.count()).toBe(0);
  });
});
