import express from 'express';
const router = express.Router();

import bcrypt from 'bcrypt';

import prisma from '../../db/prisma.js';
import whoami from '../../middlewares/whoami.js';
import sendMail from '../../services/sendEmail.js';
import { displayName } from '../../services/displayName.js';
import { checkNames } from '../../services/validation.js';
import { emailLimiter, authLimiter } from '../../services/rateLimiter.js';
import { ok, fail } from '../../utils/respond.js';
import {
  issueVerification,
  findActiveVerification,
  compareCode,
  recordFailedAttempt,
  LONG_CODE_TTL_MS,
} from '../../services/verificationCodes.js';
import {
  signSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from '../../utils/session.js';

// GET /api/settings
router.get('/api/settings', whoami, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return fail(res, 404, "User not found.");

    // Response keys are the ones the frontend already reads; only the source
    // columns changed (phones -> phone, TwoFactorEnabled -> twoFactorEnabled).
    const settings = {
      country: user.country,
      phone: user.phone,
      verified: user.verified,
      userType: user.userType,
      name: user.name,
      lastname: user.lastname,
      company: user.company,
      TwoFactorEnabled: user.twoFactorEnabled,
    };

    return ok(res, { data: settings });
  } catch (err) {
    console.error('GET /api/settings error:', err);
    return fail(res, 500, "Server error.");
  }
});

// PUT /api/settings/save
// Saves the fields the settings page actually sends.
router.put('/api/settings/save', whoami, async (req, res) => {
  const { name, lastname, company, country, phone } = req.body;

  try {
    const userType = req.user.userType;

    const nameError = checkNames({ userType, name, lastname, company });
    if (nameError) return fail(res, 400, nameError);

    if (!country || !phone) return fail(res, 400, "Invalid fields.");

    // Only write the name fields that apply to this account type, so a Company
    // cannot end up with a personal name attached (and vice versa).
    const updates = {
      country: String(country),
      phone: String(phone),
    };

    if (userType === 'INDIVIDUAL') {
      updates.name = name.trim();
      updates.lastname = lastname.trim();
    } else {
      updates.company = company.trim();
    }

    await prisma.user.update({ where: { id: req.user.id }, data: updates });

    return ok(res, { message: "Profile saved." });
  } catch (err) {
    console.error('PUT /api/settings/save error:', err);
    return fail(res, 500, "Server error.");
  }
});

// PUT /api/settings/changePassword
router.put('/api/settings/changePassword', whoami, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) return fail(res, 400, "Invalid fields.");
  if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 16) {
    return fail(res, 400, "Password must be 6-16 characters.");
  }

  try {
    // password is globally omitted, so it must be opted back in here.
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      omit: { password: false },
    });
    const oldPasswordMatches = await bcrypt.compare(String(oldPassword), user.password || '');
    if (!oldPasswordMatches) return fail(res, 401, "Old password is incorrect.");

    const newPasswordMatchesOld = await bcrypt.compare(newPassword, user.password);
    if (newPasswordMatchesOld) return fail(res, 400, "You cannot use the same password.");

    const hashed = await bcrypt.hash(newPassword, 10);
    // Cuts off every session issued before the change, so a stolen cookie stops
    // working, and drops the trusted-address list a session thief may have
    // extended. The caller's own session is re-issued below rather than dropped.
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        tokenVersion: { increment: 1 },
        trustedIps: [],
      },
    });

    setSessionCookie(req, res, signSessionToken(updated));

    ok(res, { message: "Password updated successfully." });
    try {
        const passwordChangedHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">✅ Password Changed Successfully</h1>
              <p style="color: #333; font-size: 16px;">Hello <strong>${displayName(user)}</strong>,</p>
              <p style="color: #666;">Your password has been successfully changed.</p>
              <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #4caf50;">
                <p style="margin: 0; color: #2e7d32; font-weight: bold;">✓ Security Update</p>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">If you didn't make this change, please contact us immediately.</p>
              </div>
              <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
            </div>
          </div>
        `;
        await sendMail(user.email, 'Password Changed - AlertUp', `Hello ${displayName(user)}, your password has been changed successfully.`, undefined, passwordChangedHTML);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }
  } catch (err) {
    console.error('PUT /api/settings/changePassword error:', err);
    return fail(res, 500, "Server error.");
  }
});

// POST /api/settings/email - send verification code for new email
router.post('/api/settings/email', whoami, emailLimiter, async (req, res) => {
  const { newEmail } = req.body;
  if (typeof newEmail !== 'string' || !newEmail.includes('@')) return fail(res, 400, "Invalid email.");

  const normalizedEmail = newEmail.toLowerCase().trim();

  try {
    const user = req.user;

    // Scoped by type: an unscoped delete would also destroy any pending 2FA or
    // password-reset code the user had in flight.
    await prisma.verification.deleteMany({
      where: { userId: user.id, type: 'change email' },
    });

    if (user.email === normalizedEmail) return fail(res, 400, "Can't use the same email.");

    const taken = await prisma.user.findFirst({
      where: { email: normalizedEmail, NOT: { id: user.id } },
    });
    if (taken) return fail(res, 409, "That email is already in use.");

    // Hashed code, 10-minute expiry. pendingEmail binds the code to the
    // address it is mailed to, so the address proven at verification time is
    // the one that actually received the code.
    const { code } = await issueVerification({
      userId: user.id,
      type: 'change email',
      ttlMs: LONG_CODE_TTL_MS,
      pendingEmail: normalizedEmail,
    });

    ok(res, { message: "Verification code sent." });
    try {
        const emailVerifyHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">📧 Verify Your New Email</h1>
              <p style="color: #333; font-size: 16px;">Hello,</p>
              <p style="color: #666;">You requested to change your email address. Use the verification code below:</p>
              <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center; border: 2px dashed #FF7B22;">
                <p style="margin: 0; font-size: 32px; font-weight: bold; color: #FF7B22; letter-spacing: 5px;">${code}</p>
              </div>
              <p style="color: #666; font-size: 14px;">This code will expire in 10 minutes.</p>
              <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
            </div>
          </div>
        `;
        await sendMail(normalizedEmail, "Verify new email - AlertUp", `Your verification code is: ${code}`, undefined, emailVerifyHTML);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }
  } catch (err) {
    console.error('POST /api/settings/email error:', err);
    return fail(res, 500, "Server error.");
  }
});

// PUT /api/settings/email - verify new email
router.put('/api/settings/email', whoami, async (req, res) => {
  const { newEmail, userCode } = req.body;
  if (typeof newEmail !== 'string' || !userCode || !newEmail.includes('@') || String(userCode).length !== 6)
    return fail(res, 400, "Invalid fields.");

  const normalizedEmail = newEmail.toLowerCase().trim();

  try {
    const user = req.user;
    const verification = await findActiveVerification(user.id, 'change email');

    if (!verification) return fail(res, 400, "Verification expired or invalid.");
    if (verification.expiresAt.getTime() < Date.now()) {
      await prisma.verification.delete({ where: { id: verification.id } }).catch(() => {});
      return fail(res, 400, "Verification code expired.");
    }

    // The submitted address must be the one the code was mailed to. Without
    // this, an attacker could request a code to an address they control and
    // then submit a victim's address, moving the victim's email onto their
    // own account.
    if (verification.pendingEmail !== normalizedEmail)
      return fail(res, 400, "This code was issued for a different email address.");

    const codeMatches = await compareCode(userCode, verification);
    if (!codeMatches) {
      const destroyed = await recordFailedAttempt(verification);
      if (destroyed) {
        return fail(res, 400, "Too many incorrect attempts. Request a new code.");
      }
      return fail(res, 400, "Invalid code.");
    }

    // Re-checked here because the address may have been claimed in the window
    // between requesting the code and submitting it. The unique constraint on
    // users.email backstops the remaining race.
    const taken = await prisma.user.findFirst({
      where: { email: normalizedEmail, NOT: { id: user.id } },
    });
    if (taken) return fail(res, 409, "That email is already in use.");

    try {
      await prisma.user.update({ where: { id: user.id }, data: { email: normalizedEmail } });
    } catch (err) {
      if (err.code === 'P2002') return fail(res, 409, "That email is already in use.");
      throw err;
    }
    await prisma.verification.delete({ where: { id: verification.id } }).catch(() => {});

    ok(res, { message: "Email updated successfully." });
    try {
        const emailUpdatedHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">✅ Email Updated Successfully</h1>
              <p style="color: #333; font-size: 16px;">Hello,</p>
              <p style="color: #666;">Your email address has been successfully updated to <strong>${normalizedEmail}</strong>.</p>
              <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #4caf50;">
                <p style="margin: 0; color: #2e7d32; font-weight: bold;">✓ Update Complete</p>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">All future notifications will be sent to this email address.</p>
              </div>
              <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
            </div>
          </div>
        `;
        await sendMail(normalizedEmail, 'Email Updated - AlertUp', `Your email has been updated successfully.`, undefined, emailUpdatedHTML);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }
  } catch (err) {
    console.error('PUT /api/settings/email error:', err);
    return fail(res, 500, "Server error.");
  }
});

// POST /api/settings/verify - send account verification code
router.post('/api/settings/verify', whoami, emailLimiter, async (req, res) => {
  try {
    const user = req.user;

    const { code } = await issueVerification({
      userId: user.id,
      type: 'verify account',
      ttlMs: LONG_CODE_TTL_MS,
    });

    ok(res, { message: "Verification code sent." });
    try {
        const accountVerifyHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">🔐 Verify Your Account</h1>
              <p style="color: #333; font-size: 16px;">Hello <strong>${displayName(user)}</strong>,</p>
              <p style="color: #666;">Please verify your AlertUp account using the code below:</p>
              <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center; border: 2px dashed #FF7B22;">
                <p style="margin: 0; font-size: 32px; font-weight: bold; color: #FF7B22; letter-spacing: 5px;">${code}</p>
              </div>
              <p style="color: #666; font-size: 14px;">This code will expire in 10 minutes.</p>
              <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
            </div>
          </div>
        `;
        await sendMail(user.email, 'Verify Account - AlertUp', `Your account verification code is: ${code}`, undefined, accountVerifyHTML);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }
  } catch (err) {
    console.error('POST /api/settings/verify error:', err);
    return fail(res, 500, "Server error.");
  }
});

// PUT /api/settings/verify - verify account
router.put('/api/settings/verify', whoami, authLimiter, async (req, res) => {
  const { userCode } = req.body;

  // Coerced first: a code sent as a JSON number has no .length.
  if (!userCode || String(userCode).length !== 6) return fail(res, 400, "Invalid verification code.");

  try {
    const user = req.user;
    const verification = await findActiveVerification(user.id, 'verify account');

    if (!verification) return fail(res, 400, "Verification expired or invalid.");
    if (verification.expiresAt.getTime() < Date.now()) {
      await prisma.verification.delete({ where: { id: verification.id } }).catch(() => {});
      return fail(res, 400, "Verification expired.");
    }

    const codeMatches = await compareCode(userCode, verification);
    if (!codeMatches) {
      const destroyed = await recordFailedAttempt(verification);
      if (destroyed) {
        return fail(res, 400, "Too many incorrect attempts. Request a new code.");
      }
      return fail(res, 400, "Invalid code.");
    }

    await prisma.user.update({ where: { id: user.id }, data: { verified: true } });
    await prisma.verification.delete({ where: { id: verification.id } }).catch(() => {});

    ok(res, { message: "Account verified." });
    try {
      const verifiedHTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h1 style="color: #FF7B22; margin-top: 0;">🎉 Account Verified!</h1>
            <p style="color: #333; font-size: 16px;">Hello <strong>${displayName(user)}</strong>,</p>
            <p style="color: #666;">Your AlertUp account has been successfully verified!</p>
            <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #4caf50;">
              <p style="margin: 0; color: #2e7d32; font-weight: bold;">✓ Verification Complete</p>
              <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">You now have full access to all AlertUp features.</p>
            </div>
            <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
          </div>
        </div>
      `;
      await sendMail(user.email, "Account Verified - AlertUp", "Your account has been successfully verified.", undefined, verifiedHTML);
    } catch (err) {
      console.error("MAIL ERROR:", err);
    }
  } catch (err) {
    console.error('PUT /api/settings/verify error:', err);
    return fail(res, 500, "Server error.");
  }
});

// POST /api/settings/account - delete account
router.post('/api/settings/account', whoami, async (req, res) => {
  const { password } = req.body;
  if (!password) return fail(res, 400, "Password required.");
  try {
    // password is globally omitted, so it must be opted back in here.
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      omit: { password: false },
    });
    const validPassword = await bcrypt.compare(String(password), user.password || '');
    if (!validPassword) return fail(res, 401, "Incorrect password.");

    // Removes their buildings, floors, nodes, logs, emergencies and reviews
    // too — the farewell email below promises exactly that.
    //
    // Postgres FK cascades handle everything hanging off a building and off the
    // user, with two exceptions handled explicitly here:
    //  - buildings.ownerId has no ON DELETE action, so owned buildings are
    //    deleted first (their delete cascades floors/nodes/edges/roles/
    //    members/invites/logs/scans);
    //  - members/invites reference roles with RESTRICT, so they are removed
    //    before the building delete cascades the roles away, and invites this
    //    user sent into other people's buildings are removed before the user.
    await prisma.$transaction(async (tx) => {
      await tx.buildingMember.deleteMany({ where: { building: { ownerId: user.id } } });
      await tx.buildingInvite.deleteMany({ where: { building: { ownerId: user.id } } });
      await tx.building.deleteMany({ where: { ownerId: user.id } });
      await tx.buildingInvite.deleteMany({ where: { invitedById: user.id } });
      await tx.user.delete({ where: { id: user.id } });
    });

    clearSessionCookie(req, res);

    ok(res, { message: "Account deleted." });
    try {
        const goodbyeHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">👋 Goodbye</h1>
              <p style="color: #333; font-size: 16px;">Hello <strong>${displayName(user)}</strong>,</p>
              <p style="color: #666;">Your AlertUp account has been successfully deleted.</p>
              <div style="background-color: #fff3e0; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ff9800;">
                <p style="margin: 0; color: #e65100; font-weight: bold;">Account Deleted</p>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">All your data has been permanently removed from our system.</p>
              </div>
              <p style="color: #666; font-size: 14px;">We're sorry to see you go. If you change your mind, you're always welcome back!</p>
              <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
            </div>
          </div>
        `;
        await sendMail(user.email, 'Goodbye - AlertUp', `Goodbye ${displayName(user)}, your account has been deleted.`, undefined, goodbyeHTML);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }
  } catch (err) {
    console.error('POST /api/settings/account error:', err);
    return fail(res, 500, "Server error.");
  }
});

// POST /api/settings/logout
router.post('/api/settings/logout', whoami, async (req, res) => {
  try {
    // Attributes must match the ones login set, or the browser keeps the cookie.
    clearSessionCookie(req, res);
    return ok(res, { message: "Logged out successfully." });
  } catch {
    return fail(res, 500, "Server error.");
  }
});

export default router;
