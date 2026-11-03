import { jest } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

/* FX-027 — src/routes/debug.js decides at import time whether to register
   anything: only ENABLE_DEBUG_ROUTES=true AND NODE_ENV !== 'production'
   turns it on. Each case re-imports the module under a fresh registry. */

const ORIGINAL = { flag: process.env.ENABLE_DEBUG_ROUTES, env: process.env.NODE_ENV };

afterEach(() => {
  process.env.ENABLE_DEBUG_ROUTES = ORIGINAL.flag;
  process.env.NODE_ENV = ORIGINAL.env;
});

const appWithDebug = async ({ flag, nodeEnv }) => {
  if (flag === undefined) delete process.env.ENABLE_DEBUG_ROUTES;
  else process.env.ENABLE_DEBUG_ROUTES = flag;
  process.env.NODE_ENV = nodeEnv;
  jest.resetModules();
  const { default: router } = await import('../routes/debug.js');
  const app = express();
  app.use(cookieParser());
  app.use(router);
  return app;
};

test.each([
  ['unset', undefined, 'test'],
  ['"false"', 'false', 'test'],
  ['"1" (only the literal "true" counts)', '1', 'test'],
  ['"true" but NODE_ENV=production', 'true', 'production'],
])('no debug routes when the flag is %s', async (_label, flag, nodeEnv) => {
  const app = await appWithDebug({ flag, nodeEnv });
  expect((await request(app).get('/api/debug')).status).toBe(404);
  expect((await request(app).get('/api/debug/setcookie')).status).toBe(404);
});

test('enabled: /api/debug echoes cookie NAMES only, never their values', async () => {
  const app = await appWithDebug({ flag: 'true', nodeEnv: 'test' });
  const res = await request(app)
    .get('/api/debug')
    .set('Origin', 'https://example.com')
    .set('X-Forwarded-Proto', 'https')
    .set('Cookie', ['userToken=secret-user-token', 'adminToken=secret-admin-token']);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.data).toMatchObject({
    origin: 'https://example.com',
    forwarded_proto: 'https',
    secure: false,
    cookieNames: ['userToken', 'adminToken'],
  });
  expect(JSON.stringify(res.body)).not.toMatch(/secret-(user|admin)-token/);
});

test('enabled: setcookie uses SameSite=Lax over http and SameSite=None; Secure behind https', async () => {
  const app = await appWithDebug({ flag: 'true', nodeEnv: 'development' });

  const plain = await request(app).get('/api/debug/setcookie');
  expect(plain.body.cookieOptions).toMatchObject({ secure: false, sameSite: 'Lax', httpOnly: false });
  expect(plain.headers['set-cookie'][0]).toMatch(/^debug_test=ok;.*SameSite=Lax/);

  const https = await request(app).get('/api/debug/setcookie').set('X-Forwarded-Proto', 'https');
  expect(https.body.cookieOptions).toMatchObject({ secure: true, sameSite: 'None' });
  expect(https.headers['set-cookie'][0]).toMatch(/Secure/);
  expect(https.headers['set-cookie'][0]).toMatch(/SameSite=None/);
});
