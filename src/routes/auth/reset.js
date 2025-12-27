import express from "express";
import bcrypt from "bcrypt";

import USERS from "../../models/user.model.js";
import VERIFICATIONS from "../../models/verificatios.model.js";
import sendMail from "../../services/sendEmail.js";

const router = express.Router();

/* ================= HELPERS ================= */

const findUser = async (identifier) => {
    let user;
    if (identifier.includes("@")) {
        user = await USERS.findOne({ email: identifier });
    } else {
        user = await USERS.findOne({ username: identifier });
    }

    if (!user) {
        return { success: false, message: "User not found." };
    }

    return { success: true, user };
};

const generateCode = () =>
    Math.floor(100000 + Math.random() * 900000);

/* ================= SEND CODE ================= */

router.post("/api/reset/send-code", async (req, res) => {
    const { user } = req.body;

    if (!user) {
        return res.json({ success: false, message: "Invalid user." });
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            return res.json(result);
        }

        const USER = result.user;

        // Remove old reset codes
        await VERIFICATIONS.deleteMany({
            verificationBy: USER._id,
            verificationType: "reset",
        });

        const code = generateCode();

        await VERIFICATIONS.create({
            verificationBy: USER._id,
            verificationType: "reset",
            verificationCode: code,
            expires: Date.now() + 10 * 60 * 1000, // 10 minutes
        });

        res.json({ success: true, message: "Verification code sent." });
        try {
            const resetHTML = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                  <h1 style="color: #FF7B22; margin-top: 0;">🔑 Password Reset Request</h1>
                  <p style="color: #333; font-size: 16px;">Hello <strong>${USER.username}</strong>,</p>
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
            `Hello ${USER.username}, your password reset code is ${code}. If this wasn't you, please contact support immediately.`,
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

router.post("/api/reset/verify-code", async (req, res) => {
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

        if (verification.verificationCode !== code) {
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

router.post("/api/reset/password", async (req, res) => {
    const { user, newPassword } = req.body;

    if (!user || !newPassword || newPassword.length < 6) {
        return res.json({
            success: false,
            message: "Password must be at least 6 characters.",
        });
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

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        USER.password = hashedPassword;
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
