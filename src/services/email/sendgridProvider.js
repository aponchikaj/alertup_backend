import sgMail from '@sendgrid/mail';
import config from '../../config/index.js';

/* ============================================================================
   SendGrid transport — the fallback behind Resend.
   ----------------------------------------------------------------------------
   Kept through the Resend cutover on purpose. Resend will not deliver for a
   domain until its DNS records verify, and this app's email is not decorative:
   it carries password resets, 2FA codes and building invites. Keeping SendGrid
   reachable means a half-finished DNS migration degrades to "sent via the old
   provider" instead of "nobody can log in".

   Retire it once Resend has been verified and sending for a while, then drop
   the SendGrid DKIM records from DNS.
   ========================================================================= */

let configured = false;
function client() {
  if (!configured) {
    sgMail.setApiKey(config.email.sendgridApiKey || '');
    configured = true;
  }
  return sgMail;
}

export const name = 'sendgrid';

export function available() {
  return Boolean(config.email.sendgridApiKey);
}

export async function send({ to, subject, text, html, replyTo }) {
  try {
    const [response] = await client().send({
      to,
      from: config.email.from, // must be a VERIFIED sender
      subject,
      text,
      ...(html ? { html } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
    return { id: response?.headers?.['x-message-id'] };
  } catch (err) {
    const message = err.response?.body?.errors?.[0]?.message || err.message;
    const wrapped = new Error(message);
    wrapped.provider = 'sendgrid';
    wrapped.detail = err.response?.body;
    throw wrapped;
  }
}
