import { jest } from '@jest/globals';

// BE-37: every failure while creating an invite, database errors included,
// was reported as "The invitation email could not be sent" (502). Only a
// mail-provider failure is a 502 now; anything else is a plain 500.

const sendMailMock = jest.fn();
jest.unstable_mockModule('../services/sendEmail.js', () => ({ default: sendMailMock }));

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');
const { default: prisma } = await import('../db/prisma.js');
const { createOwnerWithBuilding } = await import('./helpers.js');

const setup = async () => {
  const { building, roles, cookie } = await createOwnerWithBuilding();
  return () =>
    request(app)
      .post(`/api/buildings/${building.id}/invites`)
      .set('Cookie', cookie)
      .send({ email: 'invitee@example.com', roleId: roles['Viewer'].id });
};

beforeEach(() => sendMailMock.mockReset());

test('a mail-provider failure is a 502 and leaves no invite behind', async () => {
  sendMailMock.mockRejectedValue(new Error('Resend rejected the message'));
  const invite = await setup();
  const res = await invite();
  expect(res.status).toBe(502);
  expect(res.body.message).toMatch(/email could not be sent/);
  expect(await prisma.buildingInvite.count()).toBe(0);
});

test('a database failure is a 500, not blamed on email', async () => {
  sendMailMock.mockResolvedValue({ success: true });
  const invite = await setup();
  const spy = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('connection reset'));
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await invite();
    expect(res.status).toBe(500);
    expect(res.body.message).not.toMatch(/email/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    errors.mockRestore();
  }
});

test('resend: a mail failure is a 502, a database failure a 500', async () => {
  sendMailMock.mockResolvedValue({ success: true });
  const { building, roles, cookie } = await createOwnerWithBuilding();
  const created = await request(app)
    .post(`/api/buildings/${building.id}/invites`)
    .set('Cookie', cookie)
    .send({ email: 'again@example.com', roleId: roles['Viewer'].id });
  const inviteId = created.body.data.invite.id;
  const resend = () =>
    request(app).post(`/api/buildings/${building.id}/invites/${inviteId}/resend`).set('Cookie', cookie);

  sendMailMock.mockRejectedValueOnce(new Error('Resend rejected the message'));
  expect((await resend()).status).toBe(502);

  const spy = jest.spyOn(prisma.buildingInvite, 'update').mockRejectedValueOnce(new Error('connection reset'));
  const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await resend()).status).toBe(500);
  } finally {
    spy.mockRestore();
    errors.mockRestore();
  }
});
