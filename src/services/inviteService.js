import { createHash, randomBytes } from 'node:crypto';
import prisma from '../db/prisma.js';
import config from '../config/index.js';
import sendMail from './sendEmail.js';
import { inviteEmail } from './emailTemplates.js';

export const INVITE_TTL_HOURS = 48;

// The raw token (256 bits, base64url) appears only in the emailed link; at
// rest we keep its SHA-256. Brute force is not the threat at this entropy —
// constant-time lookup by hash is the point.
export const hashToken = (token) =>
  createHash('sha256').update(token).digest('hex');

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function acceptUrlFor(token) {
  return `${config.urls.appBase.replace(/\/+$/, '')}/invite/accept?token=${token}`;
}

/**
 * Create (or replace) a PENDING invite and email the recipient. If the email
 * cannot be handed to SendGrid the invite row is rolled back — an invite whose
 * link never arrives is a stuck state for that address.
 */
export async function createAndSendInvite({ building, role, email, invitedBy }) {
  const normalized = String(email).toLowerCase().trim();
  const token = newToken();

  const invite = await prisma.$transaction(async (tx) => {
    await tx.buildingInvite.updateMany({
      where: { buildingId: building.id, email: normalized, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });
    return tx.buildingInvite.create({
      data: {
        buildingId: building.id,
        email: normalized,
        roleId: role.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000),
        invitedById: invitedBy.id,
      },
    });
  });

  const inviterName =
    [invitedBy.name, invitedBy.lastname].filter(Boolean).join(' ') ||
    invitedBy.company ||
    invitedBy.email;

  try {
    const mail = inviteEmail({
      buildingName: building.name,
      roleName: role.name,
      inviterName,
      acceptUrl: acceptUrlFor(token),
      expiresHours: INVITE_TTL_HOURS,
    });
    await sendMail(normalized, mail.subject, mail.text, undefined, mail.html);
  } catch (err) {
    await prisma.buildingInvite.delete({ where: { id: invite.id } }).catch(() => {});
    throw err;
  }

  return invite;
}

/** Look up a PENDING, unexpired invite by raw token. */
export async function findValidInvite(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 128) {
    return null;
  }
  const invite = await prisma.buildingInvite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { building: { select: { id: true, name: true } }, role: true },
  });
  if (!invite) return null;
  if (invite.status !== 'PENDING') return null;
  if (invite.expiresAt <= new Date()) return null;
  return invite;
}

/** Accept an invite as `user` (email must match). */
export async function acceptInvite(invite, user) {
  if (String(user.email).toLowerCase() !== invite.email) {
    const err = new Error('This invitation was sent to a different email address.');
    err.status = 403;
    throw err;
  }
  return prisma.$transaction(async (tx) => {
    const membership = await tx.buildingMember.upsert({
      where: {
        buildingId_userId: { buildingId: invite.buildingId, userId: user.id },
      },
      create: {
        buildingId: invite.buildingId,
        userId: user.id,
        roleId: invite.roleId,
        invitedById: invite.invitedById,
      },
      update: { roleId: invite.roleId },
    });
    await tx.buildingInvite.update({
      where: { id: invite.id },
      data: { status: 'ACCEPTED', acceptedById: user.id, acceptedAt: new Date() },
    });
    return membership;
  });
}

/** Issue a fresh token for an existing PENDING invite and re-send the email. */
export async function resendInvite(invite, building, role, invitedBy) {
  const token = newToken();
  await prisma.buildingInvite.update({
    where: { id: invite.id },
    data: {
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000),
    },
  });

  const inviterName =
    [invitedBy.name, invitedBy.lastname].filter(Boolean).join(' ') ||
    invitedBy.company ||
    invitedBy.email;

  const mail = inviteEmail({
    buildingName: building.name,
    roleName: role.name,
    inviterName,
    acceptUrl: acceptUrlFor(token),
    expiresHours: INVITE_TTL_HOURS,
  });
  await sendMail(invite.email, mail.subject, mail.text, undefined, mail.html);
}
