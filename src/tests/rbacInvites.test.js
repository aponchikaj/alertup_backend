import { jest } from '@jest/globals';

// Mock the mailer before anything imports it: SendGrid keys are blanked in
// tests, and the invite service deliberately rolls invites back when the
// email cannot be handed off.
const sendMailMock = jest.fn().mockResolvedValue({ Success: true });
jest.unstable_mockModule('../services/sendEmail.js', () => ({
  default: sendMailMock,
}));

const { default: request } = await import('supertest');
const { default: app } = await import('../../server.js');
const { default: prisma } = await import('../db/prisma.js');
const { createUser, createOwnerWithBuilding, addMember } = await import('./helpers.js');
const { hashToken } = await import('../services/inviteService.js');

beforeEach(() => sendMailMock.mockClear());

describe('roles API — custom role builder', () => {
  test('owner lists seeded system roles', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const res = await request(app)
      .get(`/api/buildings/${building.id}/roles`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const names = res.body.data.roles.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['Building Admin', 'Security Officer', 'Moderator', 'Viewer'])
    );
    expect(res.body.data.roles.every((r) => r.isSystem)).toBe(true);
    expect(res.body.data.allPermissions).toHaveLength(5);
  });

  test('owner creates a custom role; duplicate name is 409', async () => {
    const { cookie, building } = await createOwnerWithBuilding();
    const res = await request(app)
      .post(`/api/buildings/${building.id}/roles`)
      .set('Cookie', cookie)
      .send({ name: 'Night Guard', permissions: ['CAN_TRIGGER_EMERGENCY'] });
    expect(res.status).toBe(201);
    expect(res.body.data.role.permissions).toEqual(['CAN_TRIGGER_EMERGENCY']);
    expect(res.body.data.role.isSystem).toBe(false);

    const dup = await request(app)
      .post(`/api/buildings/${building.id}/roles`)
      .set('Cookie', cookie)
      .send({ name: 'Night Guard', permissions: [] });
    expect(dup.status).toBe(409);
  });

  test('anti-escalation: a manager cannot grant permissions they lack', async () => {
    const { building, roles } = await createOwnerWithBuilding();
    // Custom role with manage-roles but NOT trigger-emergency.
    const managerRole = await prisma.role.create({
      data: {
        buildingId: building.id,
        name: 'Role Manager',
        permissions: ['CAN_MANAGE_ROLES', 'CAN_VIEW_ANALYTICS'],
      },
    });
    const manager = await createUser();
    await addMember(building.id, manager.user.id, managerRole.id);

    const res = await request(app)
      .post(`/api/buildings/${building.id}/roles`)
      .set('Cookie', manager.cookie)
      .send({ name: 'Sneaky', permissions: ['CAN_TRIGGER_EMERGENCY'] });
    expect(res.status).toBe(403);

    // Within their own permissions is fine.
    const okRes = await request(app)
      .post(`/api/buildings/${building.id}/roles`)
      .set('Cookie', manager.cookie)
      .send({ name: 'Analyst', permissions: ['CAN_VIEW_ANALYTICS'] });
    expect(okRes.status).toBe(201);

    // And they cannot edit a role that exceeds them (system Building Admin).
    const adminRole = roles['Building Admin'];
    const editRes = await request(app)
      .patch(`/api/buildings/${building.id}/roles/${adminRole.id}`)
      .set('Cookie', manager.cookie)
      .send({ name: 'Renamed' });
    expect(editRes.status).toBe(403);
  });

  test('system roles cannot be deleted; in-use roles cannot be deleted', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();
    const del = await request(app)
      .delete(`/api/buildings/${building.id}/roles/${roles['Viewer'].id}`)
      .set('Cookie', cookie);
    expect(del.status).toBe(403);

    const custom = await prisma.role.create({
      data: { buildingId: building.id, name: 'Temp', permissions: [] },
    });
    const member = await createUser();
    await addMember(building.id, member.user.id, custom.id);
    const delInUse = await request(app)
      .delete(`/api/buildings/${building.id}/roles/${custom.id}`)
      .set('Cookie', cookie);
    expect(delInUse.status).toBe(409);
  });

  test('viewer cannot mutate roles', async () => {
    const { building, roles } = await createOwnerWithBuilding();
    const viewer = await createUser();
    await addMember(building.id, viewer.user.id, roles['Viewer'].id);
    const res = await request(app)
      .post(`/api/buildings/${building.id}/roles`)
      .set('Cookie', viewer.cookie)
      .send({ name: 'X', permissions: [] });
    expect(res.status).toBe(403);
  });
});

describe('invites flow', () => {
  test('full lifecycle: invite → validate → accept', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();
    const invitee = await createUser({ email: 'invitee@example.com' });

    const res = await request(app)
      .post(`/api/buildings/${building.id}/invites`)
      .set('Cookie', cookie)
      .send({ email: 'Invitee@Example.com', roleId: roles['Moderator'].id });
    expect(res.status).toBe(201);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    // Pull the raw token out of the emailed accept URL.
    const emailText = sendMailMock.mock.calls[0][2];
    const token = emailText.match(/token=([A-Za-z0-9_-]+)/)[1];

    // Public validation
    const validate = await request(app).get(`/api/invites/${token}`);
    expect(validate.status).toBe(200);
    expect(validate.body.data).toMatchObject({
      buildingName: building.name,
      roleName: 'Moderator',
      email: 'invitee@example.com',
      emailRegistered: true,
    });

    // Accept as the invitee
    const accept = await request(app)
      .post(`/api/invites/${token}/accept`)
      .set('Cookie', invitee.cookie);
    expect(accept.status).toBe(200);
    expect(accept.body.data.buildingId).toBe(building.id);

    const membership = await prisma.buildingMember.findUnique({
      where: {
        buildingId_userId: { buildingId: building.id, userId: invitee.user.id },
      },
      include: { role: true },
    });
    expect(membership.role.name).toBe('Moderator');

    // Token is single-use
    const reuse = await request(app)
      .post(`/api/invites/${token}/accept`)
      .set('Cookie', invitee.cookie);
    expect(reuse.status).toBe(404);
  });

  test('accept with a different email is rejected', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();
    const other = await createUser();

    await request(app)
      .post(`/api/buildings/${building.id}/invites`)
      .set('Cookie', cookie)
      .send({ email: 'someone-else@example.com', roleId: roles['Viewer'].id });
    const token = sendMailMock.mock.calls[0][2].match(/token=([A-Za-z0-9_-]+)/)[1];

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .set('Cookie', other.cookie);
    expect(res.status).toBe(403);
  });

  test('email failure rolls the invite back', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();
    sendMailMock.mockRejectedValueOnce(new Error('SendGrid down'));

    const res = await request(app)
      .post(`/api/buildings/${building.id}/invites`)
      .set('Cookie', cookie)
      .send({ email: 'fails@example.com', roleId: roles['Viewer'].id });
    expect(res.status).toBe(502);
    expect(
      await prisma.buildingInvite.count({ where: { email: 'fails@example.com' } })
    ).toBe(0);
  });

  test('inviting an existing member is 409; expired invite invalid', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();
    const member = await createUser();
    await addMember(building.id, member.user.id, roles['Viewer'].id);

    const dup = await request(app)
      .post(`/api/buildings/${building.id}/invites`)
      .set('Cookie', cookie)
      .send({ email: member.user.email, roleId: roles['Viewer'].id });
    expect(dup.status).toBe(409);

    // Expired token
    const expired = await prisma.buildingInvite.create({
      data: {
        buildingId: building.id,
        email: 'late@example.com',
        roleId: roles['Viewer'].id,
        tokenHash: hashToken('expired-token-value-123456'),
        expiresAt: new Date(Date.now() - 1000),
        invitedById: (await prisma.building.findUnique({ where: { id: building.id } }))
          .ownerId,
      },
    });
    const res = await request(app).get('/api/invites/expired-token-value-123456');
    expect(res.status).toBe(404);
    expect(expired.id).toBeTruthy();
  });

  test('revoke removes the pending invite from acceptance', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();
    await request(app)
      .post(`/api/buildings/${building.id}/invites`)
      .set('Cookie', cookie)
      .send({ email: 'revoked@example.com', roleId: roles['Viewer'].id });
    const token = sendMailMock.mock.calls[0][2].match(/token=([A-Za-z0-9_-]+)/)[1];
    const invite = await prisma.buildingInvite.findFirst({
      where: { email: 'revoked@example.com' },
    });

    const revoke = await request(app)
      .delete(`/api/buildings/${building.id}/invites/${invite.id}`)
      .set('Cookie', cookie);
    expect(revoke.status).toBe(200);

    const validate = await request(app).get(`/api/invites/${token}`);
    expect(validate.status).toBe(404);
  });
});

describe('members API', () => {
  test('role change respects the subset rule; owner immutable', async () => {
    const { cookie, building, roles } = await createOwnerWithBuilding();
    const member = await createUser();
    await addMember(building.id, member.user.id, roles['Viewer'].id);

    // Owner promotes member to Moderator
    const res = await request(app)
      .patch(`/api/buildings/${building.id}/members/${member.user.id}`)
      .set('Cookie', cookie)
      .send({ roleId: roles['Moderator'].id });
    expect(res.status).toBe(200);
    expect(res.body.data.member.role.name).toBe('Moderator');

    // Owner's membership can't be touched
    const building2 = await prisma.building.findUnique({ where: { id: building.id } });
    const ownerRes = await request(app)
      .patch(`/api/buildings/${building.id}/members/${building2.ownerId}`)
      .set('Cookie', cookie)
      .send({ roleId: roles['Viewer'].id });
    expect(ownerRes.status).toBe(403);
  });

  test('self-removal allowed; removing others needs CAN_MANAGE_ROLES', async () => {
    const { building, roles } = await createOwnerWithBuilding();
    const a = await createUser();
    const b = await createUser();
    await addMember(building.id, a.user.id, roles['Viewer'].id);
    await addMember(building.id, b.user.id, roles['Viewer'].id);

    // Viewer a cannot remove viewer b
    const forbidden = await request(app)
      .delete(`/api/buildings/${building.id}/members/${b.user.id}`)
      .set('Cookie', a.cookie);
    expect(forbidden.status).toBe(403);

    // Viewer a can leave
    const leave = await request(app)
      .delete(`/api/buildings/${building.id}/members/${a.user.id}`)
      .set('Cookie', a.cookie);
    expect(leave.status).toBe(200);
    expect(
      await prisma.buildingMember.count({
        where: { buildingId: building.id, userId: a.user.id },
      })
    ).toBe(0);
  });
});
