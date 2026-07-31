import express from 'express';
const router = express.Router();

import bcrypt from 'bcrypt';

import prisma from '../../db/prisma.js';
import sendMail from '../../services/sendEmail.js';
import { displayName } from '../../services/displayName.js';
import { authLimiter, loginLimiter, registerLimiter } from '../../services/rateLimiter.js';
import { ok, fail } from '../../utils/respond.js';
import { normalizeUserType } from '../../utils/userType.js';
import {
  issueVerification,
  findActiveVerification,
  compareCode,
  recordFailedAttempt,
  CODE_TTL_MS,
} from '../../services/verificationCodes.js';
import {
  signSessionToken,
  setSessionCookie,
  wantsTokenInBody,
} from '../../utils/session.js';

// A bcrypt hash to compare against when no user matched, so a missing account
// and a wrong password take the same amount of time. Returning early on a miss
// let an attacker distinguish registered addresses by response latency.
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// The client controls X-Forwarded-For. With `trust proxy` set to 1, req.ip is
// the single hop Express is configured to trust; reading the leftmost XFF entry
// instead let anyone write arbitrary values into their own trustedIps.
const clientIp = (req) => req.ip;

// userType here is the normalized enum value (INDIVIDUAL | COMPANY).
const checkNames = (userType, company, name, lastname) => {
  if (userType === 'INDIVIDUAL') {
    if (!name || name.length < 2 || name.length > 24) return "Name must be 2-24 characters.";
    if (!lastname || lastname.length < 2 || lastname.length > 24) return "Lastname must be 2-24 characters.";
  } else if (userType === 'COMPANY') {
    if (!company || company.length < 4 || company.length > 50) return "Company name must be 4-50 characters.";
  }
  return null;
};

const checkEmail = async (email) => {
  // Must be a string: an object such as {"$ne": null} could never be a value
  // here — and a non-string must not reach the query layer at all.
  if (typeof email !== 'string') return "Invalid email.";
  if (email.length < 1 || email.length > 355) return "Invalid email length.";
  if (!email.includes('@')) return "Invalid email.";

  const findEmail = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (findEmail) return "Email already exists.";

  return null;
};

const checkPassword = (password) => {
  if (typeof password !== 'string') return "Invalid password.";
  // The 16-character ceiling is kept for the signup form, but bcrypt's own
  // 72-byte truncation point is the limit that actually matters elsewhere.
  if (password.length < 6 || password.length > 16) return "Password must be from 6 to 16 characters.";
  return null;
};

router.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const { userType: rawUserType, name, lastname, company, email, password, country, countryCode, phone } = req.body;

    if (!rawUserType || !email || !password || !country || !countryCode || !phone) {
      return fail(res, 400, "Missing required fields.");
    }

    // The frontend sends "Individual"/"Company"; the database stores the enum.
    const userType = normalizeUserType(rawUserType);
    if (!userType) return fail(res, 400, "Invalid account type.");

    const namesError = checkNames(userType, company, name, lastname);
    if (namesError) return fail(res, 400, namesError);

    const emailError = await checkEmail(email);
    if (emailError) return fail(res, emailError === "Email already exists." ? 409 : 400, emailError);

    const passwordError = checkPassword(password);
    if (passwordError) return fail(res, 400, passwordError);

    const hashedPassword = await bcrypt.hash(password, 10);

    let newUser;
    try {
      newUser = await prisma.user.create({
        data: {
          userType,
          name: userType === 'INDIVIDUAL' ? name : "****",
          lastname: userType === 'INDIVIDUAL' ? lastname : "****",
          company: userType === 'COMPANY' ? company : "****",
          password: hashedPassword,
          email: email.toLowerCase().trim(),
          phone: String(phone),
          country: String(country),
          countryCode: String(countryCode),
        },
      });
    } catch (err) {
      // Unique(email) race between the pre-check and the insert.
      if (err.code === 'P2002') return fail(res, 409, "Email already exists.");
      throw err;
    }

    const userToken = signSessionToken(newUser);
    setSessionCookie(req, res, userToken);

    // For Safari/iOS compatibility, also return token in response so the
    // frontend can store it in localStorage as a fallback.
    ok(res, {
      message: "Registered successfully.",
      data: wantsTokenInBody(req) ? { token: userToken } : undefined,
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
    return fail(res, 500, "Server error.");
  }
});

router.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return fail(res, 400, "Invalid fields.");
  }

  try {
    // password is globally omitted, so it must be opted back in here.
    const USER = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      omit: { password: false },
    });

    // Always run a comparison, even with no user, so the response time does not
    // reveal whether the address is registered.
    const isPasswordValid = await bcrypt.compare(password, USER?.password || DUMMY_HASH);
    if (!USER || !USER.password || !isPasswordValid) return fail(res, 401, "Invalid credentials.");

    if (USER.twoFactorEnabled && !USER.trustedIps.includes(clientIp(req))) {
      // Replaces any pending 2FA code with a fresh 5-minute one.
      const { code: VERIFICATION_CODE } = await issueVerification({
        userId: USER.id,
        type: '2fa',
        ttlMs: CODE_TTL_MS,
      });
      try {
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
        // Not a granted session: the client reads the "2fa" message and shows
        // the code prompt.
        return fail(res, 401, "2fa");
      } catch {
        console.error("Server error occured.");
        return fail(res, 500, "Couldn't sent email.");
      }
    }

    const ip = clientIp(req);
    // Recorded once — the includes() check keeps trustedIps from accumulating
    // duplicates without bound.
    const isNewIp = !USER.trustedIps.includes(ip);
    if (isNewIp) {
      await prisma.user.update({
        where: { id: USER.id },
        data: { trustedIps: { push: ip } },
      });
    }

    const userToken = signSessionToken(USER);
    setSessionCookie(req, res, userToken);

    // Notify the user when the login comes from an address we have not seen.
    if (isNewIp) {
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

    return ok(res, {
      message: "Logged in successfully.",
      data: {
        // Only the Safari/iOS fallback path gets the token in the body.
        // Returning it to every browser meant the frontend stored a working
        // 7-day credential in localStorage, so any XSS could lift a session
        // and the httpOnly cookie bought nothing.
        token: wantsTokenInBody(req) ? userToken : undefined,
        user: {
          name: USER.name,
          company: USER.company,
          userType: USER.userType,
          email: USER.email,
        },
      },
    });

  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return fail(res, 500, "Server error.");
  }
});

router.post('/api/auth/login/2fa', authLimiter, async (req, res) => {
  const { email, verificationCode } = req.body;
  if (typeof email !== 'string' || !email.includes('@')) return fail(res, 400, "Invalid user.");
  // Coerced so a code sent as a JSON number is not rejected outright.
  if (!verificationCode || String(verificationCode).length !== 6) return fail(res, 400, "Invalid code");
  try {
    const USER = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!USER) return fail(res, 401, "Invalid user.");

    // Lookup excludes expired rows (the Mongo TTL index is gone).
    const findVerification = await findActiveVerification(USER.id, '2fa');
    if (!findVerification) return fail(res, 401, "Invalid verification.");
    if (findVerification.expiresAt.getTime() < Date.now()) {
      await prisma.verification.delete({ where: { id: findVerification.id } }).catch(() => {});
      return fail(res, 401, "Expired verification.");
    }

    const compareCodes = await compareCode(verificationCode, findVerification);
    if (!compareCodes) {
      // This endpoint mints a full session from an address plus six digits, so
      // the code has to die after a few wrong guesses — the IP-keyed limiter
      // does not stop an attacker rotating source addresses.
      const destroyed = await recordFailedAttempt(findVerification);
      if (destroyed) {
        return fail(res, 401, "Too many incorrect attempts. Please log in again.");
      }
      return fail(res, 401, "Invalid verification code.");
    }

    await prisma.verification.deleteMany({ where: { userId: USER.id, type: '2fa' } });

    const ip = clientIp(req);
    if (!USER.trustedIps.includes(ip)) {
      await prisma.user.update({
        where: { id: USER.id },
        data: { trustedIps: { push: ip } },
      });
    }
    const userToken = signSessionToken(USER);
    setSessionCookie(req, res, userToken);

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

    return ok(res, {
      message: "Logged in successfully.",
      data: {
        token: wantsTokenInBody(req) ? userToken : undefined,
        user: {
          name: USER.name,
          company: USER.company,
          userType: USER.userType,
          email: USER.email,
        },
      },
    });
  } catch (err) {
    console.error("Something went wrong 2fa. ERROR !", err);
    return fail(res, 500, "Something went wrong.");
  }
});

export default router
