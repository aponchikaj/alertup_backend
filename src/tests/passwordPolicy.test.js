import request from 'supertest';
import app from '../../server.js';
import { createUser } from './helpers.js';
import { checkNewPassword, PASSWORD_MIN_CHARS, PASSWORD_MAX_BYTES } from '../services/passwordPolicy.js';

// FX-080: one policy for every place a password is SET (register, settings
// change, reset): at least 8 characters, at most 72 bytes (bcrypt ignores
// anything past that). It was 6–16 chars at signup and in settings, but 6+
// chars / 72 bytes at reset; a 16-char ceiling also rejected passphrases.

const passphrase = 'correct horse battery staple'; // 28 chars
const tooLong = 'é'.repeat(37); // 37 chars, 74 bytes

describe('checkNewPassword', () => {
  test.each([
    ['too short', 'Ab1!xyz', /at least 8/],
    ['not a string', 12345678, /Invalid/],
    ['over 72 bytes', tooLong, /72 bytes/],
  ])('%s is refused', (_, pw, msg) => {
    expect(checkNewPassword(pw)).toMatch(msg);
  });

  test('accepts 8 chars and long passphrases', () => {
    expect(PASSWORD_MIN_CHARS).toBe(8);
    expect(PASSWORD_MAX_BYTES).toBe(72);
    expect(checkNewPassword('Ab1!xyzw')).toBeNull();
    expect(checkNewPassword(passphrase)).toBeNull();
  });
});

const registerBody = (password, email) => ({
  userType: 'Individual',
  name: 'Pass',
  lastname: 'Phrase',
  email,
  password,
  country: 'Georgia',
  countryCode: '+995',
  phone: '500123456',
});

test('register accepts a passphrase longer than 16 characters', async () => {
  const res = await request(app).post('/api/auth/register').send(registerBody(passphrase, 'pp@example.com'));
  expect(res.status).toBe(200);
});

test('register refuses 7 characters', async () => {
  const res = await request(app).post('/api/auth/register').send(registerBody('Ab1!xyz', 'short@example.com'));
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/at least 8/);
});

test('settings change applies the same policy', async () => {
  const { cookie, plainPassword } = await createUser();
  const short = await request(app)
    .put('/api/settings/changePassword')
    .set('Cookie', cookie)
    .send({ oldPassword: plainPassword, newPassword: 'Ab1!xyz' });
  expect(short.status).toBe(400);
  expect(short.body.message).toMatch(/at least 8/);

  const long = await request(app)
    .put('/api/settings/changePassword')
    .set('Cookie', cookie)
    .send({ oldPassword: plainPassword, newPassword: passphrase });
  expect(long.status).toBe(200);
});

test('reset applies the same policy', async () => {
  const res = await request(app)
    .post('/api/reset/password')
    .send({ user: 'x@example.com', code: '123456', newPassword: 'Ab1!xyz' });
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/at least 8/);
});
