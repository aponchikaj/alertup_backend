import { Router } from 'express';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import { requirePermission, requireMembership } from '../../middlewares/requireBuildingPermission.js';
import { ok, fail } from '../../utils/respond.js';
import { PERMISSIONS, isSubset } from '../../auth/permissions.js';
import sendMail from '../../services/sendEmail.js';
import { roleChangedEmail, removedFromBuildingEmail } from '../../services/emailTemplates.js';

const router = Router();

const actorMayGrant = (req, permissions) =>
  req.buildingPermissions === '*' || isSubset(permissions, req.buildingPermissions);

const memberShape = (m) => ({
  userId: m.userId,
  name: m.user.name,
  lastname: m.user.lastname,
  company: m.user.company,
  email: m.user.email,
  role: { id: m.role.id, name: m.role.name, permissions: m.role.permissions },
  joinedAt: m.createdAt,
});

router.get(
  '/api/buildings/:buildingId/members',
  whoami,
  requireMembership,
  async (req, res) => {
    try {
      const [members, owner] = await Promise.all([
        prisma.buildingMember.findMany({
          where: { buildingId: req.building.id },
          include: {
            user: { select: { name: true, lastname: true, company: true, email: true } },
            role: true,
          },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.user.findUnique({
          where: { id: req.building.ownerId },
          select: { id: true, name: true, lastname: true, company: true, email: true },
        }),
      ]);

      return ok(res, {
        data: {
          owner: owner
            ? {
                userId: owner.id,
                name: owner.name,
                lastname: owner.lastname,
                company: owner.company,
                email: owner.email,
              }
            : null,
          members: members
            .filter((m) => m.userId !== req.building.ownerId)
            .map(memberShape),
        },
      });
    } catch (err) {
      console.error('List members error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.patch(
  '/api/buildings/:buildingId/members/:userId',
  whoami,
  requirePermission(PERMISSIONS.CAN_MANAGE_ROLES),
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { roleId } = req.body || {};
      if (!roleId) return fail(res, 422, 'roleId is required.');
      if (userId === req.building.ownerId) {
        return fail(res, 403, "The owner's membership cannot be changed.");
      }
      if (userId === req.user.id && !req.isOwner) {
        return fail(res, 403, 'You cannot change your own role.');
      }

      const [membership, role] = await Promise.all([
        prisma.buildingMember.findUnique({
          where: { buildingId_userId: { buildingId: req.building.id, userId } },
          include: { role: true },
        }),
        prisma.role.findFirst({ where: { id: roleId, buildingId: req.building.id } }),
      ]);
      if (!membership) return fail(res, 404, 'Member not found.');
      if (!role) return fail(res, 404, 'Role not found.');

      // Anti-escalation both directions: the member's current role and the new
      // role must both be within the actor's own permissions.
      if (!actorMayGrant(req, membership.role.permissions)) {
        return fail(res, 403, 'You cannot manage a member whose role exceeds your permissions.');
      }
      if (!actorMayGrant(req, role.permissions)) {
        return fail(res, 403, 'You cannot grant permissions you do not hold yourself.');
      }

      const updated = await prisma.buildingMember.update({
        where: { id: membership.id },
        data: { roleId: role.id },
        include: {
          user: { select: { name: true, lastname: true, company: true, email: true } },
          role: true,
        },
      });

      try {
        const mail = roleChangedEmail({ buildingName: req.building.name, roleName: role.name });
        await sendMail(updated.user.email, mail.subject, mail.text, undefined, mail.html);
      } catch {
        // Notification failure must not fail the role change.
      }

      return ok(res, { message: 'Role updated.', data: { member: memberShape(updated) } });
    } catch (err) {
      console.error('Update member error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// Self-removal (leave building) is allowed for any member; removing others
// needs CAN_MANAGE_ROLES and the subset rule. The owner can never be removed.
router.delete(
  '/api/buildings/:buildingId/members/:userId',
  whoami,
  requireMembership,
  async (req, res) => {
    try {
      const { userId } = req.params;
      if (userId === req.building.ownerId) {
        return fail(res, 403, 'The owner cannot be removed.');
      }

      const removingSelf = userId === req.user.id;
      const canManage =
        req.buildingPermissions === '*' ||
        req.buildingPermissions.includes(PERMISSIONS.CAN_MANAGE_ROLES);
      if (!removingSelf && !canManage) {
        return fail(res, 403, 'You do not have permission to remove members.');
      }

      const membership = await prisma.buildingMember.findUnique({
        where: { buildingId_userId: { buildingId: req.building.id, userId } },
        include: {
          role: true,
          user: { select: { email: true } },
        },
      });
      if (!membership) return fail(res, 404, 'Member not found.');

      if (!removingSelf && !actorMayGrant(req, membership.role.permissions)) {
        return fail(res, 403, 'You cannot remove a member whose role exceeds your permissions.');
      }

      await prisma.buildingMember.delete({ where: { id: membership.id } });

      if (!removingSelf) {
        try {
          const mail = removedFromBuildingEmail({ buildingName: req.building.name });
          await sendMail(membership.user.email, mail.subject, mail.text, undefined, mail.html);
        } catch {
          // Notification failure must not fail the removal.
        }
      }

      return ok(res, { message: removingSelf ? 'You left the building.' : 'Member removed.' });
    } catch (err) {
      console.error('Remove member error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

export default router;
