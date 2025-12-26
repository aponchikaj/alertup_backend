import nodemailer from 'nodemailer';
import 'dotenv/config';

const transport = nodemailer.createTransport({
  host: "smtp.sendgrid.net",
  port: 587,
  auth: {
    user: "apikey", // this must literally be "apikey"
    pass: process.env.SENDGRID_API_KEY
  }
});

const sendMail = async (to, subject, text, html) => {
  if (!to || !subject || (!text && !html)) {
    return false;
  }

  await transport.sendMail({
    from: "lazaremirziashvili@alertup.world", // use your verified sender
    to,
    subject,
    text,
    html
  });

  return true;
};

export default sendMail;
