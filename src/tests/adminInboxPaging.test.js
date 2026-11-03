import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { adminCookie } from './helpers.js';

// FX-093: the admin report and contact inboxes returned every row in one
// response. They page now (newest first, 100 per page by default), keeping
// `data` an array so existing clients still read it; page info is top-level.

const seed = (model, n) =>
  prisma[model].createMany({
    data: Array.from({ length: n }, (_, i) => ({
      email: `p${i}@example.com`,
      message: `m${i}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    })),
  });

test.each([
  ['report', '/api/admin/reports'],
  ['contact', '/api/admin/contacts'],
])('%s inbox pages, newest first', async (model, path) => {
  await seed(model, 105);
  const first = await request(app).get(path).set('Cookie', adminCookie());
  expect(first.status).toBe(200);
  expect(first.body.data).toHaveLength(100);
  expect(first.body.data[0].message).toBe('m104');
  expect(first.body).toMatchObject({ page: 1, totalPages: 2, total: 105 });

  const second = await request(app).get(`${path}?page=2`).set('Cookie', adminCookie());
  expect(second.body.data.map((r) => r.message)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);

  const small = await request(app).get(`${path}?limit=10`).set('Cookie', adminCookie());
  expect(small.body.data).toHaveLength(10);
  const capped = await request(app).get(`${path}?limit=5000`).set('Cookie', adminCookie());
  expect(capped.body.data).toHaveLength(100);
});
