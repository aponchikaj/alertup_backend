import nodemailer from 'nodemailer';
import 'dotenv/config';

const transport = nodemailer.createTransport({
  host: "smtp.sendgrid.net",
  port: 465,
  secure: true,
  auth: {
    user: "apikey", // must literally be "apikey"
    pass: process.env.SENDGRID_API_KEY
  },
  tls: {
    rejectUnauthorized: false // sometimes required on cloud hosts
  },
  connectionTimeout: 10000 // 10 seconds
});

const sendMail = async (to, subject, text) => {

  await transport.sendMail({
    from: "lazaremirziashvili@alertup.world", // use your verified sender
    to,
    subject,
    text,
  });

  return true;
};

export default sendMail;
