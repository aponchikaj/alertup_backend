import jwt from 'jsonwebtoken';

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
    return res.status(401).send({ Success: false, Message: 'Admin authentication required.' });
  }

  try {
    const decoded = jwt.verify(adminToken, process.env.JWT_SECRET);

    if (!decoded || decoded.isAdmin !== true) {
      req.isAdmin = false;
      return res.status(403).send({ Success: false, Message: 'Admin privileges required.' });
    }

    req.isAdmin = true;
    req.admin = decoded;
    return next();
  } catch (err) {
    // Covers expired tokens, bad signatures, and malformed input alike.
    req.isAdmin = false;
    return res.status(401).send({ Success: false, Message: 'Invalid or expired admin session.' });
  }
};

export default isAdmin;
