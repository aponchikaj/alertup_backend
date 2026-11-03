import request from 'supertest';
import app from '../../server.js';

/* FX-057 — credentialed CORS only for the real HTTPS sites.

   The default list allowed plain-http alertup origins and a one-off Vercel
   preview URL with credentials, and left stage/pre-prod to an env var that
   had to be remembered on every deploy. */

const preflight = (origin) =>
  request(app).options('/api/me').set('Origin', origin).set('Access-Control-Request-Method', 'GET');

test.each([
  'https://alertup.world',
  'https://www.alertup.world',
  'https://stage.alertup.world',
  'https://pre-prod.alertup.world',
])('allows %s', async (origin) => {
  const res = await preflight(origin);
  expect(res.headers['access-control-allow-origin']).toBe(origin);
});

test.each([
  'http://alertup.world',
  'http://www.alertup.world',
])('refuses %s', async (origin) => {
  const res = await preflight(origin);
  expect(res.headers['access-control-allow-origin']).toBeUndefined();
});
