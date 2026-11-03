import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import app from '../../server.js';

// FX-086: the legacy /uploads mount serves files from the API origin, the same
// origin as the session cookie. An SVG opened directly there is a document
// that can run script. Old rows may still point here, so the mount stays, but
// SVG answers are sandboxed and forced to download (same rule as R2, FX-056);
// <img src> keeps rendering them.

const dir = path.resolve('uploads/__test__');
const file = path.join(dir, 'evil.svg');

beforeAll(() => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test('legacy SVGs are sandboxed and served as attachments', async () => {
  const res = await request(app).get('/uploads/__test__/evil.svg');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
  expect(res.headers['content-disposition']).toMatch(/^attachment/);
  expect(res.headers['content-security-policy']).toMatch(/sandbox/);
  expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
});
