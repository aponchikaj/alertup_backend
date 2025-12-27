import sgMail from "@sendgrid/mail";
import 'dotenv/config';

// Set SendGrid API key
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * sendMail - sends an email using SendGrid API
 * 
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string} text - plain text body
 * @param {string} replyTo - reply-to email (optional)
 * @param {string} html - HTML body (optional)
 * @returns {Promise<{Success: boolean, Message: string}>}
 */
const sendMail = async (to, subject, text, replyTo = "lazaremirziashvili8@gmail.com", html = null) => {
  if (!to || !subject || !text) {
    return { Success: false, Message: "Missing required email fields" };
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
    return { Success: false, Message: err.response?.body?.errors?.[0]?.message || err.message };
  }
};

export default sendMail;
