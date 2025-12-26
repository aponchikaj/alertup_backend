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
      username: user.username,
      country: user.country,
      phone: user.phones,
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
//   console.log(req.body)

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

    try {
        await sendMail(user.email, 'Password Changed - AlertUp', `Hello ${user.username}, your password has been changed successfully.`);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }

    return res.send({ Success: true, Message: "Password updated successfully." });
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
    try {
        await sendMail(newEmail, "Verify new email - AlertUp", `Your verification code is: ${code}`);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }

    return res.send({ Success: true, Message: "Verification code sent." });
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

    try {
        await sendMail(newEmail, 'Email Updated - AlertUp', `Your email has been updated successfully.`);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }

    return res.send({ Success: true, Message: "Email updated successfully." });
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
    try {
        await sendMail(user.email, 'Verify Account - AlertUp', `Your account verification code is: ${code}`);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }

    return res.send({ Success: true, Message: "Verification code sent." });
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

    try {
      await sendMail(user.email, "Account Verified - AlertUp", "Your account has been successfully verified.");
    } catch (err) {
      console.error("MAIL ERROR:", err);
    }

    return res.send({ Success: true, Message: "Account verified." });
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// POST /api/settings/account - delete account
router.post('/api/settings/account', whoami, async (req, res) => {
  const { password } = req.body;
    // console.log(req.body)
  if (!password) return res.send({ Success: false, Message: "Password required." });
  try {
    const user = await USERS.findById(req.user._id);
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.send({ Success: false, Message: "Incorrect password." });

    await USERS.findByIdAndDelete(user._id);
    await VERIFICATIONS.deleteMany({ verificationBy: user._id });
    res.clearCookie('userToken');

    try {
        await sendMail(user.email, 'Goodbye - AlertUp', `Goodbye ${user.username}, your account has been deleted.`);
    } catch (err) {
        console.error("MAIL ERROR:", err);
    }

    return res.send({ Success: true, Message: "Account deleted." });
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

// POST /api/settings/logout
router.post('/api/settings/logout', whoami, async (req, res) => {
    console.log("Logoutze shemovida")
  try {
    res.clearCookie('userToken', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // must match login
        sameSite: 'lax', // must match login
    });
    return res.send({ Success: true, Message: "Logged out successfully." });
  } catch {
    return res.send({ Success: false, Message: "Server error." });
  }
});

export default router;
