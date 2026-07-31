import express from "express";
import prisma from "../../db/prisma.js";
import sendMail from '../../services/sendEmail.js';
import whoami from '../../middlewares/whoami.js';
import { displayName } from '../../services/displayName.js';
import { emailLimiter, authLimiter } from '../../services/rateLimiter.js';
import { ok, fail } from '../../utils/respond.js';
import {
    issueVerification,
    findActiveVerification,
    compareCode,
    recordFailedAttempt,
    CODE_TTL_MS,
} from '../../services/verificationCodes.js';

const router = express.Router()

router.post('/api/2fa/activate', whoami, emailLimiter, async (req, res) => {
    // making new verification + code and sending it to users email and sending response
    try {
        // Replaces any pending activation code with a fresh 5-minute one.
        const { code: VERIFICATION_CODE } = await issueVerification({
            userId: req.user.id,
            type: "2fa-activation",
            ttlMs: CODE_TTL_MS,
        });

        try {
            const userName = displayName(req.user);

            const twoFAText = `Hey ${userName}, your two-factor authentication code is: ${VERIFICATION_CODE}. This code will expire in 5 minutes.`;

            const twoFAHTML = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                    <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <h1 style="color: #FF7B22; margin-top: 0;">🔐 Two-Factor Authentication</h1>
                    <p style="color: #333; font-size: 16px;">Hello <strong>${userName}</strong>,</p>
                    <p style="color: #666;">Here is your verification code to complete your 2fa activation:</p>

                    <div style="background-color: #f9f9f9; padding: 20px; border-radius: 6px; margin: 25px 0; text-align: center; border: 2px dashed #FF7B22;">
                        <p style="color: #999; font-size: 14px; margin: 0 0 10px 0;">Your verification code</p>
                        <p style="color: #FF7B22; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 0; font-family: 'Courier New', monospace;">${VERIFICATION_CODE}</p>
                    </div>

                    <p style="color: #666;">This code will expire in <strong>5 minutes</strong>.</p>
                    <p style="color: #666;">If you did not attempt to log in, please ignore this email or contact support if you have concerns.</p>

                    <p style="color: #999; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
                        This is an automated message from AlertUp. Please do not reply to this email.
                    </p>
                    </div>
                </div>
            `;

            await sendMail(req.user.email, "2FA Activation - AlertUp", twoFAText, undefined, twoFAHTML);
        } catch {
            console.error("2FA EMAIL ERROR.")
            return fail(res, 500, "Couldn't sent email.")
        }

        return ok(res, { message: "Sent." })
    } catch {
        console.log("Server error caught.")
        return fail(res, 500, 'Server error.')
    }
})

router.post('/api/2fa/deactivate', whoami, emailLimiter, async (req, res) => {
    try {
        const { code: VERIFICATION_CODE } = await issueVerification({
            userId: req.user.id,
            type: "2fa-deactivation",
            ttlMs: CODE_TTL_MS,
        });

        try {
            const userName = displayName(req.user);

            const twoFAText = `Hey ${userName}, your two-factor authentication code is: ${VERIFICATION_CODE}. This code will expire in 5 minutes.`;

            const twoFAHTML = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                    <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                    <h1 style="color: #FF7B22; margin-top: 0;">🔐 Two-Factor Deactivation</h1>
                    <p style="color: #333; font-size: 16px;">Hello <strong>${userName}</strong>,</p>
                    <p style="color: #666;">Here is your verification code to deactivate 2fa:</p>

                    <div style="background-color: #f9f9f9; padding: 20px; border-radius: 6px; margin: 25px 0; text-align: center; border: 2px dashed #FF7B22;">
                        <p style="color: #999; font-size: 14px; margin: 0 0 10px 0;">Your verification code</p>
                        <p style="color: #FF7B22; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 0; font-family: 'Courier New', monospace;">${VERIFICATION_CODE}</p>
                    </div>

                    <p style="color: #666;">This code will expire in <strong>5 minutes</strong>.</p>
                    <p style="color: #666;">If you did not attempt to log in, please ignore this email or contact support if you have concerns.</p>

                    <p style="color: #999; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
                        This is an automated message from AlertUp. Please do not reply to this email.
                    </p>
                    </div>
                </div>
            `;

            await sendMail(req.user.email, "2FA Deactivation - AlertUp", twoFAText, undefined, twoFAHTML);
        } catch {
            console.error("2fa verification deactivation  ERROR !")
            return fail(res, 500, "Couldn't sent email.")
        }

        return ok(res, { message: "Verification code sent." })
    } catch {
        console.error("2FA DEACTIVATION CAUGHT ERROR.")
        return fail(res, 500, "Server error.")
    }
})

// authLimiter: this endpoint checks a 6-digit code and can switch off the
// account's second factor.
router.post('/api/2fa/verify', whoami, authLimiter, async (req, res) => {
    const { verificationCode, verificationType } = req.body;

    if (!verificationCode) return fail(res, 400, "Invalid verification code.");
    if (verificationType !== "activate" && verificationType !== "deactivate") {
        return fail(res, 400, "Invalid verification type.")
    }

    const expectedType = verificationType === "activate" ? '2fa-activation' : '2fa-deactivation';

    try {
        // Excludes expired rows — the Mongo TTL index is gone.
        const VERIFICATION = await findActiveVerification(req.user.id, expectedType);

        if (!VERIFICATION) return fail(res, 400, "Invalid verification.")
        if (VERIFICATION.expiresAt.getTime() < Date.now()) {
            await prisma.verification.delete({ where: { id: VERIFICATION.id } }).catch(() => {});
            return fail(res, 400, "Verification expired.")
        }

        const codeMatches = await compareCode(verificationCode, VERIFICATION);
        if (!codeMatches) {
            // Destroyed after repeated wrong guesses so the code cannot be
            // ground down to disable someone's second factor.
            const destroyed = await recordFailedAttempt(VERIFICATION);
            if (destroyed) {
                return fail(res, 400, "Too many incorrect attempts. Request a new code.")
            }
            return fail(res, 400, "Invalid Code.")
        }

        if (verificationType == "deactivate") {
            await prisma.user.update({
                where: { id: req.user.id },
                data: { twoFactorEnabled: false },
            })
        }
        if (verificationType == "activate") {
            // trustedIps is cleared on activation. Otherwise every address the
            // user had logged in from before enabling 2FA stayed on the skip
            // list, so an attacker who already knew the password and had logged
            // in once would never be challenged.
            await prisma.user.update({
                where: { id: req.user.id },
                data: { twoFactorEnabled: true, trustedIps: [] },
            })
        }

        // Scoped to the consumed verification: an unscoped delete would remove
        // an arbitrary record for this user — typically an in-flight password
        // reset — while leaving the just-used 2FA code replayable.
        await prisma.verification.delete({ where: { id: VERIFICATION.id } }).catch(() => {});

        return ok(res, { message: "Done." })
    } catch (err) {
        console.error("2FA verify error:", err)
        return fail(res, 500, 'Server error.')
    }
})

export default router;
