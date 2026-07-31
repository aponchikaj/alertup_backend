import cors from 'cors'
import express from 'express'
import bparser from 'body-parser'
import cparser from 'cookie-parser'
import mongoose from 'mongoose'
import { pathToFileURL } from 'url'
import 'dotenv/config';

import adminRoutes from './src/routes/admin/admin.js'
import authRoutes from './src/routes/auth/auth.js'
import resetRoutes from './src/routes/auth/reset.js'
import buildingRoutes from './src/routes/buildings/buildings.js'
import contactRoutes from './src/routes/contact/contact.js'
import reportRoutes from './src/routes/contact/report.js'
import dashboardRoutes from './src/routes/dashboard/dashboard.js'
import settingsRoutes from './src/routes/settings/settings.js'
import userRoutes from './src/routes/user/user.js'
import connectRouter from './src/routes/connect/connect.js'
import debugRouter from './src/routes/debug.js'
import routingRouter from './src/routes/routing/route.js'
import nodesRouter from './src/routes/nodes/nodes.js'
import uploadRouter from './src/routes/upload/upload.js'
import qrRouter from './src/routes/qr/qr.js'
import qrScanRouter from './src/routes/qr/scan.js'
import websitereview from './src/routes/reviews/reviews.js'
import twoFaSystem from './src/routes/auth/2fa.js'
import administrationRouter from './src/routes/administration/administration.js'

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Single proxy hop (Render / Vercel). Must not be `true`, which would let a
// client spoof its IP via X-Forwarded-For and defeat the rate limiters.
app.set('trust proxy', 1);

app.use(cparser())

const envAllowed = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
const defaultAllowed = [
  "https://alertup.world",
  "http://alertup.world",
  "https://www.alertup.world",
  "http://www.alertup.world",
  "https://alertup.vercel.app",
  "http://alertup.vercel.app",
  "http://localhost:5173",
  "https://localhost:5173",
  "https://alertup-qs1zp9gbl-aponchikajs-projects.vercel.app"
];

// Merge env list with defaults (env can override/append)
const allowedOrigins = Array.from(new Set([...defaultAllowed, ...envAllowed]));

const isAllowAll = process.env.ALLOW_ALL_ORIGINS === 'true';

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow non-browser requests (curl, etc.)
    if (isAllowAll) return callback(null, true);

    // env-configured whitelist — the only rule that applies in production
    if (allowedOrigins.includes(origin)) return callback(null, true);

    // Everything below is a development convenience. In production these would
    // let any *.vercel.app site (i.e. anyone with a free Vercel account) send
    // credentialed requests with the user's cookies attached.
    if (!isProduction) {
      if (origin.endsWith('.vercel.app') || origin.endsWith('.onrender.com')) return callback(null, true);

      // localhost and LAN, so the app can be tested from a phone on the same wifi
      try {
        const u = new URL(origin);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return callback(null, true);
        if (/^192\.168\./.test(u.hostname) || /^10\./.test(u.hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(u.hostname)) return callback(null, true);
      } catch (e) {
        // ignore parse errors
      }
    }

    return callback(new Error(`CORS error: ${origin} not allowed`));
  },
  credentials: true // important for cookies
}))

app.use(bparser.json())

// Serve static files from uploads directory
app.use('/uploads', express.static('uploads', {
  setHeaders: (res, path) => {
    if (path.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
    } else if (path.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
      // Was `image/*`, which is not a valid Content-Type and left browsers to
      // sniff the body — exactly what nosniff below is meant to prevent.
      res.setHeader('Content-Type', 'image/jpeg');
    }
    // These files are uploaded by users. Without nosniff, anything the browser
    // decides looks like HTML executes on the API origin.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}))

// The API origin (onrender.com, or whatever it is deployed to) must never
// compete with alertup.world in search results. Duplicate JSON endpoints in the
// index dilute the site's authority and leak internal route names, so every API
// response is explicitly excluded from crawling.
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive')
  next()
})

app.get('/robots.txt', (req, res) => {
  res
    .type('text/plain')
    .send('# AlertUp API — not a website.\n# The public site is https://alertup.world\n\nUser-agent: *\nDisallow: /\n')
})

app.use(adminRoutes)
app.use(authRoutes)
app.use(resetRoutes)
app.use(buildingRoutes)
app.use(contactRoutes)
app.use(reportRoutes)
app.use(dashboardRoutes)
app.use(settingsRoutes)
app.use(userRoutes)
app.use(connectRouter)
app.use(debugRouter)
app.use('/api/route', routingRouter)
app.use(nodesRouter)
app.use('/api/upload', uploadRouter)
app.use(qrRouter)
app.use('/api/qr/scan', qrScanRouter)
app.use(websitereview)
app.use(twoFaSystem)
app.use(administrationRouter)

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'AlertUp API Server',
    status: 'running',
    version: '1.0.0'
  });
});

// Unmatched routes previously fell through to Express's default handler, which
// answers with an HTML error page. Clients call res.json() unconditionally, so
// they saw "Unexpected token '<'" instead of the usual envelope.
app.use((req, res) => {
  res.status(404).json({ Success: false, Message: `Cannot ${req.method} ${req.path}` })
})

// Error handler. Without one, a rejected upload (oversize file, blocked
// mimetype) or a CORS rejection produced an HTML 500 with a stack trace.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    return res.status(status).json({ Success: false, Message: err.message })
  }

  if (typeof err?.message === 'string' && err.message.startsWith('CORS error:')) {
    return res.status(403).json({ Success: false, Message: 'Origin not allowed' })
  }

  // multer's fileFilter rejects by passing a plain Error through.
  if (typeof err?.message === 'string' && /only .*files are allowed/i.test(err.message)) {
    return res.status(400).json({ Success: false, Message: err.message })
  }

  console.error('Unhandled error:', err)
  if (res.headersSent) return next(err)
  res.status(500).json({ Success: false, Message: 'Server error.' })
})

// Connect to MongoDB and start server
const startServer = async () => {
  try {
    if (!process.env.MONGO_STRING) {
      console.error('❌ MONGO_STRING environment variable is not set');
      console.log('⚠️  Starting server without database connection...');
    } else {
      await mongoose.connect(process.env.MONGO_STRING);
      console.log('✅ MongoDB connected successfully');
    }
    
    app.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT}`);
      console.log(`📍 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    console.log('⚠️  Starting server anyway...');
    
    app.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT} (without database)`);
      console.log(`📍 Health check: http://localhost:${PORT}/health`);
      console.log('⚠️  Some features may not work without database connection');
    });
  }
};

// Only listen when run directly. Importing this module (as the supertest
// suites do) must not open a port or connect to the production database.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer();
}

export { startServer };
export default app;
