import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { fail } from '../utils/respond.js';

/**
 * Verify the caller holds a valid admin token.
 *
 * The token is minted in routes/admin/admin.js on successful admin login and
 * carries an `isAdmin: true` claim. Both the signature and that claim are
 * checked here — presence of the cookie alone proves nothing, since a client
 * can set any cookie it likes.
 */
const isAdmin = (req, res, next) => {
  const adminToken = req.cookies?.['adminToken'];

  if (!adminToken) {
    req.isAdmin = false;
    return fail(res, 401, 'Admin authentication required.');
  }

  try {
    const decoded = jwt.verify(adminToken, config.jwt.secret);

    if (!decoded || decoded.isAdmin !== true) {
      req.isAdmin = false;
      return fail(res, 403, 'Admin privileges required.');
    }

    req.isAdmin = true;
    req.admin = decoded;
    return next();
  } catch {
    // Covers expired tokens, bad signatures, and malformed input alike.
    req.isAdmin = false;
    return fail(res, 401, 'Invalid or expired admin session.');
  }
};

export default isAdmin;
