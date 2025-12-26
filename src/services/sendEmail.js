import sgMail from "@sendgrid/mail";
import 'dotenv/config';

sgMail.setApiKey(process.env.SENDGRID_API_KEY); // Make sure your API key is in .env

const sendMail = async (to, subject, text,) => {
  if (!to || !subject ||!text) {
    throw new Error("Missing required email fields");
  }

  try {
    await sgMail.send({
      to,
      from: "your-email@example.com", // Verified sender in SendGrid
      subject,
      text,
    });
    return { Success: true, Message: "Email sent successfully" };
  } catch (err) {
    console.error("SendGrid error:", err);
    return { Success: false, Message: err.message || "Failed to send email" };
  }
};

export default sendMail;
