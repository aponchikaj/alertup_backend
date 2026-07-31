import express from "express";
import bcrypt from "bcrypt";

import prisma from "../../db/prisma.js";
import sendMail from "../../services/sendEmail.js";
import { displayName } from "../../services/displayName.js";
import { emailLimiter, authLimiter } from "../../services/rateLimiter.js";
import { ok, fail } from "../../utils/respond.js";
import {
    issueVerification,
    findActiveVerification,
    compareCode,
    recordFailedAttempt,
    LONG_CODE_TTL_MS,
} from "../../services/verificationCodes.js";

const router = express.Router();

/* ================= HELPERS ================= */

// Reset is email-only.
const findUser = async (identifier) => {
    // Must be a string — anything else never reaches the query layer.
    if (typeof identifier !== "string" || !identifier.includes("@")) {
        return { success: false, status: 400, message: "Please enter the email address on your account." };
    }

    const user = await prisma.user.findUnique({
        where: { email: identifier.toLowerCase().trim() },
    });

    if (!user) {
        return { success: false, status: 404, message: "User not found." };
    }

    return { success: true, user };
};

/* ================= SEND CODE ================= */

router.post("/api/reset/send-code", emailLimiter, async (req, res) => {
    const { user } = req.body;

    if (!user) {
        return fail(res, 400, "Invalid user.");
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            // Answering "User not found." here would turn this endpoint into an
            // account-enumeration oracle. Unknown addresses get the same reply a
            // real one does; the flow simply fails at the verify step.
            if (result.message === "User not found.") {
                return ok(res, { message: "Verification code sent." });
            }
            return fail(res, result.status, result.message);
        }

        const USER = result.user;

        // Replaces any pending reset code with a fresh 10-minute one, stored
        // hashed — a reset code is a temporary credential and should not be
        // readable from the database.
        const { code } = await issueVerification({
            userId: USER.id,
            type: "reset",
            ttlMs: LONG_CODE_TTL_MS,
        });

        ok(res, { message: "Verification code sent." });
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
        return fail(res, 500, "Server error.");
    }
});

/* ================= VERIFY CODE ================= */

router.post("/api/reset/verify-code", authLimiter, async (req, res) => {
    const { user, code } = req.body;

    if (!user || !code) {
        return fail(res, 400, "Invalid fields.");
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            return fail(res, result.status, result.message);
        }

        const USER = result.user;

        // Excludes expired rows — the Mongo TTL index is gone, so the filter is
        // the only thing keeping a stale code from matching.
        const verification = await findActiveVerification(USER.id, "reset");

        if (!verification) {
            return fail(res, 400, "Invalid or expired code.");
        }

        if (verification.expiresAt.getTime() < Date.now()) {
            await prisma.verification.delete({ where: { id: verification.id } }).catch(() => {});
            return fail(res, 400, "Code expired.");
        }

        const codeMatches = await compareCode(code, verification);
        if (!codeMatches) {
            // Destroy the code after repeated wrong guesses; the IP-keyed
            // limiter alone does not stop an attacker rotating addresses
            // through a 6-digit space.
            const destroyed = await recordFailedAttempt(verification);
            if (destroyed) {
                return fail(res, 400, "Too many incorrect attempts. Request a new code.");
            }
            return fail(res, 400, "Invalid code.");
        }

        // Mark verification as confirmed
        await prisma.verification.update({
            where: { id: verification.id },
            data: { verified: true },
        });

        // Auto-verify account if not verified
        if (!USER.verified) {
            await prisma.user.update({
                where: { id: USER.id },
                data: { verified: true },
            });
        }

        return ok(res, { message: "Code verified." });
    } catch (err) {
        console.error(err);
        return fail(res, 500, "Server error.");
    }
});

/* ================= RESET PASSWORD ================= */

router.post("/api/reset/password", authLimiter, async (req, res) => {
    const { user, newPassword, code } = req.body;

    if (!user || typeof newPassword !== "string" || newPassword.length < 6) {
        return fail(res, 400, "Password must be at least 6 characters.");
    }

    // bcrypt silently truncates past 72 bytes, so a longer password would have
    // its tail ignored rather than rejected.
    if (Buffer.byteLength(newPassword) > 72) {
        return fail(res, 400, "Password must be at most 72 bytes.");
    }

    if (!code) {
        return fail(res, 400, "Reset verification required.");
    }

    try {
        const result = await findUser(user);
        if (!result.success) {
            return fail(res, result.status, result.message);
        }

        const USER = result.user;

        // Must be verified AND unexpired: "some verified reset record exists
        // for this email" is not authorization — an abandoned reset must not
        // linger as a standing credential.
        const verification = await findActiveVerification(USER.id, "reset", { verified: true });

        if (!verification) {
            return fail(res, 400, "Reset verification required.");
        }

        if (verification.expiresAt.getTime() < Date.now()) {
            await prisma.verification.delete({ where: { id: verification.id } }).catch(() => {});
            return fail(res, 400, "Code expired.");
        }

        const codeMatches = await compareCode(code, verification);
        if (!codeMatches) {
            const destroyed = await recordFailedAttempt(verification);
            if (destroyed) {
                return fail(res, 400, "Too many incorrect attempts. Request a new code.");
            }
            return fail(res, 400, "Invalid code.");
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await prisma.user.update({
            where: { id: USER.id },
            data: {
                password: hashedPassword,
                // Invalidate every session issued before this reset — otherwise
                // a user resetting *because* their session was stolen leaves the
                // thief's 7-day token working.
                tokenVersion: { increment: 1 },
                // A stolen-session attacker may have added their own address here.
                trustedIps: [],
            },
        });

        await prisma.verification.deleteMany({
            where: { userId: USER.id, type: "reset" },
        });

        return ok(res, { message: "Password changed successfully." });
    } catch (err) {
        console.error(err);
        return fail(res, 500, "Server error.");
    }
});

export default router;
