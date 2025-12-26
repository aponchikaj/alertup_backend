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
        return res.status(400).json({ success: false, message: "Invalid user." });
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            return res.status(404).json(result);
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

        await sendMail(
            USER.email,
            "Reset password - AlertUp",
            `Hello ${USER.username}, your password reset code is ${code}. 
If this wasn't you, please contact support immediately.`
        );

        return res.json({ success: true, message: "Verification code sent." });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Server error." });
    }
});

/* ================= VERIFY CODE ================= */

router.post("/api/reset/verify-code", async (req, res) => {
    const { user, code } = req.body;

    if (!user || !code) {
        return res.status(400).json({ success: false, message: "Invalid fields." });
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            return res.status(404).json(result);
        }

        const USER = result.user;

        const verification = await VERIFICATIONS.findOne({
            verificationBy: USER._id,
            verificationType: "reset",
        });

        if (!verification) {
            return res.status(400).json({ success: false, message: "Invalid or expired code." });
        }

        if (verification.expires < Date.now()) {
            await VERIFICATIONS.deleteOne({ _id: verification._id });
            return res.status(400).json({ success: false, message: "Code expired." });
        }

        if (verification.verificationCode !== code) {
            return res.status(400).json({ success: false, message: "Invalid code." });
        }

        // Mark verification as confirmed
        verification.verified = true;
        await verification.save();

        // Auto-verify account if not verified
        if (!USER.verified) {
            USER.verified = true;
            await USER.save();

            await sendMail(
                USER.email,
                "Account Verified - AlertUp",
                `Hello ${USER.username}, your account has been verified successfully.`
            );
        }

        return res.json({ success: true, message: "Code verified." });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Server error." });
    }
});

/* ================= RESET PASSWORD ================= */

router.post("/api/reset/password", async (req, res) => {
    const { user, newPassword } = req.body;

    if (!user || !newPassword || newPassword.length < 6) {
        return res.status(400).json({
            success: false,
            message: "Password must be at least 6 characters.",
        });
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            return res.status(404).json(result);
        }

        const USER = result.user;

        const verification = await VERIFICATIONS.findOne({
            verificationBy: USER._id,
            verificationType: "reset",
            verified: true,
        });

        if (!verification) {
            return res.status(403).json({
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
        return res.status(500).json({ success: false, message: "Server error." });
    }
});

export default router;
