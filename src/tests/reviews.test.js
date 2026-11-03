import { jest } from '@jest/globals';

/* FX-027 — integration coverage for src/routes/reviews.js. */

const mail = jest.fn(async () => ({ success: true }));
jest.unstable_mockModule('../services/sendEmail.js', () => ({ default: mail }));

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');
const { default: prisma } = await import('../db/prisma.js');
const { createUser } = await import('./helpers.js');

beforeEach(() => mail.mockClear());

const post = (cookie, body) => request(app).post('/api/review/alertup').set('Cookie', cookie).send(body);

describe('POST /api/review/alertup', () => {
  test('401 without a session', async () => {
    const res = await request(app).post('/api/review/alertup').send({ stars: 5 });
    expect(res.status).toBe(401);
    expect(await prisma.review.count()).toBe(0);
  });

  test('stores the review and sends a thank-you email', async () => {
    const { user, cookie } = await createUser({ name: 'Nino' });
    const res = await post(cookie, { stars: 5, comment: 'Great.' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Sent.' });
    const review = await prisma.review.findUnique({ where: { userId: user.id } });
    expect(review).toMatchObject({ stars: 5, comment: 'Great.', userName: 'Nino', userType: 'INDIVIDUAL' });
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0][0]).toBe(user.email);
  });

  test('a company account is listed under its company name', async () => {
    const { user, cookie } = await createUser({ userType: 'COMPANY', company: 'Acme LLC' });
    await post(cookie, { stars: 3 });
    expect((await prisma.review.findUnique({ where: { userId: user.id } })).userName).toBe('Acme LLC');
  });

  test('a mail failure does not fail the review', async () => {
    mail.mockRejectedValueOnce(new Error('resend down'));
    const { cookie } = await createUser();
    const res = await post(cookie, { stars: 4 });
    expect(res.status).toBe(200);
    expect(await prisma.review.count()).toBe(1);
  });

  test.each([
    ['missing stars', {}],
    ['stars as a string', { stars: '5' }],
    ['stars below 1', { stars: 0 }],
    ['stars above 5', { stars: 6 }],
    ['comment over 500 chars', { stars: 5, comment: 'x'.repeat(501) }],
  ])('400 for %s', async (_label, body) => {
    const { cookie } = await createUser();
    const res = await post(cookie, body);
    expect(res.status).toBe(400);
    expect(await prisma.review.count()).toBe(0);
  });

  // BUG FX-027-2: reviews.js:14 accepts any number in [1,5], so stars: 4.5 passes validation and Prisma's Int column throws — the client gets a 500 instead of a 400.
  test('400 for fractional stars', async () => {
    const { cookie } = await createUser();
    const res = await post(cookie, { stars: 4.5 });
    expect(res.status).toBe(400);
  });

  test('a second review is a 409 and the first is kept', async () => {
    const { user, cookie } = await createUser();
    await post(cookie, { stars: 5, comment: 'first' });
    const res = await post(cookie, { stars: 1, comment: 'second' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Already sent.');
    const review = await prisma.review.findUnique({ where: { userId: user.id } });
    expect(review.comment).toBe('first');
  });
});

describe('GET /api/review/already', () => {
  test('401 without a session', async () => {
    expect((await request(app).get('/api/review/already')).status).toBe(401);
  });

  test('"Can" before reviewing, 409 "Sent" after', async () => {
    const { cookie } = await createUser();
    const before = await request(app).get('/api/review/already').set('Cookie', cookie);
    expect(before.status).toBe(200);
    expect(before.body.message).toBe('Can');

    await post(cookie, { stars: 5 });
    const after = await request(app).get('/api/review/already').set('Cookie', cookie);
    expect(after.status).toBe(409);
    expect(after.body).toEqual({ success: false, message: 'Sent' });
  });

  test("another user's review does not block this user", async () => {
    const other = await createUser();
    await post(other.cookie, { stars: 2 });
    const { cookie } = await createUser();
    const res = await request(app).get('/api/review/already').set('Cookie', cookie);
    expect(res.body.message).toBe('Can');
  });
});
