import { fail } from '../utils/respond.js';
import { resolveSession, sessionTokenFrom } from '../utils/session.js';

const MESSAGES = {
  expired: 'Session expired. Please log in again.',
  revoked: 'Session expired. Please log in again.',
  invalid: 'Invalid Token',
};

const whoami = async (req, res, next) => {
  // Cookie first, then Authorization header (Safari/iOS localStorage fallback).
  const userToken = sessionTokenFrom(req);
  if (!userToken) {
    return fail(res, 401, 'no user token.');
  }

  try {
    // Signature, user, tokenVersion and revocation: see utils/session.js.
    const session = await resolveSession(userToken);
    if (session.error) return fail(res, 401, MESSAGES[session.error]);

    req.user = session.user;
    req.session = session.claims;
    next();
  } catch (err) {
    // Prisma connection failures surface here; the DB being down is a 503,
    // matching the old readyState check.
    if (err.code === 'P1001' || err.code === 'P1002') {
      return fail(res, 503, 'Database connection unavailable. Please try again later.');
    }
    console.error('Whoami middleware error:', err);
    return fail(res, 500, 'Server Error.');
  }
};

export default whoami;
