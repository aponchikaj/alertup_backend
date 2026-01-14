import express from 'express';
const router = express.Router();

import USERS from '../../models/user.model.js';
import VERIFICATIONS from '../../models/verificatios.model.js';
import whoami from '../../middlewares/whoami.js';
import { Filter } from 'bad-words';
import bcrypt from 'bcrypt';
import sendMail from '../../services/sendEmail.js';

// Utility: check username validity
const checkUsername = async (username, currentUsername) => {
  if (!username) return "Invalid username.";
  if (username.length < 4 || username.length > 24) return "Username must be 4-24 characters.";
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return "Username contains invalid symbols.";

  const filter = new Filter();
  if (filter.isProfane(username)) return "Username contains forbidden words.";

  const existing = await USERS.findOne({ username });
  if (existing && existing.username !== currentUsername) return "Username already exists.";

  return null;
};

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
router.put('/api/settings/save', whoami, async (req, res) => {
  const { username, country, phone } = req.body;

  try {
    const usernameError = await checkUsername(username, req.user.username);
    if (usernameError) return res.send({ Success: false, Message: usernameError });

    if (!country || !phone ) return res.send({ Success: false, Message: "Invalid fields." });

    await USERS.findByIdAndUpdate(req.user._id, {
      username,
      country,
      phones: phone
    }, { new: true });

    return res.send({ Success: true, Message: "Profile saved." });
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// PUT /api/settings/change-password
router.put('/api/settings/changePassword', whoami, async (req, res) => {
  const { oldPassword, newPassword } = req.body;

  if (!oldPassword || !newPassword) return res.send({ Success: false, Message: "Invalid fields." });
  if (newPassword.length < 6 || newPassword.length > 16) return res.send({ Success: false, Message: "Password must be 6-16 characters." });

  try {
    const user = await USERS.findById(req.user._id);
    const oldPasswordMatches = await bcrypt.compare(oldPassword, user.password);
    if (!oldPasswordMatches) return res.send({ Success: false, Message: "Old password is incorrect." });

    const newPasswordMatchesOld = await bcrypt.compare(newPassword, user.password);
    if (newPasswordMatchesOld) return res.send({ Success: false, Message: "You cannot use the same password." });

    const hashed = await bcrypt.hash(newPassword, 10);
    await USERS.findByIdAndUpdate(user._id, { password: hashed });

    res.send({ Success: true, Message: "Password updated successfully." });
    try {
        const passwordChangedHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">✅ Password Changed Successfully</h1>
              <p style="color: #333; font-size: 16px;">Hello <strong>${user.username}</strong>,</p>
              <p style="color: #666;">Your password has been successfully changed.</p>
              <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #4caf50;">
                <p style="margin: 0; color: #2e7d32; font-weight: bold;">✓ Security Update</p>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">If you didn't make this change, please contact us immediately.</p>
              </div>
              <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
            </div>
          </div>
        `;
        await sendMail(user.email, 'Password Changed - AlertUp', `Hello ${user.username}, your password has been changed successfully.`, undefined, passwordChangedHTML);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// POST /api/settings/email - send verification code for new email
router.post('/api/settings/email', whoami, async (req, res) => {
  const { newEmail } = req.body;
  if (!newEmail || !newEmail.includes('@')) return res.send({ Success: false, Message: "Invalid email." });

  try {
    const user = await USERS.findById(req.user._id);

    // Delete previous verification if exists
    await VERIFICATIONS.findOneAndDelete({ verificationBy: user._id });

    if (user.email === newEmail) return res.send({ Success: false, Message: "Can't use the same email." });

    const code = Math.floor(Math.random() * 900000) + 100000; // 6-digit code

    const verification = new VERIFICATIONS({
      verificationType: 'change email',
      verificationCode: code,
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
        await sendMail(newEmail, "Verify new email - AlertUp", `Your verification code is: ${code}`, undefined, emailVerifyHTML);
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
  if (!newEmail || !userCode || !newEmail.includes('@') || userCode.toString().length !== 6)
    return res.send({ Success: false, Message: "Invalid fields." });

  try {
    const user = await USERS.findById(req.user._id);
    const verification = await VERIFICATIONS.findOne({ verificationBy: user._id, verificationType: 'change email' });

    if (!verification) return res.send({ Success: false, Message: "Verification expired or invalid." });
    if (verification.expires < Date.now()) {
      await VERIFICATIONS.findByIdAndDelete(verification._id);
      return res.send({ Success: false, Message: "Verification code expired." });
    }

    if (verification.verificationCode.toString() !== userCode.toString())
      return res.send({ Success: false, Message: "Invalid code." });

    await USERS.findByIdAndUpdate(user._id, { email: newEmail });
    await VERIFICATIONS.findByIdAndDelete(verification._id);


    res.send({ Success: true, Message: "Email updated successfully." });
    try {
        const emailUpdatedHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">✅ Email Updated Successfully</h1>
              <p style="color: #333; font-size: 16px;">Hello,</p>
              <p style="color: #666;">Your email address has been successfully updated to <strong>${newEmail}</strong>.</p>
              <div style="background-color: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #4caf50;">
                <p style="margin: 0; color: #2e7d32; font-weight: bold;">✓ Update Complete</p>
                <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">All future notifications will be sent to this email address.</p>
              </div>
              <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
            </div>
          </div>
        `;
        await sendMail(newEmail, 'Email Updated - AlertUp', `Your email has been updated successfully.`, undefined, emailUpdatedHTML);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// POST /api/settings/verify - send account verification code
router.post('/api/settings/verify', whoami, async (req, res) => {
  try {
    const user = await USERS.findById(req.user._id);
    await VERIFICATIONS.findOneAndDelete({ verificationBy: user._id, verificationType: 'verify account' });

    const code = Math.floor(Math.random() * 900000) + 100000;

    const verification = new VERIFICATIONS({
      verificationBy: user._id,
      verificationCode: code,
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
              <p style="color: #333; font-size: 16px;">Hello <strong>${user.username}</strong>,</p>
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
router.put('/api/settings/verify', whoami, async (req, res) => {
  const { userCode } = req.body;

  if (!userCode || userCode.length !== 6) return res.send({ Success: false, Message: "Invalid verification code." });

  try {
    const user = await USERS.findById(req.user._id);
    const verification = await VERIFICATIONS.findOne({ verificationBy: user._id, verificationType: 'verify account' });

    if (!verification) return res.send({ Success: false, Message: "Verification expired or invalid." });
    if (verification.expires < Date.now()) {
      await VERIFICATIONS.findByIdAndDelete(verification._id);
      return res.send({ Success: false, Message: "Verification expired." });
    }

    if (verification.verificationCode.toString() !== userCode.toString())
      return res.send({ Success: false, Message: "Invalid code." });

    await USERS.findByIdAndUpdate(user._id, { verified: true });
    await VERIFICATIONS.findByIdAndDelete(verification._id);

    res.send({ Success: true, Message: "Account verified." });
    try {
      const verifiedHTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h1 style="color: #FF7B22; margin-top: 0;">🎉 Account Verified!</h1>
            <p style="color: #333; font-size: 16px;">Hello <strong>${user.username}</strong>,</p>
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
    const user = await USERS.findById(req.user._id);
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.send({ Success: false, Message: "Incorrect password." });

    await USERS.findByIdAndDelete(user._id);
    await VERIFICATIONS.deleteMany({ verificationBy: user._id });
    
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
              <p style="color: #333; font-size: 16px;">Hello <strong>${user.username}</strong>,</p>
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
        await sendMail(user.email, 'Goodbye - AlertUp', `Goodbye ${user.username}, your account has been deleted.`, undefined, goodbyeHTML);
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
