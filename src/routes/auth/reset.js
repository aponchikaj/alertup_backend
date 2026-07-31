import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";

import USERS from "../../models/user.model.js";
import VERIFICATIONS from "../../models/verificatios.model.js";
import sendMail from "../../services/sendEmail.js";
import { displayName } from "../../services/displayName.js";
import { emailLimiter, authLimiter } from "../../services/rateLimiter.js";

const router = express.Router();

/* ================= HELPERS ================= */

// Reset is email-only. The previous non-email branch queried a `username`
// field that does not exist on the schema, so it could never match anything.
const findUser = async (identifier) => {
    // Must be a string: an object such as {"$ne": null} would otherwise reach
    // findOne as a query operator and match an arbitrary account.
    if (typeof identifier !== "string" || !identifier.includes("@")) {
        return { success: false, message: "Please enter the email address on your account." };
    }

    const user = await USERS.findOne({ email: identifier.toLowerCase().trim() });

    if (!user) {
        return { success: false, message: "User not found." };
    }

    return { success: true, user };
};

// Math.random() is an xorshift128+ PRNG whose state is recoverable from a few
// observed outputs, which would let an attacker predict a victim's next code.
const generateCode = () => crypto.randomInt(100000, 1000000);

// Wrong guesses allowed against a single reset code before it is destroyed.
const MAX_CODE_ATTEMPTS = 5;

/* ================= SEND CODE ================= */

router.post("/api/reset/send-code", emailLimiter, async (req, res) => {
    const { user } = req.body;

    if (!user) {
        return res.json({ success: false, message: "Invalid user." });
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            // Answering "User not found." here would turn this endpoint into an
            // account-enumeration oracle. Unknown addresses get the same reply a
            // real one does; the flow simply fails at the verify step.
            if (result.message === "User not found.") {
                return res.json({ success: true, message: "Verification code sent." });
            }
            return res.json(result);
        }

        const USER = result.user;

        // Remove old reset codes
        await VERIFICATIONS.deleteMany({
            verificationBy: USER._id,
            verificationType: "reset",
        });

        const code = generateCode();

        // Stored hashed, matching how 2FA codes are handled in routes/auth/2fa.js.
        // A reset code is a temporary credential and should not be readable from
        // the database.
        await VERIFICATIONS.create({
            verificationBy: USER._id,
            verificationType: "reset",
            verificationCode: await bcrypt.hash(String(code), 12),
            expires: Date.now() + 10 * 60 * 1000, // 10 minutes
        });

        res.json({ success: true, message: "Verification code sent." });
        try {
            const userName = displayName(USER);
            const resetHTML = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                  <h1 style="color: #FF7B22; margin-top: 0;">🔑 Password Reset Request</h1>
                  <p style="color: #333; font-size: 16px;">Hello <strong>${userName}</strong>,</p>
                  <p style="color: #666;">You requested to reset your password. Use the code below to complete the process:</p>
                  <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center; border: 2px dashed #FF7B22;">
                    <p style="margin: 0; font-size: 32px; font-weight: bold; color: #FF7B22; letter-spacing: 5px;">${code}</p>
                  </div>
                  <p style="color: #666; font-size: 14px;">This code will expire in 10 minutes.</p>
                  <div style="background-color: #ffebee; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #f44336;">
                    <p style="margin: 0; color: #c62828; font-weight: bold;">⚠️ Security Notice</p>
                    <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">If you didn't request this reset, please contact support immediately.</p>
                  </div>
                  <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
                </div>
              </div>
            `;
            await sendMail(
            USER.email,
            "Reset password - AlertUp",
            `Hello ${userName}, your password reset code is ${code}. If this wasn't you, please contact support immediately.`,
            undefined,
            resetHTML
        );
        } catch (err) {
            console.error("MAIL ERROR:", err);
        }
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Server error." });
    }
});

/* ================= VERIFY CODE ================= */

router.post("/api/reset/verify-code", authLimiter, async (req, res) => {
    const { user, code } = req.body;

    if (!user || !code) {
        return res.json({ success: false, message: "Invalid fields." });
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            return res.json(result);
        }

        const USER = result.user;

        const verification = await VERIFICATIONS.findOne({
            verificationBy: USER._id,
            verificationType: "reset",
        });

        if (!verification) {
            return res.json({ success: false, message: "Invalid or expired code." });
        }

        if (verification.expires < Date.now()) {
            await VERIFICATIONS.deleteOne({ _id: verification._id });
            return res.json({ success: false, message: "Code expired." });
        }

        const codeMatches = await bcrypt.compare(String(code), verification.verificationCode);
        if (!codeMatches) {
            // Destroy the code after repeated wrong guesses; the IP-keyed
            // limiter alone does not stop an attacker rotating addresses
            // through a 6-digit space.
            verification.attempts = (verification.attempts || 0) + 1;
            if (verification.attempts >= MAX_CODE_ATTEMPTS) {
                await VERIFICATIONS.deleteOne({ _id: verification._id });
                return res.json({ success: false, message: "Too many incorrect attempts. Request a new code." });
            }
            await verification.save();
            return res.json({ success: false, message: "Invalid code." });
        }

        // Mark verification as confirmed
        verification.verified = true;
        await verification.save();

        // Auto-verify account if not verified
        if (!USER.verified) {
            USER.verified = true;
            await USER.save();
        }

        return res.json({ success: true, message: "Code verified." });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Server error." });
    }
});

/* ================= RESET PASSWORD ================= */

router.post("/api/reset/password", authLimiter, async (req, res) => {
    const { user, newPassword, code } = req.body;

    if (!user || typeof newPassword !== "string" || newPassword.length < 6) {
        return res.json({
            success: false,
            message: "Password must be at least 6 characters.",
        });
    }

    // bcrypt silently truncates past 72 bytes, so a longer password would have
    // its tail ignored rather than rejected.
    if (Buffer.byteLength(newPassword) > 72) {
        return res.json({
            success: false,
            message: "Password must be at most 72 bytes.",
        });
    }

    if (!code) {
        return res.json({ success: false, message: "Reset verification required." });
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            return res.json(result);
        }

        const USER = result.user;

        const verification = await VERIFICATIONS.findOne({
            verificationBy: USER._id,
            verificationType: "reset",
            verified: true,
        });

        if (!verification) {
            return res.json({
                success: false,
                message: "Reset verification required.",
            });
        }

        // Without these two checks the endpoint accepted "some verified reset
        // record exists for this email" as authorization: a user who abandoned
        // a reset after entering the code left behind a record that never
        // expired, letting anyone who knew the address change the password.
        if (verification.expires < Date.now()) {
            await VERIFICATIONS.deleteOne({ _id: verification._id });
            return res.json({ success: false, message: "Code expired." });
        }

        const codeMatches = await bcrypt.compare(String(code), verification.verificationCode);
        if (!codeMatches) {
            verification.attempts = (verification.attempts || 0) + 1;
            if (verification.attempts >= MAX_CODE_ATTEMPTS) {
                await VERIFICATIONS.deleteOne({ _id: verification._id });
                return res.json({ success: false, message: "Too many incorrect attempts. Request a new code." });
            }
            await verification.save();
            return res.json({ success: false, message: "Invalid code." });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        USER.password = hashedPassword;
        // Invalidate every session issued before this reset — otherwise a user
        // resetting *because* their session was stolen leaves the thief's
        // 7-day token working.
        USER.tokenVersion = (USER.tokenVersion || 0) + 1;
        // A stolen-session attacker may have added their own address here.
        USER.trustedIPS = [];
        await USER.save();

        await VERIFICATIONS.deleteMany({
            verificationBy: USER._id,
            verificationType: "reset",
        });

        return res.json({ success: true, message: "Password changed successfully." });
    } catch (err) {
        console.error(err);
        return res.json({ success: false, message: "Server error." });
    }
});

export default router;
