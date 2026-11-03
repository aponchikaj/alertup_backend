import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import prisma from '../db/prisma.js';

/**
 * Session cookie policy, shared by register / login / 2FA-login / password
 * change / logout / account deletion so every path sets and clears the cookie
 * with exactly the same attributes (a clearCookie with different attributes
 * silently fails to remove the cookie).
 */

export const SESSION_COOKIE = 'userToken';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const isSecureRequest = (req) =>
  req.secure || req.headers['x-forwarded-proto'] === 'https';

const baseCookieOptions = (req) => {
  const secure = isSecureRequest(req);
  return {
    httpOnly: true,
    secure,
    path: '/',
    // Safari/iOS requires SameSite=None with Secure for cross-site cookies;
    // over plain HTTP (local dev) Lax is the strictest value that still works.
    sameSite: secure ? 'None' : 'Lax',
  };
};

// `jwtid` gives every session its own id so one device can be signed out
// (revokeSession) without touching the user's other sessions (FX-083).
export const signSessionToken = (user) =>
  jwt.sign(
    { userID: user.id, tokenVersion: user.tokenVersion || 0 },
    config.jwt.secret,
    { expiresIn: '7d', algorithm: 'HS256', jwtid: randomUUID() }
  );

/** The session token on a request: cookie first, then the Safari/iOS Bearer fallback. */
export const sessionTokenFrom = (req) => {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) return cookie;
  const header = req.headers?.authorization;
  return header && header.startsWith('Bearer ') ? header.substring(7) : null;
};

/**
 * The one check every consumer of a session token uses (whoami, the collab
 * socket handshake, scan attribution): signature + HS256, a real user, the
 * current tokenVersion (bumped by password change/reset), and not revoked.
 *
 * Never throws for a bad token. Database errors propagate so callers can tell
 * "invalid session" from "database down".
 *
 * @returns {Promise<{ user: object, claims: object } | { error: 'expired'|'invalid'|'revoked' }>}
 */
export async function resolveSession(token) {
  if (!token) return { error: 'invalid' };
  let claims;
  try {
    claims = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  } catch (err) {
    return { error: err.name === 'TokenExpiredError' ? 'expired' : 'invalid' };
  }
  // Session tokens carry no audience. Every other token signed with this
  // secret has one (admin: 'alertup-admin', 2FA device: 'alertup-2fa-device')
  // and must never pass as a session, even though the device token has a userID.
  if (!claims?.userID || claims.aud !== undefined) return { error: 'invalid' };

  const [user, revoked] = await Promise.all([
    prisma.user.findUnique({ where: { id: claims.userID } }),
    claims.jti ? prisma.revokedToken.findUnique({ where: { jti: claims.jti } }) : null,
  ]);
  if (!user) return { error: 'invalid' };
  if ((user.tokenVersion || 0) !== (claims.tokenVersion || 0)) return { error: 'expired' };
  if (revoked) return { error: 'revoked' };
  return { user, claims };
}

/**
 * Revoke one session token until it would have expired anyway. Tokens issued
 * before `jti` existed cannot be singled out; they lapse within 7 days.
 */
export async function revokeSession(claims) {
  if (!claims?.jti || !claims.exp) return;
  await prisma.revokedToken.upsert({
    where: { jti: claims.jti },
    create: { jti: claims.jti, expiresAt: new Date(claims.exp * 1000) },
    update: {},
  });
}

export const setSessionCookie = (req, res, token) => {
  res.cookie(SESSION_COOKIE, token, {
    ...baseCookieOptions(req),
    maxAge: SESSION_TTL_MS,
  });
};

export const clearSessionCookie = (req, res) => {
  res.clearCookie(SESSION_COOKIE, baseCookieOptions(req));
};

/**
 * "Remember this device" for 2FA (FX-082). Replaces trust-by-IP, which let a
 * password alone through on any shared network. A signed, httpOnly cookie set
 * after a completed 2FA; valid for one user at their current tokenVersion, so
 * a password change or reset forgets every trusted device. Its own audience
 * keeps it from ever being accepted as a session token (or vice versa).
 */
export const TRUSTED_DEVICE_COOKIE = 'trustedDevice';
const TRUSTED_DEVICE_AUDIENCE = 'alertup-2fa-device';
const TRUSTED_DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const setTrustedDevice = (req, res, user) => {
  const token = jwt.sign(
    { userID: user.id, tokenVersion: user.tokenVersion || 0 },
    config.jwt.secret,
    { expiresIn: '30d', algorithm: 'HS256', audience: TRUSTED_DEVICE_AUDIENCE }
  );
  res.cookie(TRUSTED_DEVICE_COOKIE, token, { ...baseCookieOptions(req), maxAge: TRUSTED_DEVICE_TTL_MS });
};

export const isTrustedDevice = (req, user) => {
  const token = req.cookies?.[TRUSTED_DEVICE_COOKIE];
  if (!token) return false;
  try {
    const claims = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      audience: TRUSTED_DEVICE_AUDIENCE,
    });
    return claims.userID === user.id && (claims.tokenVersion || 0) === (user.tokenVersion || 0);
  } catch {
    return false;
  }
};

/**
 * Safari/iOS block third-party cookies aggressively, so those browsers also
 * get the token in the response body as a localStorage fallback. Every other
 * browser must NOT receive it — a working 7-day credential in localStorage
 * means any XSS can lift a session and the httpOnly cookie buys nothing.
 */
export const wantsTokenInBody = (req) => {
  const userAgent = req.headers['user-agent'] || '';
  const isSafari = /Safari/i.test(userAgent) && !/Chrome/i.test(userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(userAgent);
  return isSafari || isIOS;
};
