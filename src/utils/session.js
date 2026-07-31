import jwt from 'jsonwebtoken';
import config from '../config/index.js';

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

export const signSessionToken = (user) =>
  jwt.sign(
    { userID: user.id, tokenVersion: user.tokenVersion || 0 },
    config.jwt.secret,
    { expiresIn: '7d' }
  );

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
