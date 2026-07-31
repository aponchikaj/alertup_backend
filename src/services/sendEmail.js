import sgMail from "@sendgrid/mail";
import 'dotenv/config';

// Set SendGrid API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * sendMail - sends an email using SendGrid API
 *
 * Throws on failure. It used to swallow every SendGrid error and return
 * { Success: false } instead, which made the `try { await sendMail(...) }
 * catch { ... }` blocks all over the auth routes unreachable: an outage was
 * reported to the user as a code successfully sent, and they waited for an
 * email that was never going to arrive.
 *
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string} text - plain text body
 * @param {string} replyTo - reply-to email (optional)
 * @param {string} html - HTML body (optional)
 * @returns {Promise<{Success: boolean, Message: string}>}
 * @throws {Error} when the message could not be handed to SendGrid
 */
const sendMail = async (to, subject, text, replyTo = "lazaremirziashvili8@gmail.com", html = null) => {
  if (!to || !subject || !text) {
    throw new Error("Missing required email fields");
  }

  try {
    const msg = {
      to,
      from: "lazaremirziashvili@alertup.world", // VERIFIED sender
      subject,
      text,
    };

    if (html) msg.html = html;
    if (replyTo) msg.replyTo = replyTo;

    await sgMail.send(msg);
    return { Success: true, Message: "Email sent successfully" };
  } catch (err) {
    console.error("SendGrid error:", err.response?.body || err.message);
    throw new Error(err.response?.body?.errors?.[0]?.message || err.message);
  }
};

export default sendMail;
