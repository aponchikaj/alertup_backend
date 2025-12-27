import express from 'express';
const router = express.Router();

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { Filter } from 'bad-words';

import USERS from '../../models/user.model.js';
import sendMail from '../../services/sendEmail.js';

const isProd = process.env.NODE_ENV === 'production';

const checkNames = async (userType, company, name, lastname) => {
  if (userType === "Individual") {
    if (!name || name.length < 2 || name.length > 24) return "Name must be 2-24 characters.";
    if (!lastname || lastname.length < 2 || lastname.length > 24) return "Lastname must be 2-24 characters.";
  } else if (userType === "Company") {
    if (!company || company.length < 4 || company.length > 50) return "Company name must be 4-50 characters.";
  }
  return null;
};

const checkEmail = async (email) => {
  if (!email) return "Invalid email.";
  if (email.length < 1 || email.length > 355) return "Invalid email length.";
  if (!email.includes('@')) return "Invalid email.";

  const findEmail = await USERS.findOne({ email });
  if (findEmail) return "Email already exists.";

  return null;
};

const checkPassword = async (password) => {
  if (!password) return "Invalid password.";
  if (password.length < 6 || password.length > 16) return "Password must be from 6 to 16 characters.";
  return null;
};

router.post('/api/auth/register', async (req, res) => {
  try {
    const {userType, name,lastname,company, email, password, country, countryCode, phone } = req.body;

    if (!userType || !email || !password || !country || !countryCode || !phone) {
      return res.send({ Success: false, Message: "Missing required fields." });
    }

    const namesError = await checkNames(userType, company, name, lastname);
    if (namesError) return res.send({ Success: false, Message: namesError });

    const emailError = await checkEmail(email);
    if (emailError) return res.send({ Success: false, Message: emailError });

    const passwordError = await checkPassword(password);
    if (passwordError) return res.send({ Success: false, Message: passwordError });

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new USERS({
      userType,
      name: userType === "Individual" ? name : "",
      lastname: userType === "Individual" ? lastname : "",
      company: userType === "Company" ? company : "",
      password: hashedPassword,
      email,
      phones: phone,
      country,
      countryCode,
      updatedAt: new Date().toISOString(),
    });

    await newUser.save();

    const userToken = jwt.sign({ userID: newUser._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    // Determine whether the current request is secure (HTTPS).
    // `trust proxy` is enabled in server.js so `req.secure` and
    // `x-forwarded-proto` are reliable behind proxies (Vercel/Render).
    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';

    // Detect Safari/iOS for special handling
    const userAgent = req.headers['user-agent'] || '';
    const isSafari = /Safari/i.test(userAgent) && !/Chrome/i.test(userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);

    const cookieOptions = {
      httpOnly: true,
      secure: reqIsSecure,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/', // Ensure cookie is available across all paths
    };

    // Safari/iOS requires SameSite=None with Secure for cross-site cookies
    // For same-site, we can use Lax which works better with Safari
    if (reqIsSecure) {
      cookieOptions.sameSite = 'None';
    } else {
      cookieOptions.sameSite = 'Lax';
    }

    res.cookie('userToken', userToken, cookieOptions);

    // For Safari/iOS compatibility, also return token in response
    // Frontend can store in localStorage as fallback
    res.send({ 
      Success: true, 
      Message: "Registered successfully.",
      token: (isSafari || isIOS) ? userToken : undefined // Only send token for Safari/iOS as fallback
    });
    try {
      const welcomeHTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h1 style="color: #FF7B22; margin-top: 0;">Welcome to AlertUp!</h1>
            <p style="color: #333; font-size: 16px;">Hello <strong>${username}</strong>,</p>
            <p style="color: #666;">Thank you for joining AlertUp! We're excited to have you on board.</p>
            <p style="color: #666;">To get started and access all features, please verify your email address.</p>
            <div style="background-color: #e3f2fd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #2196f3;">
              <p style="margin: 0; color: #1976d2; font-weight: bold;">📧 Next Step: Verify Your Email</p>
              <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">Go to your account settings to verify your email and unlock all features.</p>
            </div>
            <p style="color: #666; font-size: 14px; margin-top: 30px;">If you have any questions, feel free to contact our support team.</p>
            <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Team</strong></p>
          </div>
        </div>
      `;
      await sendMail(
        email,
        "Welcome - AlertUp",
        `Hello ${username}, welcome! Please verify your email to use AlertUp features.`,
        undefined,
        welcomeHTML
      );
    } catch (err) {
      console.error("MAIL ERROR:", err);
    }
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.send({ Success: false, Message: "Server error." });
  }
});


router.post('/api/auth/login',async(req,res)=>{
  const {user,password}=req.body

  if(!user||!password){
    return res.send({Success:false,Message:"Invalid fields."})
  }

  try{
    let USER;

    if(user.includes('@')){
      USER = await USERS.findOne({email:user})
    }else if(!user.includes('@')){
      USER = await USERS.findOne({username:user});
    }

    if(!USER){
      return res.send({Success:false,Message:'Invalid credentials.'})
    }

    const checkPassword = await bcrypt.compare(password,USER.password);
    if(!checkPassword){
      return res.send({Success:false,Message:"Invalid credentials."})
    }

    const userToken = await jwt.sign({userID:USER._id},process.env.JWT_SECRET,{
      expiresIn:'7d'
    })

    const reqIsSecure2 = req.secure || req.headers['x-forwarded-proto'] === 'https';

    // Detect Safari/iOS for special handling
    const userAgent = req.headers['user-agent'] || '';
    const isSafari = /Safari/i.test(userAgent) && !/Chrome/i.test(userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);

    const cookieOptions2 = {
      httpOnly: true,
      secure: reqIsSecure2,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/', // Ensure cookie is available across all paths
    };
    
    // Safari/iOS requires SameSite=None with Secure for cross-site cookies
    if (reqIsSecure2) {
      cookieOptions2.sameSite = 'None';
    } else {
      cookieOptions2.sameSite = 'Lax';
    }

    res.cookie('userToken', userToken, cookieOptions2);

    try {
      const loginHTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h1 style="color: #FF7B22; margin-top: 0;">🔐 New Login Detected</h1>
            <p style="color: #333; font-size: 16px;">Hello <strong>${USER.username}</strong>,</p>
            <p style="color: #666;">We detected a new login to your AlertUp account.</p>
            <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #ffc107;">
              <p style="margin: 0; color: #856404; font-weight: bold;">⚠️ Security Alert</p>
              <p style="margin: 5px 0 0 0; color: #666; font-size: 14px;">If this wasn't you, please contact us immediately to secure your account.</p>
            </div>
            <p style="color: #666; font-size: 14px; margin-top: 30px;">If you recognize this login, you can safely ignore this email.</p>
            <p style="color: #666; font-size: 14px; margin-top: 20px;">Best regards,<br><strong style="color: #FF7B22;">AlertUp Security Team</strong></p>
          </div>
        </div>
      `;
      await sendMail(
        USER.email,
        "New Login - AlertUp",
        `Hey someone has logged into your account. was that you? contact us if it wasn't you.`,
        undefined,
        loginHTML
      );
    } catch (err) {
      console.error("MAIL ERROR:", err);
    }

    // For Safari/iOS compatibility, also return token in response
    // Frontend can store in localStorage as fallback
    return res.send({
      Success: true,
      Message: "Logged in.",
      token: (isSafari || isIOS) ? userToken : undefined // Only send token for Safari/iOS as fallback
    })
  }catch{
    return res.send({Success:false,Message:"Server error."})
  }
})

export default router