import express from 'express';
import { ok, fail } from '../utils/respond.js';
const router = express.Router();

// Debug endpoints require an explicit opt-in rather than merely "not
// production". NODE_ENV is unset by default on Render, and that same condition
// also re-enables the permissive *.vercel.app CORS branch in server.js — so a
// deploy that forgot to set it would let any page on a free Vercel account read
// this response with credentials attached.
// Read from process.env on purpose, not config: config/index.js throws in
// production when secrets are missing, and this switch must not depend on that.
if (process.env.ENABLE_DEBUG_ROUTES === 'true' && process.env.NODE_ENV !== 'production') {
  // Simple debug endpoint to inspect headers and cookies from client
  router.get('/api/debug', (req, res) => {
    try {
      const info = {
        origin: req.headers.origin || null,
        forwarded_proto: req.headers['x-forwarded-proto'] || null,
        secure: req.secure || false,
        // Names only. Echoing the values handed back the httpOnly userToken and
        // adminToken in a readable JSON body, which defeats the entire point of
        // marking them httpOnly.
        cookieNames: Object.keys(req.cookies || {}),
        headers: {
          host: req.headers.host,
          referer: req.headers.referer || null,
          'user-agent': req.headers['user-agent'] || null,
        },
      };
      ok(res, { data: info });
    } catch (err) {
      console.error('DEBUG ERROR:', err);
      fail(res, 200, 'Server error');
    }
  });

  // Set a test cookie to help debug cross-site cookie behavior
  router.get('/api/debug/setcookie', (req, res) => {
    try {
      const reqIsSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      const cookieOptions = {
        httpOnly: false,
        secure: reqIsSecure,
        maxAge: 60 * 60 * 1000,
        path: '/',
      };
      cookieOptions.sameSite = reqIsSecure ? 'None' : 'Lax';

      res.cookie('debug_test', 'ok', cookieOptions);
      ok(res, { message: 'cookie_set', extra: { cookieOptions } });
    } catch (err) {
      console.error('SETCOOKIE ERROR:', err);
      fail(res, 200, 'Server error');
    }
  });
}

export default router;
