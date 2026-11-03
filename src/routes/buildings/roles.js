import { Router } from 'express';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import { requirePermission, requireMembership } from '../../middlewares/requireBuildingPermission.js';
import { ok, fail } from '../../utils/respond.js';
import { PERMISSIONS, isValidPermission, isSubset } from '../../auth/permissions.js';
import { recheckEditors } from '../../features/collab/collab.js';

const router = Router();

// Custom role builder. System roles are seeded per building and cannot be
// deleted; only the owner may edit them. Anti-escalation: actors may only
// create/edit roles whose permissions are a subset of their own.

const actorMayGrant = (req, permissions) =>
  req.buildingPermissions === '*' || isSubset(permissions, req.buildingPermissions);

function parseRoleBody(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : null;
  const permissions = body?.permissions;
  if (name !== null && (name.length < 2 || name.length > 40)) {
    return { error: 'Role name must be 2-40 characters.' };
  }
  if (permissions !== undefined) {
    if (!Array.isArray(permissions) || permissions.some((p) => !isValidPermission(p))) {
      return { error: 'permissions must be an array of valid permission keys.' };
    }
  }
  return { name, permissions: permissions ? [...new Set(permissions)] : undefined };
}

router.get(
  '/api/buildings/:buildingId/roles',
  whoami,
  requireMembership,
  async (req, res) => {
    try {
      const roles = await prisma.role.findMany({
        where: { buildingId: req.building.id },
        orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
        include: { _count: { select: { members: true } } },
      });
      return ok(res, {
        data: {
          roles: roles.map((r) => ({
            id: r.id,
            name: r.name,
            permissions: r.permissions,
            isSystem: r.isSystem,
            memberCount: r._count.members,
          })),
          allPermissions: Object.values(PERMISSIONS),
        },
      });
    } catch (err) {
      console.error('List roles error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.post(
  '/api/buildings/:buildingId/roles',
  whoami,
  requirePermission(PERMISSIONS.CAN_MANAGE_ROLES),
  async (req, res) => {
    try {
      const parsed = parseRoleBody(req.body);
      if (parsed.error) return fail(res, 422, parsed.error);
      if (!parsed.name || !parsed.permissions) {
        return fail(res, 422, 'name and permissions are required.');
      }
      if (!actorMayGrant(req, parsed.permissions)) {
        return fail(res, 403, 'You cannot grant permissions you do not hold yourself.');
      }

      const role = await prisma.role.create({
        data: {
          buildingId: req.building.id,
          name: parsed.name,
          permissions: parsed.permissions,
          isSystem: false,
        },
      });
      return ok(res, { status: 201, message: 'Role created.', data: { role } });
    } catch (err) {
      if (err.code === 'P2002') {
        return fail(res, 409, 'A role with that name already exists in this building.');
      }
      console.error('Create role error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.patch(
  '/api/buildings/:buildingId/roles/:roleId',
  whoami,
  requirePermission(PERMISSIONS.CAN_MANAGE_ROLES),
  async (req, res) => {
    try {
      const role = await prisma.role.findFirst({
        where: { id: req.params.roleId, buildingId: req.building.id },
      });
      if (!role) return fail(res, 404, 'Role not found.');
      if (role.isSystem && !req.isOwner) {
        return fail(res, 403, 'Only the owner can edit system roles.');
      }

      const parsed = parseRoleBody(req.body);
      if (parsed.error) return fail(res, 422, parsed.error);

      // Editing a role you could not have created is escalation by proxy —
      // both its current and its new permission set must be within reach.
      if (!actorMayGrant(req, role.permissions)) {
        return fail(res, 403, 'You cannot edit a role with permissions you do not hold.');
      }
      if (parsed.permissions && !actorMayGrant(req, parsed.permissions)) {
        return fail(res, 403, 'You cannot grant permissions you do not hold yourself.');
      }

      const updated = await prisma.role.update({
        where: { id: role.id },
        data: {
          ...(parsed.name ? { name: parsed.name } : {}),
          ...(parsed.permissions ? { permissions: parsed.permissions } : {}),
        },
      });
      void recheckEditors(req.building.id); // FX-056: editors who lost CAN_EDIT_MAP leave the room
      return ok(res, { message: 'Role updated.', data: { role: updated } });
    } catch (err) {
      if (err.code === 'P2002') {
        return fail(res, 409, 'A role with that name already exists in this building.');
      }
      console.error('Update role error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.delete(
  '/api/buildings/:buildingId/roles/:roleId',
  whoami,
  requirePermission(PERMISSIONS.CAN_MANAGE_ROLES),
  async (req, res) => {
    try {
      const role = await prisma.role.findFirst({
        where: { id: req.params.roleId, buildingId: req.building.id },
        include: { _count: { select: { members: true, invites: true } } },
      });
      if (!role) return fail(res, 404, 'Role not found.');
      if (role.isSystem) return fail(res, 403, 'System roles cannot be deleted.');
      if (!actorMayGrant(req, role.permissions)) {
        return fail(res, 403, 'You cannot delete a role with permissions you do not hold.');
      }
      if (role._count.members > 0) {
        return fail(res, 409, 'Reassign the members using this role before deleting it.');
      }

      // FX-012: BuildingInvite.role is ON DELETE RESTRICT, so ANY invite row
      // that names this role — revoked or accepted ones included — blocked the
      // delete with a 500. Invites for a deleted role can never be accepted
      // again, and an accepted invite's lasting record is the membership it
      // created, so the role's invite rows go with it.
      await prisma.$transaction(async (tx) => {
        await tx.buildingInvite.deleteMany({ where: { roleId: role.id } });
        await tx.role.delete({ where: { id: role.id } });
      });
      return ok(res, { message: 'Role deleted.' });
    } catch (err) {
      console.error('Delete role error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

export default router;
