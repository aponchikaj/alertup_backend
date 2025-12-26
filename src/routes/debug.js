import express from 'express';
const router = express.Router();

// Debug endpoints are only enabled in non-production for safety
if (process.env.NODE_ENV !== 'production') {
  // Simple debug endpoint to inspect headers and cookies from client
  router.get('/api/debug', (req, res) => {
    try {
      const info = {
        origin: req.headers.origin || null,
        forwarded_proto: req.headers['x-forwarded-proto'] || null,
        secure: req.secure || false,
        cookies: req.cookies || {},
        headers: {
          host: req.headers.host,
          referer: req.headers.referer || null,
          'user-agent': req.headers['user-agent'] || null,
        },
      };
      res.send({ Success: true, Message: info });
    } catch (err) {
      console.error('DEBUG ERROR:', err);
      res.send({ Success: false, Message: 'Server error' });
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
      res.send({ Success: true, Message: 'cookie_set', cookieOptions });
    } catch (err) {
      console.error('SETCOOKIE ERROR:', err);
      res.send({ Success: false, Message: 'Server error' });
    }
  });
}

export default router;
