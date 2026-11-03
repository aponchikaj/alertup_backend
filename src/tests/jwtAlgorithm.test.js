import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../server.js';
import { createUser } from './helpers.js';

/* FX-087 — sessions are HS256; verification accepts HS256 only, rather than
   any algorithm the library would take for a shared secret. */

test('a session token signed with a different HMAC algorithm is refused', async () => {
  const { user } = await createUser();
  const token = jwt.sign({ userID: user.id, tokenVersion: user.tokenVersion ?? 0 }, process.env.JWT_SECRET, {
    algorithm: 'HS512',
  });

  const res = await request(app).get('/api/me').set('Cookie', `userToken=${token}`);

  expect(res.status).toBe(401);
});
