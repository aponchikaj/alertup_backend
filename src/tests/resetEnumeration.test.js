import request from 'supertest';
import app from '../../server.js';
import { createUser } from './helpers.js';

// FX-081: the reset flow must not reveal whether an address has an account.
// send-code already answers the same either way; verify-code and new-password
// answered 404 "User not found." for an unknown address but 400 for a known
// one, which is still an oracle. Unknown now gets exactly the known-without-
// a-pending-code reply.

const reply = (res) => ({ status: res.status, body: res.body });

test('verify-code: unknown address is indistinguishable from a known one', async () => {
  const { user: known } = await createUser({ email: 'known@example.com' });
  const a = await request(app).post('/api/reset/verify-code').send({ user: known.email, code: '123456' });
  const b = await request(app).post('/api/reset/verify-code').send({ user: 'ghost@example.com', code: '123456' });
  expect(reply(b)).toEqual(reply(a));
});

test('password: unknown address is indistinguishable from a known one', async () => {
  const { user: known } = await createUser({ email: 'known2@example.com' });
  const body = { code: '123456', newPassword: 'Str0ng!pass' };
  const a = await request(app).post('/api/reset/password').send({ ...body, user: known.email });
  const b = await request(app).post('/api/reset/password').send({ ...body, user: 'ghost2@example.com' });
  expect(a.status).toBe(400); // the real handler answered, not a 404 for a missing route
  expect(reply(b)).toEqual(reply(a));
});
