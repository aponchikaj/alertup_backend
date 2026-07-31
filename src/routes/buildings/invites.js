import { Router } from 'express';
import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import { requirePermission } from '../../middlewares/requireBuildingPermission.js';
import { ok, fail } from '../../utils/respond.js';
import { PERMISSIONS, isSubset } from '../../auth/permissions.js';
import { emailLimiter, publicReadLimiter } from '../../services/rateLimiter.js';
import { checkEmailFormat } from '../../services/validation.js';
import {
  createAndSendInvite,
  findValidInvite,
  acceptInvite,
  resendInvite,
} from '../../services/inviteService.js';

const router = Router();

const actorMayGrant = (req, permissions) =>
  req.buildingPermissions === '*' || isSubset(permissions, req.buildingPermissions);

const inviteShape = (i) => ({
  id: i.id,
  email: i.email,
  role: i.role ? { id: i.role.id, name: i.role.name } : null,
  status: i.status,
  expiresAt: i.expiresAt,
  createdAt: i.createdAt,
  expired: i.status === 'PENDING' && i.expiresAt <= new Date(),
});

router.get(
  '/api/buildings/:buildingId/invites',
  whoami,
  requirePermission(PERMISSIONS.CAN_INVITE_USERS),
  async (req, res) => {
    try {
      const invites = await prisma.buildingInvite.findMany({
        where: { buildingId: req.building.id, status: 'PENDING' },
        include: { role: true },
        orderBy: { createdAt: 'desc' },
      });
      return ok(res, { data: { invites: invites.map(inviteShape) } });
    } catch (err) {
      console.error('List invites error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

router.post(
  '/api/buildings/:buildingId/invites',
  whoami,
  requirePermission(PERMISSIONS.CAN_INVITE_USERS),
  emailLimiter,
  async (req, res) => {
    try {
      const { email, roleId } = req.body || {};
      // checkEmailFormat returns an error message, or null when the address is fine.
      const emailError = typeof email === 'string' ? checkEmailFormat(email) : 'Invalid email.';
      if (emailError) {
        return fail(res, 422, emailError);
      }
      if (!roleId) return fail(res, 422, 'roleId is required.');

      const normalized = email.toLowerCase().trim();

      const role = await prisma.role.findFirst({
        where: { id: roleId, buildingId: req.building.id },
      });
      if (!role) return fail(res, 404, 'Role not found.');
      if (!actorMayGrant(req, role.permissions)) {
        return fail(res, 403, 'You cannot invite with permissions you do not hold yourself.');
      }

      // Already the owner or a member?
      const existingUser = await prisma.user.findUnique({
        where: { email: normalized },
        select: { id: true },
      });
      if (existingUser) {
        if (existingUser.id === req.building.ownerId) {
          return fail(res, 409, 'That user owns this building.');
        }
        const existingMember = await prisma.buildingMember.findUnique({
          where: {
            buildingId_userId: {
              buildingId: req.building.id,
              userId: existingUser.id,
            },
          },
        });
        if (existingMember) {
          return fail(res, 409, 'That user is already a member of this building.');
        }
      }

      const invite = await createAndSendInvite({
        building: req.building,
        role,
        email: normalized,
        invitedBy: req.user,
      });

      return ok(res, {
        status: 201,
        message: 'Invitation sent.',
        data: { invite: inviteShape({ ...invite, role }) },
      });
    } catch (err) {
      console.error('Create invite error:', err);
      return fail(res, 502, 'The invitation email could not be sent. Please try again.');
    }
  }
);

router.post(
  '/api/buildings/:buildingId/invites/:inviteId/resend',
  whoami,
  requirePermission(PERMISSIONS.CAN_INVITE_USERS),
  emailLimiter,
  async (req, res) => {
    try {
      const invite = await prisma.buildingInvite.findFirst({
        where: {
          id: req.params.inviteId,
          buildingId: req.building.id,
          status: 'PENDING',
        },
        include: { role: true },
      });
      if (!invite) return fail(res, 404, 'Pending invitation not found.');
      if (!actorMayGrant(req, invite.role.permissions)) {
        return fail(res, 403, 'You cannot resend an invite whose role exceeds your permissions.');
      }

      await resendInvite(invite, req.building, invite.role, req.user);
      return ok(res, { message: 'Invitation re-sent.' });
    } catch (err) {
      console.error('Resend invite error:', err);
      return fail(res, 502, 'The invitation email could not be sent. Please try again.');
    }
  }
);

router.delete(
  '/api/buildings/:buildingId/invites/:inviteId',
  whoami,
  requirePermission(PERMISSIONS.CAN_INVITE_USERS),
  async (req, res) => {
    try {
      const updated = await prisma.buildingInvite.updateMany({
        where: {
          id: req.params.inviteId,
          buildingId: req.building.id,
          status: 'PENDING',
        },
        data: { status: 'REVOKED' },
      });
      if (updated.count === 0) return fail(res, 404, 'Pending invitation not found.');
      return ok(res, { message: 'Invitation revoked.' });
    } catch (err) {
      console.error('Revoke invite error:', err);
      return fail(res, 500, 'Server error.');
    }
  }
);

// Public: the accept page calls this to render the invitation before the user
// authenticates. Token in the path; response reveals only what the invited
// person needs to see.
router.get('/api/invites/:token', publicReadLimiter, async (req, res) => {
  try {
    const invite = await findValidInvite(req.params.token);
    if (!invite) {
      return fail(res, 404, 'This invitation is invalid, expired, or already used.');
    }
    const registered = await prisma.user.findUnique({
      where: { email: invite.email },
      select: { id: true },
    });
    return ok(res, {
      data: {
        buildingName: invite.building.name,
        roleName: invite.role.name,
        email: invite.email,
        expiresAt: invite.expiresAt,
        emailRegistered: Boolean(registered),
      },
    });
  } catch (err) {
    console.error('Validate invite error:', err);
    return fail(res, 500, 'Server error.');
  }
});

router.post('/api/invites/:token/accept', whoami, async (req, res) => {
  try {
    const invite = await findValidInvite(req.params.token);
    if (!invite) {
      return fail(res, 404, 'This invitation is invalid, expired, or already used.');
    }
    await acceptInvite(invite, req.user);
    return ok(res, {
      message: 'Invitation accepted.',
      data: { buildingId: invite.buildingId, buildingName: invite.building.name },
    });
  } catch (err) {
    if (err.status === 403) return fail(res, 403, err.message);
    console.error('Accept invite error:', err);
    return fail(res, 500, 'Server error.');
  }
});

export default router;
