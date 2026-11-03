import request from 'supertest';
import app from '../../server.js';

/* FX-047 — the API sent no security headers at all (no helmet). */

test('API responses carry the standard security headers', async () => {
  const res = await request(app).get('/api/connect');

  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBeDefined();
  expect(res.headers['content-security-policy']).toMatch(/default-src/);
  expect(res.headers['x-powered-by']).toBeUndefined();
});

test('images served by the API stay embeddable by the SPA on another origin', async () => {
  const res = await request(app).get('/api/connect');

  expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
});
