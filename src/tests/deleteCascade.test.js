import request from 'supertest';
import app from '../../server.js';
import prisma from '../db/prisma.js';
import { createUser, createOwnerWithBuilding, addMember } from './helpers.js';

/* ============================================================================
   FX-012 — deletes that must succeed.

   BuildingMember.role and BuildingInvite.role used Prisma's default
   `onDelete: Restrict`. Postgres checks RESTRICT immediately, while a
   building delete is still cascading through its roles, so a building that
   had any member or invite could not be deleted — and a role that had ever
   been used in an invite (even a revoked or accepted one) could not be either.
   ========================================================================= */

const anyRole = (roles) => Object.values(roles).find((r) => !r.isSystem) ?? Object.values(roles)[0];

test('an owner can delete a building that has a member and an invite', async () => {
  const { cookie, user, building, roles } = await createOwnerWithBuilding();
  const { user: member } = await createUser();
  const role = anyRole(roles);
  await addMember(building.id, member.id, role.id);
  await prisma.buildingInvite.create({
    data: {
      buildingId: building.id,
      roleId: role.id,
      email: 'later@example.com',
      tokenHash: `hash-${Date.now()}`,
      invitedById: user.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });

  const res = await request(app).delete(`/api/building/delete/${building.id}`).set('Cookie', cookie);

  expect(res.status).toBe(200);
  expect(await prisma.building.findUnique({ where: { id: building.id } })).toBeNull();
});

test('a custom role used by an old accepted invite can be deleted', async () => {
  const { cookie, user, building } = await createOwnerWithBuilding();
  const role = await prisma.role.create({
    data: { buildingId: building.id, name: 'Temp', permissions: [], isSystem: false },
  });
  await prisma.buildingInvite.create({
    data: {
      buildingId: building.id,
      roleId: role.id,
      email: 'old@example.com',
      tokenHash: `hash-old-${Date.now()}`,
      invitedById: user.id,
      status: 'ACCEPTED',
      expiresAt: new Date(Date.now() - 3600_000),
    },
  });

  const res = await request(app)
    .delete(`/api/buildings/${building.id}/roles/${role.id}`)
    .set('Cookie', cookie);

  expect(res.status).toBe(200);
  expect(await prisma.role.findUnique({ where: { id: role.id } })).toBeNull();
});
