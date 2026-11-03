import { jest } from '@jest/globals';

/* FX-084 — a display name is user input. Interpolated raw into the HTML of
   account emails (welcome, 2FA, reset, settings), a name like
   `<a href="…">Click here</a>` rendered as a live, on-brand link in the
   recipient's mail client. */

const sent = [];
jest.unstable_mockModule('../services/sendEmail.js', () => ({
  default: jest.fn(async (...args) => {
    sent.push(args);
    return { ok: true };
  }),
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');

test('the welcome email escapes HTML in the user\'s name', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      userType: 'Individual',
      // 2-24 characters is the only rule names get, so short markup passes.
      name: '<a href=//x.co>Hi</a>',
      lastname: 'Doe',
      email: `esc-${Date.now()}@example.com`,
      password: 'secret12',
      country: 'Georgia',
      countryCode: '+995',
      phone: '500123456',
    });
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 50));

  const html = sent.map((args) => args[4]).filter(Boolean).join('\n');
  expect(html).toContain('&lt;a href=//x.co&gt;');
  expect(html).not.toContain('<a href=//x.co>');
});

test('the review thank-you email escapes HTML in the user\'s name (BE-35)', async () => {
  const { createUser } = await import('./helpers.js');
  const { cookie } = await createUser({ name: '<a href=//y.co>Hi</a>' });
  sent.length = 0;
  const res = await request(app).post('/api/review/alertup').set('Cookie', cookie).send({ stars: 5 });
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 50));

  const html = sent.map((args) => args[4]).filter(Boolean).join('\n');
  expect(html).toContain('&lt;a href=//y.co&gt;');
  expect(html).not.toContain('<a href=//y.co>');
});
