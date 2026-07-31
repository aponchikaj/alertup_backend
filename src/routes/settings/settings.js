import express from 'express';
const router = express.Router();

import USERS from '../../models/user.model.js';
import VERIFICATIONS from '../../models/verificatios.model.js';
import whoami from '../../middlewares/whoami.js';
import bcrypt from 'bcrypt';
import sendMail from '../../services/sendEmail.js';
import { displayName } from '../../services/displayName.js';
import { checkNames } from '../../services/validation.js';
import { emailLimiter, authLimiter } from '../../services/rateLimiter.js';
import { deleteUserCascade } from '../../services/cascadeDelete.js';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// Math.random() is predictable from a handful of observed outputs, which would
// let an attacker derive a victim's next verification code.
const generateCode = () => crypto.randomInt(100000, 1000000);

// Wrong guesses allowed against a single code before it is destroyed.
const MAX_CODE_ATTEMPTS = 5;

// GET /api/settings
router.get('/api/settings', whoami, async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id);
    if (!user) return res.send({ Success: false, Message: "User not found." });

    const settings = {
      country: user.country,
      phone: user.phones,
      verified:user.verified,
      userType:user.userType,
      name:user.name,
      lastname:user.lastname,
      company:user.company,
      TwoFactorEnabled:user.TwoFactorEnabled
    };

    return res.send({ Success: true, Message: settings });
  } catch (err) {
    return res.send({ Success: false, Message: "Server error." });
  }
}); 

// PUT /api/settings/save
// Saves the fields the settings page actually sends. This previously validated
// a `username` that neither the client nor the schema had, so every save was
// rejected and name/lastname/company could never be changed at all.
router.put('/api/settings/save', whoami, async (req, res) => {
  const { name, lastname, company, country, phone } = req.body;

  try {
    const userType = req.user.userType;

    const nameError = checkNames({ userType, name, lastname, company });
    if (nameError) return res.send({ Success: false, Message: nameError });

    if (!country || !phone) return res.send({ Success: false, Message: "Invalid fields." });

    // Only write the name fields that apply to this account type, so a Company
    // cannot end up with a personal name attached (and vice versa).
    const updates = {
      country,
      phones: phone,
    };

    if (userType === 'Individual') {
      updates.name = name.trim();
      updates.lastname = lastname.trim();
    } else {
      updates.company = company.trim();
    }

    await USERS.findByIdAndUpdate(req.user._id, updates, { new: true });

    return res.send({ Success: true, Message: "Profile saved." });
  } catch (err) {
    console.error('PUT /api/settings/save error:', err);
    return res.send({ Success: false, Message: "Server error." });
  }
});

// PUT /api/settings/change-password
router.put('/api/settings/changePassword', whoami, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) return res.send({ Success: false, Message: "Invalid fields." });
  if (newPassword.length < 6 || newPassword.length > 16) return res.send({ Success: false, Message: "Password must be 6-16 characters." });

  try {
    // password is select:false on the schema, so it must be requested here.
    const user = await USERS.findById(req.user._id).select('+password');
    const oldPasswordMatches = await bcrypt.compare(oldPassword, user.password);
    if (!oldPasswordMatches) return res.send({ Success: false, Message: "Old password is incorrect." });

    const newPasswordMatchesOld = await bcrypt.compare(newPassword, user.password);
    if (newPasswordMatchesOld) return res.send({ Success: false, Message: "You cannot use the same password." });

    const hashed = await bcrypt.hash(newPassword, 10);
    // Cuts off every session issued before the change, so a stolen cookie stops
    // working. The caller's own session is re-issued below rather than dropped.
    const updated = await USERS.findByIdAndUpdate(
      user._id,
      { password: hashed, $inc: { tokenVersion: 1 } },
      { new: true },
    );

    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('userToken', jwt.sign(
      { userID: updated._id, tokenVersion: updated.tokenVersion },
      process.env.JWT_SECRET,
      { expiresIn: '7d' },
    ), {
      httpOnly: true,
      secure: reqIsSecure,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
      sameSite: reqIsSecure ? 'None' : 'Lax',
    });

    res.send({ Success: true, Message: "Password updated successfully." });
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
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// POST /api/settings/email - send verification code for new email
router.post('/api/settings/email', whoami, emailLimiter, async (req, res) => {
  const { newEmail } = req.body;
  if (typeof newEmail !== 'string' || !newEmail.includes('@')) return res.status(400).send({ Success: false, Message: "Invalid email." });

  const normalizedEmail = newEmail.toLowerCase().trim();

  try {
    const user = await USERS.findById(req.user._id);

    // Scoped by type: an unscoped delete also destroyed any pending 2FA or
    // password-reset code the user had in flight.
    await VERIFICATIONS.findOneAndDelete({ verificationBy: user._id, verificationType: 'change email' });

    if (user.email === normalizedEmail) return res.send({ Success: false, Message: "Can't use the same email." });

    const taken = await USERS.findOne({ email: normalizedEmail, _id: { $ne: user._id } });
    if (taken) return res.send({ Success: false, Message: "That email is already in use." });

    const code = generateCode();

    const verification = new VERIFICATIONS({
      verificationType: 'change email',
      // Hashed, matching how the reset and 2FA flows store their codes.
      verificationCode: await bcrypt.hash(String(code), 12),
      // Binds the code to the address it is mailed to, so the address proven
      // at verification time is the one that actually received the code.
      pendingEmail: normalizedEmail,
      verificationBy: user._id,
      expires: Date.now() + 10 * 60 * 1000 // 10 minutes
    });

    await verification.save();

    res.send({ Success: true, Message: "Verification code sent." });
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
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// PUT /api/settings/email - verify new email
router.put('/api/settings/email', whoami, async (req, res) => {
  const { newEmail, userCode } = req.body;
  if (typeof newEmail !== 'string' || !userCode || !newEmail.includes('@') || userCode.toString().length !== 6)
    return res.status(400).send({ Success: false, Message: "Invalid fields." });

  const normalizedEmail = newEmail.toLowerCase().trim();

  try {
    const user = await USERS.findById(req.user._id);
    const verification = await VERIFICATIONS.findOne({ verificationBy: user._id, verificationType: 'change email' });

    if (!verification) return res.send({ Success: false, Message: "Verification expired or invalid." });
    if (verification.expires < Date.now()) {
      await VERIFICATIONS.findByIdAndDelete(verification._id);
      return res.send({ Success: false, Message: "Verification code expired." });
    }

    // The submitted address must be the one the code was mailed to. Without
    // this, an attacker could request a code to an address they control and
    // then submit a victim's address, moving the victim's email onto their
    // own account.
    if (verification.pendingEmail !== normalizedEmail)
      return res.send({ Success: false, Message: "This code was issued for a different email address." });

    const codeMatches = await bcrypt.compare(String(userCode), verification.verificationCode);
    if (!codeMatches) {
      verification.attempts = (verification.attempts || 0) + 1;
      if (verification.attempts >= MAX_CODE_ATTEMPTS) {
        await VERIFICATIONS.findByIdAndDelete(verification._id);
        return res.send({ Success: false, Message: "Too many incorrect attempts. Request a new code." });
      }
      await verification.save();
      return res.send({ Success: false, Message: "Invalid code." });
    }

    // Re-checked here because the address may have been claimed in the window
    // between requesting the code and submitting it.
    const taken = await USERS.findOne({ email: normalizedEmail, _id: { $ne: user._id } });
    if (taken) return res.send({ Success: false, Message: "That email is already in use." });

    await USERS.findByIdAndUpdate(user._id, { email: normalizedEmail });
    await VERIFICATIONS.findByIdAndDelete(verification._id);


    res.send({ Success: true, Message: "Email updated successfully." });
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
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// POST /api/settings/verify - send account verification code
router.post('/api/settings/verify', whoami, emailLimiter, async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id);
    await VERIFICATIONS.findOneAndDelete({ verificationBy: user._id, verificationType: 'verify account' });

    const code = generateCode();

    const verification = new VERIFICATIONS({
      verificationBy: user._id,
      verificationCode: await bcrypt.hash(String(code), 12),
      verificationType: 'verify account',
      expires: Date.now() + 10 * 60 * 1000
    });

    await verification.save();

    res.send({ Success: true, Message: "Verification code sent." });
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
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// PUT /api/settings/verify - verify account
router.put('/api/settings/verify', whoami, authLimiter, async (req, res) => {
  const { userCode } = req.body;

  // Coerced first: a code sent as a JSON number has no .length, so this check
  // rejected every numeric submission while the email-change route accepted it.
  if (!userCode || String(userCode).length !== 6) return res.status(400).send({ Success: false, Message: "Invalid verification code." });

  try {
    const user = await USERS.findById(req.user._id);
    const verification = await VERIFICATIONS.findOne({ verificationBy: user._id, verificationType: 'verify account' });

    if (!verification) return res.send({ Success: false, Message: "Verification expired or invalid." });
    if (verification.expires < Date.now()) {
      await VERIFICATIONS.findByIdAndDelete(verification._id);
      return res.send({ Success: false, Message: "Verification expired." });
    }

    const codeMatches = await bcrypt.compare(String(userCode), verification.verificationCode);
    if (!codeMatches) {
      verification.attempts = (verification.attempts || 0) + 1;
      if (verification.attempts >= MAX_CODE_ATTEMPTS) {
        await VERIFICATIONS.findByIdAndDelete(verification._id);
        return res.send({ Success: false, Message: "Too many incorrect attempts. Request a new code." });
      }
      await verification.save();
      return res.send({ Success: false, Message: "Invalid code." });
    }

    await USERS.findByIdAndUpdate(user._id, { verified: true });
    await VERIFICATIONS.findByIdAndDelete(verification._id);

    res.send({ Success: true, Message: "Account verified." });
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
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// POST /api/settings/account - delete account
router.post('/api/settings/account', whoami, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.send({ Success: false, Message: "Password required." });
  try {
    // password is select:false on the schema, so it must be requested here.
    const user = await USERS.findById(req.user._id).select('+password');
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.send({ Success: false, Message: "Incorrect password." });

    // Removes their buildings, floors, nodes, logs, emergencies and reviews
    // too — the farewell email below promises exactly that.
    await deleteUserCascade(user._id);

    // Determine whether the current request is secure (HTTPS)
    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.clearCookie('userToken', {
        httpOnly: true,
        secure: reqIsSecure,
        sameSite: reqIsSecure ? 'None' : 'Lax',
        path: '/',
    });

    res.send({ Success: true, Message: "Account deleted." });
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
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// POST /api/settings/logout
router.post('/api/settings/logout', whoami, async (req, res) => {
  try {
    // Determine whether the current request is secure (HTTPS)
    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    
    res.clearCookie('userToken', {
        httpOnly: true,
        secure: reqIsSecure, // must match login
        sameSite: reqIsSecure ? 'None' : 'Lax', // must match login
        path: '/', // must match login
    });
    return res.send({ Success: true, Message: "Logged out successfully." });
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

export default router;
