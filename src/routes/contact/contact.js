import express from 'express'
const router = express.Router()

import prisma from '../../db/prisma.js';
import config from '../../config/index.js';
import sendMail from '../../services/sendEmail.js'
import { emailLimiter } from '../../services/rateLimiter.js'
import { escapeHtml } from '../../services/escapeHtml.js'
import { ok, fail } from '../../utils/respond.js'

const MAX_MESSAGE_LENGTH = 5000;

router.post('/api/contact', emailLimiter, async (req, res) => {
    const { email, message, reason } = req.body;
    const date = new Date().toISOString()

    if (!email || !message || !reason) {
        return fail(res, 400, "Invalid fields.")
    }

    try {
        if (typeof email !== 'string' || typeof message !== 'string' || typeof reason !== 'string') {
            return fail(res, 400, "Invalid fields.")
        }
        if (!email.includes('@')) {
            return fail(res, 400, "Invalid Email.")
        }
        if (message.length > MAX_MESSAGE_LENGTH) {
            return fail(res, 400, "Message is too long.")
        }

        await prisma.contact.create({
            data: {
                email,
                message,
                contactType: reason,
            },
        })

        // Respond first — the notification email must not delay or fail the
        // submission the user already made.
        ok(res, { message: "Sent." })
        try {
            const contactHTML = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
                <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                  <h1 style="color: #FF7B22; margin-top: 0;">📧 New Contact Message</h1>
                  <p style="color: #333; font-size: 16px;">You have received a new message from AlertUp contact form.</p>
                  <div style="background-color: #f9f9f9; padding: 20px; border-radius: 5px; margin: 20px 0;">
                    <p style="margin: 0 0 10px 0; color: #666;"><strong style="color: #333;">From:</strong> ${escapeHtml(email)}</p>
                    <p style="margin: 0 0 10px 0; color: #666;"><strong style="color: #333;">Reason:</strong> ${escapeHtml(reason)}</p>
                    <p style="margin: 0 0 10px 0; color: #666;"><strong style="color: #333;">Date:</strong> ${new Date(date).toLocaleString()}</p>
                    <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid #ddd;">
                      <p style="margin: 0 0 5px 0; color: #333; font-weight: bold;">Message:</p>
                      <p style="margin: 0; color: #666; white-space: pre-wrap;">${escapeHtml(message)}</p>
                    </div>
                  </div>
                  <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Contact System</strong></p>
                </div>
              </div>
            `;
            await sendMail(config.email.notifyRecipient, 'New Message - Alertup', `Author: ${email}, Reason: ${reason}, Message: ${message}. ${date}`, undefined, contactHTML)
        } catch (err) {
            console.error("MAIL ERROR:", err);
        }
    } catch (err) {
        console.error("Contact submission error:", err);
        return fail(res, 500, "Server error.")
    }
})

export default router
