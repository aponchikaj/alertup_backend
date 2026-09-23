import { Resend } from 'resend';
import config from '../config/index.js';

/* ============================================================================
   Email dispatch — Resend.
   ----------------------------------------------------------------------------
   Single provider by choice. There was a SendGrid fallback through the
   cutover; it was removed once Resend's domain was verified, along with the
   s1/s2._domainkey records that served it.

   If a second provider is ever wanted back, the seam is `send()` below — every
   caller goes through sendMail(), so nothing above this file would change.
   ========================================================================= */

let client = null;
function resend() {
  if (!client) client = new Resend(config.email.resendApiKey);
  return client;
}

/**
 * sendMail - sends an email via Resend.
 *
 * THROWS on failure, and that contract is load-bearing. It used to swallow
 * provider errors and return { Success: false }, which made the
 * `try { await sendMail(...) } catch { ... }` blocks all over the auth routes
 * unreachable: an outage was reported to the user as a code successfully
 * sent, and they waited for an email that was never going to arrive.
 * inviteService also rolls an invite back in its catch block.
 *
 * Resend needs care here: emails.send() RESOLVES with { data, error } rather
 * than rejecting, so a populated `error` has to be turned into a throw.
 *
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string} text - plain text body
 * @param {string} replyTo - reply-to email (optional)
 * @param {string} html - HTML body (optional)
 * @returns {Promise<{Success: boolean, Message: string}>}
 * @throws {Error} when the message could not be handed to Resend
 */
const sendMail = async (to, subject, text, replyTo = config.email.replyTo, html = null) => {
  if (!to || !subject || !text) {
    throw new Error('Missing required email fields');
  }

  if (!config.email.resendApiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const { data, error } = await resend().emails.send({
    from: config.email.from, // must be on a domain verified in Resend
    to,
    subject,
    text,
    ...(html ? { html } : {}),
    ...(replyTo ? { replyTo } : {}),
  });

  if (error) {
    console.error('Resend error:', error);
    throw new Error(error.message || 'Resend rejected the message');
  }

  return { Success: true, Message: 'Email sent successfully', id: data?.id };
};

export default sendMail;
