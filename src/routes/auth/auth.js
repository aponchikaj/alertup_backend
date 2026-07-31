import express from 'express';
const router = express.Router();

import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

import USERS from '../../models/user.model.js';
import sendMail from '../../services/sendEmail.js';
import VERIFICATIONS from '../../models/verificatios.model.js'
import { displayName } from '../../services/displayName.js';
import { authLimiter, loginLimiter, registerLimiter } from '../../services/rateLimiter.js';
import crypto from 'crypto';

const isProd = process.env.NODE_ENV === 'production';

// Predictable from a few observed outputs, so Math.random() must not generate
// anything that acts as a credential.
const generateCode = () => crypto.randomInt(100000, 1000000);

// Wrong guesses allowed against a single 2FA code before it is destroyed. The
// IP-keyed limiter alone does not stop an attacker rotating source addresses.
const MAX_CODE_ATTEMPTS = 5;

// A bcrypt hash to compare against when no user matched, so a missing account
// and a wrong password take the same amount of time. Returning early on a miss
// let an attacker distinguish registered addresses by response latency.
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// The client controls X-Forwarded-For. With `trust proxy` set to 1, req.ip is
// the single hop Express is configured to trust; reading the leftmost XFF entry
// instead let anyone write arbitrary values into their own trustedIPS.
const clientIp = (req) => req.ip;

const checkNames = async (userType, company, name, lastname) => {
  if (userType == "Individual") {
    if (!name || name.length < 2 || name.length > 24) return "Name must be 2-24 characters.";
    if (!lastname || lastname.length < 2 || lastname.length > 24) return "Lastname must be 2-24 characters.";
  } else if (userType == "Company") {
    if (!company || company.length < 4 || company.length > 50) return "Company name must be 4-50 characters.";
  }
  return null;
};

const checkEmail = async (email) => {
  // Must be a string: an object such as {"$ne": null} would otherwise reach
  // findOne as a query operator rather than a value.
  if (typeof email !== 'string') return "Invalid email.";
  if (email.length < 1 || email.length > 355) return "Invalid email length.";
  if (!email.includes('@')) return "Invalid email.";

  const findEmail = await USERS.findOne({ email: email.toLowerCase().trim() });
  if (findEmail) return "Email already exists.";

  return null;
};

const checkPassword = async (password) => {
  if (typeof password !== 'string') return "Invalid password.";
  // The 16-character ceiling is kept for the signup form, but bcrypt's own
  // 72-byte truncation point is the limit that actually matters elsewhere.
  if (password.length < 6 || password.length > 16) return "Password must be from 6 to 16 characters.";
  return null;
};

router.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const {userType, name,lastname, company, email, password, country, countryCode, phone } = req.body;

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
      name: userType === "Individual" ? name : "****",
      lastname: userType === "Individual" ? lastname : "****",
      company: userType === "Company" ? company : "****",
      password: hashedPassword,
      email: email.toLowerCase().trim(),
      phones: phone,
      country,
      countryCode,
      updatedAt: new Date().toISOString(),
    });

    await newUser.save();

    const userToken = jwt.sign({ userID: newUser._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    
    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
   
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
      const newUserName = displayName(newUser);
      const welcomeHTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h1 style="color: #FF7B22; margin-top: 0;">Welcome to AlertUp!</h1>
            <p style="color: #333; font-size: 16px;">Hello <strong>${newUserName}</strong>,</p>
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
        `Hello ${newUserName}, welcome! Please verify your email to use AlertUp features.`,
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

router.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).send({ Success: false, Message: "Invalid fields." });
  }

  try {
    // password is select:false on the schema, so it must be requested here.
    const USER = await USERS.findOne({ email: email.toLowerCase().trim() }).select('+password');

    // Always run a comparison, even with no user, so the response time does not
    // reveal whether the address is registered.
    const isPasswordValid = await bcrypt.compare(password, USER ? USER.password : DUMMY_HASH);
    if (!USER || !isPasswordValid) return res.status(401).send({ Success: false, Message: "Invalid credentials." });

    if(USER.TwoFactorEnabled && !USER.trustedIPS.includes(clientIp(req))) {

      const findVerification = await VERIFICATIONS.findOne({verificationBy:USER._id,verificationType:'2fa'})
      if(findVerification){
        await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id,verificationType:'2fa'})
      }

      const VERIFICATION_CODE = generateCode()
      const HASHED_CODE = await bcrypt.hash(String(VERIFICATION_CODE),12)
      const VERIFICATION_CONFIG = {
        verificationBy:USER._id,
        verificationType:'2fa',
        verificationCode:HASHED_CODE
      }
      await VERIFICATIONS.create(VERIFICATION_CONFIG)
      try{
        const userName = displayName(USER);
  
        const twoFAText = `Hey ${userName}, your two-factor authentication code is: ${VERIFICATION_CODE}. This code will expire in 5 minutes.`;
        
        const twoFAHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">🔐 Login Verification</h1>
              <p style="color: #333; font-size: 16px;">Hello <strong>${userName}</strong>,</p>
              <p style="color: #666;">Enter this verification code to complete your login:</p>
              
              <div style="background-color: #f9f9f9; padding: 20px; border-radius: 6px; margin: 25px 0; text-align: center; border: 2px dashed #FF7B22;">
                <p style="color: #999; font-size: 14px; margin: 0 0 10px 0;">Your verification code</p>
                <p style="color: #FF7B22; font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 0; font-family: 'Courier New', monospace;">${VERIFICATION_CODE}</p>
              </div>

              <p style="color: #666;">This code will expire in <strong>5 minutes</strong>.</p>
              <p style="color: #666;">If you did not attempt to log in, please secure your account immediately by changing your password.</p>
              
              <p style="color: #999; font-size: 14px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee;">
                This is an automated message from AlertUp. Please do not reply to this email.
              </p>
            </div>
          </div>
        `;
        
        await sendMail(USER.email, "Login Verification - AlertUp", twoFAText, undefined, twoFAHTML);
        return res.send({Success:false,Message:"2fa"})
      }catch{
        console.error("Server error occured.")
        return res.send({Success:false,Message:"Couldn't sent email."})
      }
    }
    
    const ip = clientIp(req);
    // Recorded once, with $addToSet. The previous code tested the same
    // condition twice against a stale in-memory document and pushed the address
    // on both passes, so trustedIPS accumulated duplicates without bound.
    const isNewIp = !USER.trustedIPS.includes(ip);
    if(isNewIp) await USERS.findOneAndUpdate({_id:USER._id},{$addToSet:{trustedIPS:ip}})

    const userToken = jwt.sign({ userID: USER._id, tokenVersion: USER.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '7d' });

    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const userAgent = req.headers['user-agent'] || '';
    const isSafari = /Safari/i.test(userAgent) && !/Chrome/i.test(userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
    const cookieOptions = {
      httpOnly: true,
      secure: reqIsSecure,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
      sameSite: reqIsSecure ? 'None' : 'Lax'
    };

    res.cookie('userToken', userToken, cookieOptions);

    // Notify the user when the login comes from an address we have not seen.
    if(isNewIp){
       try {
        const userName = displayName(USER);
        const loginHTML = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
            <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h1 style="color: #FF7B22; margin-top: 0;">🔐 New Login Detected</h1>
              <p style="color: #333; font-size: 16px;">Hello <strong>${userName}</strong>,</p>
              <p style="color: #666;">We detected a new login to your AlertUp account.</p>
            </div>
          </div>
        `;
        await sendMail(USER.email, "New Login - AlertUp", `Hey ${userName}, someone logged into your account.`, undefined, loginHTML);
      } catch (err) {
        console.error("MAIL ERROR:", err);
      }
    }

    return res.send({
      Success: true,
      Message: "Logged in successfully.",
      // Only the Safari/iOS fallback path gets the token in the body, matching
      // what register already did. Returning it to every browser meant the
      // frontend stored a working 7-day credential in localStorage, so any XSS
      // could lift a session and the httpOnly cookie bought nothing.
      token: (isSafari || isIOS) ? userToken : undefined,
      user: {
        name: USER.name,
        company: USER.company,
        userType: USER.userType,
        email: USER.email
      }
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).send({ Success: false, Message: "Server error." });
  }
});

router.post('/api/auth/login/2fa', authLimiter, async(req,res)=>{
  const {email,verificationCode} = req.body;
  if(typeof email !== 'string' || !email.includes('@')) return res.status(400).send({Success:false,Message:"Invalid user."})
  // Coerced so a code sent as a JSON number is not rejected outright.
  if(!verificationCode || String(verificationCode).length !== 6) return res.status(400).send({Success:false,Message:"Invalid code"});
  try{
    const USER = await USERS.findOne({email: email.toLowerCase().trim()})
    if(!USER) return res.status(401).send({Success:false,Message:"Invalid user."})
    const findVerification = await VERIFICATIONS.findOne({verificationBy:USER._id,verificationType:'2fa'})
    if(!findVerification ) return res.status(401).send({Success:false,Message:"Invalid verification."});
    if(findVerification.expires < Date.now()) {
      await VERIFICATIONS.findByIdAndDelete(findVerification._id)
      return res.status(401).send({Success:false,Message:"Expired verification."})
    }

    const compareCodes = await bcrypt.compare(String(verificationCode),findVerification.verificationCode)
    if(!compareCodes) {
      // This endpoint mints a full session from an address plus six digits, so
      // the code has to die after a few wrong guesses — the IP-keyed limiter
      // does not stop an attacker rotating source addresses.
      findVerification.attempts = (findVerification.attempts || 0) + 1;
      if(findVerification.attempts >= MAX_CODE_ATTEMPTS){
        await VERIFICATIONS.findByIdAndDelete(findVerification._id)
        return res.status(401).send({Success:false,Message:"Too many incorrect attempts. Please log in again."})
      }
      await findVerification.save();
      return res.status(401).send({Success:false,Message:"Invalid verification code."})
    }

    await VERIFICATIONS.findOneAndDelete({verificationBy:USER._id,verificationType:'2fa'})

    const ip = clientIp(req);
    if(!USER.trustedIPS.includes(ip)) await USERS.findOneAndUpdate({_id:USER._id},{$addToSet:{trustedIPS:ip}})
    const userToken = jwt.sign({ userID: USER._id, tokenVersion: USER.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '7d' });

    const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const userAgent = req.headers['user-agent'] || '';
    const isSafari = /Safari/i.test(userAgent) && !/Chrome/i.test(userAgent);
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
    const cookieOptions = {
      httpOnly: true,
      secure: reqIsSecure,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
      sameSite: reqIsSecure ? 'None' : 'Lax'
    };

    res.cookie('userToken', userToken, cookieOptions);

    // Send login notification email
    try {
      const userName = displayName(USER);
      const loginHTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f5f5f5;">
          <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h1 style="color: #FF7B22; margin-top: 0;">🔐 New Login Detected</h1>
            <p style="color: #333; font-size: 16px;">Hello <strong>${userName}</strong>,</p>
            <p style="color: #666;">We detected a new login to your AlertUp account.</p>
          </div>
        </div>
      `;
      await sendMail(USER.email, "New Login - AlertUp", `Hey ${userName}, someone logged into your account.`, undefined, loginHTML);
    } catch (err) {
      console.error("MAIL ERROR:", err);
    }

    return res.send({
      Success: true,
      Message: "Logged in successfully.",
      token: (isSafari || isIOS) ? userToken : undefined,
      user: {
        name: USER.name,
        company: USER.company,
        userType: USER.userType,
        email: USER.email
      }
    });
  }catch(err){
    console.error("Something went wrong 2fa. ERROR !", err)
    return res.status(500).send({Success:false,Message:"Something went wrong."})
  }
})

export default router
