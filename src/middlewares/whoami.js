import jwt from 'jsonwebtoken';
import prisma from '../db/prisma.js';
import config from '../config/index.js';
import { fail } from '../utils/respond.js';

const whoami = async (req, res, next) => {
  // Cookie first, then Authorization header (Safari/iOS localStorage fallback).
  let userToken = req.cookies['userToken'];
  if (!userToken) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      userToken = authHeader.substring(7);
    }
  }

  if (!userToken) {
    return fail(res, 401, 'no user token.');
  }

  try {
    const data = jwt.verify(userToken, config.jwt.secret);

    // The admin token minted in routes/admin/admin.js carries only
    // {isAdmin:true} and is signed with this same secret, so it reaches here
    // with no userID. Reject explicitly so the guarantee is local.
    if (!data || !data.userID) {
      return fail(res, 401, 'Invalid Token');
    }

    const user = await prisma.user.findUnique({ where: { id: data.userID } });
    if (!user) {
      return fail(res, 401, 'Invalid User ID.');
    }

    // Password resets bump tokenVersion to cut off sessions issued earlier.
    if ((user.tokenVersion || 0) !== (data.tokenVersion || 0)) {
      return fail(res, 401, 'Session expired. Please log in again.');
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return fail(res, 401, 'Session expired. Please log in again.');
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      return fail(res, 401, 'Invalid Token');
    }
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
