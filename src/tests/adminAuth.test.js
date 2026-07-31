import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../server.js';
import USERS from '../models/user.model.js';

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
  ['get', '/api/admin/premiumUsers'],
  ['get', '/api/admin/buildings'],
  ['get', '/api/admin/reports'],
  ['get', '/api/admin/contacts'],
];

describe('admin authentication', () => {
  test.each(ADMIN_ENDPOINTS)('%s %s rejects a forged admin cookie', async (method, path) => {
    const res = await request(app)[method](path).set('Cookie', ['adminToken=totally-made-up']);

    expect(res.status).toBe(401);
    expect(res.body.Success).toBe(false);
  });

  test.each(ADMIN_ENDPOINTS)('%s %s rejects a missing cookie', async (method, path) => {
    const res = await request(app)[method](path);

    expect(res.status).toBe(401);
    expect(res.body.Success).toBe(false);
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
    const userToken = jwt.sign({ userID: '507f1f77bcf86cd799439011' }, process.env.JWT_SECRET);

    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', [`adminToken=${userToken}`]);

    expect(res.status).toBe(403);
  });

  test('rejects an expired admin token', async () => {
    const expired = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '-1s' });

    const res = await request(app)
      .get('/api/admin/users')
      .set('Cookie', [`adminToken=${expired}`]);

    expect(res.status).toBe(401);
  });

  test('accepts a properly signed admin token', async () => {
    const valid = jwt.sign({ isAdmin: true }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Cookie', [`adminToken=${valid}`]);

    expect(res.status).toBe(200);
    expect(res.body.Success).toBe(true);
  });

  test('a forged cookie cannot delete a user', async () => {
    const victim = await USERS.create({
      userType: 'Individual',
      name: 'Real',
      lastname: 'Person',
      email: 'victim@example.com',
      password: 'hashed',
    });

    const res = await request(app)
      .delete(`/api/admin/user/${victim._id}`)
      .set('Cookie', ['adminToken=forged'])
      .send({ reason: 'attack' });

    expect(res.status).toBe(401);

    // The account must still exist.
    expect(await USERS.findById(victim._id)).not.toBeNull();
  });
});
