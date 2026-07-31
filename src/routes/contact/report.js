import express from 'express';
const router = express.Router()

import prisma from '../../db/prisma.js';
import { emailLimiter } from '../../services/rateLimiter.js';
import { ok, fail } from '../../utils/respond.js';

const MAX_MESSAGE_LENGTH = 5000;
const MAX_EMAIL_LENGTH = 355;

// This endpoint is unauthenticated; every field is validated and bounded so a
// script cannot fill the reports table with empty rows.
router.post('/api/report', emailLimiter, async (req, res) => {
    const { email, message, reason } = req.body

    if (typeof email !== 'string' || typeof message !== 'string' || typeof reason !== 'string') {
        return fail(res, 400, "Invalid fields.")
    }
    if (!email.includes('@') || email.length > MAX_EMAIL_LENGTH) {
        return fail(res, 400, "Invalid email.")
    }
    if (!message.trim() || message.length > MAX_MESSAGE_LENGTH) {
        return fail(res, 400, "Invalid message.")
    }
    if (!reason.trim() || reason.length > 200) {
        return fail(res, 400, "Invalid reason.")
    }

    try {
        await prisma.report.create({
            data: {
                reason,
                email: email.toLowerCase().trim(),
                message,
            },
        })

        return ok(res, { message: "Sent." })
    } catch (err) {
        console.error('Report submission error:', err)
        return fail(res, 500, "Server error.")
    }
})

export default router
