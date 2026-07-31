import rateLimit from 'express-rate-limit';

/**
 * Shared rate limiters.
 *
 * Every limiter returns the same { Success, Message } envelope the rest of the
 * API uses, so the frontend error handling does not need a special case for 429.
 *
 * Note: server.js sets `trust proxy` to 1 (single proxy hop on Render/Vercel),
 * which is what express-rate-limit needs to key on the real client IP rather
 * than the proxy's.
 */

const deny = (Message) => ({ Success: false, Message });

const baseOptions = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

/**
 * Credential-checking endpoints (login, 2FA code submission).
 * Tight, because these are the brute-force targets.
 */
export const authLimiter = rateLimit({
  ...baseOptions,
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 5,
  message: deny('Too many attempts, try again later.'),
});

/**
 * Login gets its own instance so its budget is not shared with the reset and
 * 2FA flows. With one shared store, five mistyped passwords also locked the
 * user out of password reset — the exact thing they need next.
 */
export const loginLimiter = rateLimit({
  ...baseOptions,
  windowMs: 10 * 60 * 1000,
  limit: 5,
  message: deny('Too many attempts, try again later.'),
});

/**
 * Account creation. Looser than login, but still bounded so the user
 * collection can't be flooded.
 */
export const registerLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  message: deny('Too many accounts created from this address. Try again later.'),
});

/**
 * Anything that causes us to send an email (password reset, 2FA activation,
 * account/email verification, contact form). Each request costs real money and
 * can be used to spam a third party's inbox, so it is throttled per IP.
 */
export const emailLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5,
  message: deny('Too many requests. Please wait a few minutes and try again.'),
});

/**
 * Unauthenticated writes that occupants make during an emergency
 * (evacuated / ambulance called). These MUST stay open to anonymous callers —
 * that is the entire point — so they are throttled instead of authenticated.
 *
 * The limit is deliberately generous: a real evacuation can put many people
 * behind one NAT/building wifi IP, and under-counting an evacuation is worse
 * than over-counting one.
 */
export const emergencyActionLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000, // 1 minute
  limit: 30,
  message: deny('Too many requests. Please wait a moment.'),
});

/**
 * Public read endpoints that hit the database on every call
 * (QR scan, floor lookup). Wide enough never to affect a real evacuation,
 * narrow enough to stop scripted enumeration.
 */
export const publicReadLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000, // 1 minute
  limit: 120,
  message: deny('Too many requests. Please wait a moment.'),
});
