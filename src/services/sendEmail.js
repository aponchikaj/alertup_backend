import config from '../config/index.js';
import * as resend from './email/resendProvider.js';
import * as sendgrid from './email/sendgridProvider.js';

/* ============================================================================
   Email dispatch — Resend primary, SendGrid fallback.
   ----------------------------------------------------------------------------
   The signature is unchanged from the SendGrid-only version, so all nine call
   sites (auth, 2fa, reset, invites, contact, reviews, settings, admin) are
   untouched by the provider swap.
   ========================================================================= */

const PROVIDERS = { resend, sendgrid };

/** Configured primary first, then any other provider holding a key. */
function chain() {
  const preferred = config.email.provider;
  const order = [preferred, ...Object.keys(PROVIDERS).filter((n) => n !== preferred)];
  return order.map((n) => PROVIDERS[n]).filter((p) => p?.available());
}

/**
 * sendMail - sends an email through the first provider that accepts it.
 *
 * Throws on failure. It used to swallow every provider error and return
 * { Success: false } instead, which made the `try { await sendMail(...) }
 * catch { ... }` blocks all over the auth routes unreachable: an outage was
 * reported to the user as a code successfully sent, and they waited for an
 * email that was never going to arrive. Both transports preserve that
 * contract — Resend in particular resolves with { error } rather than
 * rejecting, and its wrapper rethrows.
 *
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string} text - plain text body
 * @param {string} replyTo - reply-to email (optional)
 * @param {string} html - HTML body (optional)
 * @returns {Promise<{Success: boolean, Message: string}>}
 * @throws {Error} when no provider could accept the message
 */
const sendMail = async (to, subject, text, replyTo = config.email.replyTo, html = null) => {
  if (!to || !subject || !text) {
    throw new Error('Missing required email fields');
  }

  const providers = chain();
  if (!providers.length) {
    throw new Error('No email provider is configured');
  }

  let lastError = null;

  for (const provider of providers) {
    try {
      await provider.send({ to, subject, text, html, replyTo });
      return { Success: true, Message: 'Email sent successfully' };
    } catch (err) {
      lastError = err;
      // A domain that has not finished verifying on the new provider is the
      // expected failure during the cutover; log which one bounced so the
      // migration is debuggable from the logs alone.
      console.error(`Email via ${provider.name} failed:`, err.detail || err.message);
    }
  }

  throw new Error(lastError?.message || 'Every email provider failed');
};

export default sendMail;
