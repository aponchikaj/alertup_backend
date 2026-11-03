import { jest } from '@jest/globals';

/* FX-027 — integration coverage for src/routes/contact/contact.js and
   src/routes/contact/report.js. Both are anonymous and share emailLimiter
   (5 per IP per 15 min), so each request carries its own X-Forwarded-For —
   server.js trusts one proxy hop — except in the test that checks the limit. */

const mail = jest.fn(async () => ({ success: true }));
jest.unstable_mockModule('../services/sendEmail.js', () => ({ default: mail }));

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');
const { default: prisma } = await import('../db/prisma.js');

let ipCounter = 1;
const freshIp = () => `10.27.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const send = (path, body, ip = freshIp()) => request(app).post(path).set('X-Forwarded-For', ip).send(body);

// The contact route answers before it emails; give the after-response send a tick.
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => mail.mockClear());

describe('POST /api/contact', () => {
  const valid = { email: 'a@b.co', message: 'Hello there', reason: 'sales' };

  test('stores the message and notifies the team with escaped HTML', async () => {
    const res = await send('/api/contact', { ...valid, message: '<script>x</script>' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Sent.' });

    const rows = await prisma.contact.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'a@b.co', contactType: 'sales', message: '<script>x</script>' });

    await settle();
    expect(mail).toHaveBeenCalledTimes(1);
    const html = mail.mock.calls[0][4];
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  test('a mail failure after the response does not undo the submission', async () => {
    mail.mockRejectedValueOnce(new Error('resend down'));
    const res = await send('/api/contact', valid);
    expect(res.status).toBe(200);
    await settle();
    expect(await prisma.contact.count()).toBe(1);
  });

  test.each([
    ['missing email', { message: 'm', reason: 'r' }],
    ['missing message', { email: 'a@b.co', reason: 'r' }],
    ['missing reason', { email: 'a@b.co', message: 'm' }],
    ['non-string email', { email: ['a@b.co'], message: 'm', reason: 'r' }],
    ['non-string reason', { email: 'a@b.co', message: 'm', reason: { $ne: 1 } }],
    ['email without @', { email: 'nope', message: 'm', reason: 'r' }],
    ['message over 5000 chars', { email: 'a@b.co', message: 'x'.repeat(5001), reason: 'r' }],
  ])('400 for %s', async (_label, body) => {
    const res = await send('/api/contact', body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(await prisma.contact.count()).toBe(0);
    expect(mail).not.toHaveBeenCalled();
  });

  test('is rate limited per IP (6th request in the window is a 429)', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      expect((await send('/api/contact', valid, ip)).status).toBe(200);
    }
    const res = await send('/api/contact', valid, ip);
    expect(res.status).toBe(429);
    expect(await prisma.contact.count()).toBe(5);
  });
});

describe('POST /api/report', () => {
  const valid = { email: '  Reporter@Example.COM ', message: 'Broken map', reason: 'bug' };

  test('stores the report with a normalised email', async () => {
    const res = await send('/api/report', valid);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Sent.' });
    const rows = await prisma.report.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'reporter@example.com', message: 'Broken map', reason: 'bug' });
  });

  test.each([
    ['missing fields', {}, 'Invalid fields.'],
    ['non-string message', { email: 'a@b.co', message: 5, reason: 'r' }, 'Invalid fields.'],
    ['email without @', { email: 'nope', message: 'm', reason: 'r' }, 'Invalid email.'],
    ['email over 355 chars', { email: `${'a'.repeat(350)}@b.com`, message: 'm', reason: 'r' }, 'Invalid email.'],
    ['blank message', { email: 'a@b.co', message: '   ', reason: 'r' }, 'Invalid message.'],
    ['message over 5000 chars', { email: 'a@b.co', message: 'x'.repeat(5001), reason: 'r' }, 'Invalid message.'],
    ['blank reason', { email: 'a@b.co', message: 'm', reason: ' ' }, 'Invalid reason.'],
    ['reason over 200 chars', { email: 'a@b.co', message: 'm', reason: 'r'.repeat(201) }, 'Invalid reason.'],
  ])('400 for %s', async (_label, body, message) => {
    const res = await send('/api/report', body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message });
    expect(await prisma.report.count()).toBe(0);
  });

  test('the report is visible to the admin list', async () => {
    await send('/api/report', valid);
    const { adminCookie } = await import('./helpers.js');
    const res = await request(app).get('/api/admin/reports').set('Cookie', adminCookie());
    expect(res.body.data).toHaveLength(1);
  });
});
