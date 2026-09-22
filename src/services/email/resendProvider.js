import { Resend } from 'resend';
import config from '../../config/index.js';

/* ============================================================================
   Resend transport.
   ----------------------------------------------------------------------------
   Note the error contract: resend.emails.send() RESOLVES with { data, error }
   instead of rejecting on an API error. Returning that as-is would make every
   `try { await sendMail(...) } catch {}` block in the auth routes unreachable
   — the exact failure the SendGrid wrapper was written to prevent, where an
   outage was reported to the user as "code sent" and they waited for an email
   that was never coming. So a populated `error` is rethrown here.
   ========================================================================= */

let client = null;
function resend() {
  if (!client) client = new Resend(config.email.resendApiKey);
  return client;
}

export const name = 'resend';

export function available() {
  return Boolean(config.email.resendApiKey);
}

export async function send({ to, subject, text, html, replyTo }) {
  const { data, error } = await resend().emails.send({
    from: config.email.from,
    to,
    subject,
    text,
    ...(html ? { html } : {}),
    ...(replyTo ? { replyTo } : {}),
  });

  if (error) {
    // error is { name, message } — surface the message the API gave us.
    const err = new Error(error.message || 'Resend rejected the message');
    err.provider = 'resend';
    err.detail = error;
    throw err;
  }

  return { id: data?.id };
}
