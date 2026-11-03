import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import app from '../../server.js';

// FX-067: one response envelope, { success, message, data? }, built by
// utils/respond.js. The capitalised { Success, Message } shape is gone from
// every HTTP route; the frontend shim (http.ts normalizeEnvelope) can only be
// removed once nothing emits it.

const ROOTS = ['src/routes', 'src/features', 'src/middlewares', 'src/services/rateLimiter.js'];
// Object keys only (start of line, or after `{` / `,`); `Message: ${…}` inside
// an email template string is prose, not a key.
const LEGACY = /(^|[{,])\s*(Success|Message)\s*(:\s*[^\s$]|[,}])|\(\s*Message\s*\)/;

function sources(entry) {
  const stat = fs.statSync(entry);
  if (stat.isFile()) return [entry];
  return fs
    .readdirSync(entry)
    .flatMap((name) => sources(path.join(entry, name)))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
}

test('no route, feature or middleware emits the legacy { Success, Message } envelope', () => {
  const offenders = ROOTS.flatMap(sources).flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ file, line: i + 1, text: line }))
      .filter(({ text }) => !text.trim().startsWith('*') && !text.trim().startsWith('//'))
      .filter(({ text }) => LEGACY.test(text)),
  );
  expect(offenders.map((o) => `${o.file}:${o.line}`)).toEqual([]);
});

test('GET /api/connect uses the standard envelope and leaks no error text', async () => {
  const res = await request(app).get('/api/connect');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ success: true, message: 'Connected.' });
  expect(res.body).not.toHaveProperty('Success');
  expect(typeof res.body.timestamp).toBe('string');
});
