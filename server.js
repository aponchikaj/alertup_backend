import cors from 'cors'
import express from 'express'
import compression from 'compression'
import bparser from 'body-parser'
import cparser from 'cookie-parser'
import { pathToFileURL } from 'url'

import config from './src/config/index.js'
import prisma from './src/db/prisma.js'
import { closeAll as closeRealtime } from './src/features/realtime/broadcaster.js'
import { initCollab, closeCollab } from './src/features/collab/collab.js'
import { startSweeper } from './src/jobs/sweeper.js'

import adminRoutes from './src/routes/admin/admin.js'
import authRoutes from './src/routes/auth/auth.js'
import resetRoutes from './src/routes/auth/reset.js'
import buildingRoutes from './src/routes/buildings/buildings.js'
import rolesRoutes from './src/routes/buildings/roles.js'
import membersRoutes from './src/routes/buildings/members.js'
import invitesRoutes from './src/routes/buildings/invites.js'
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
import wayfindingRouter from './src/features/wayfinding/wayfinding.routes.js'
import mapEditorRouter from './src/features/mapEditor/mapEditor.routes.js'
import emergencyRouter from './src/features/emergency/emergency.routes.js'
import realtimeRouter from './src/features/realtime/realtime.routes.js'
import aiRouter from './src/features/ai/ai.routes.js'

const app = express();
const PORT = config.port;
const isProduction = config.isProduction;

// Single proxy hop (Render / Vercel). Must not be `true`, which would let a
// client spoof its IP via X-Forwarded-For and defeat the rate limiters.
app.set('trust proxy', 1);

app.use(cparser())

const envAllowed = config.cors.allowedOrigins;
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

const isAllowAll = config.cors.allowAll;

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

/* Compression.
   Route and graph payloads are the biggest thing this API sends — a scan
   response carries every node on the floor, and the editor's graph endpoint
   carries the whole building. That JSON is highly repetitive, so gzip cuts it
   by roughly 80%, which is the difference between a fast and a slow map on a
   phone inside a building with poor signal.

   SSE streams are excluded: compression buffers, and a buffered event stream
   is a broken event stream — the whole point is that the emergency broadcast
   arrives immediately. */
app.use(
  compression({
    filter: (req, res) => {
      if (res.getHeader('Content-Type')?.toString().includes('text/event-stream')) {
        return false;
      }
      return compression.filter(req, res);
    },
  })
)

app.use(bparser.json())

// Maintenance gate for the migration cutover window: reads keep working,
// writes are refused so the ETL sees a quiescent database.
if (config.flags.maintenanceMode) {
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      return next();
    }
    return res.status(503).json({
      success: false,
      message: 'AlertUp is undergoing brief maintenance. Please try again in a few minutes.',
    });
  });
}

// Legacy local uploads (pre-S3). Harmless to keep serving until the cleanup
// phase; new assets live on S3.
app.use('/uploads', express.static('uploads', {
  setHeaders: (res, path) => {
    if (path.endsWith('.svg')) {
      res.setHeader('Content-Type', 'image/svg+xml');
    } else if (path.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    } else if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/jpeg');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}))

// The API origin must never compete with alertup.world in search results.
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
app.use(rolesRoutes)
app.use(membersRoutes)
app.use(invitesRoutes)
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
app.use(wayfindingRouter)
app.use(mapEditorRouter)
app.use(emergencyRouter)
app.use(realtimeRouter)
app.use(aiRouter)

// Health check endpoint
app.get('/health', async (req, res) => {
  let database = 'connected';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'disconnected';
  }
  res.status(200).json({
    status: 'ok',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    database,
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    message: 'AlertUp API Server',
    status: 'running',
    version: '2.0.0'
  });
});

// Unmatched routes fall through to JSON, not Express's HTML error page.
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Cannot ${req.method} ${req.path}` })
})

// Error handler. Translates upload and CORS failures, plus the Prisma error
// codes every ported handler can throw.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400
    return res.status(status).json({ success: false, message: err.message })
  }

  if (typeof err?.message === 'string' && err.message.startsWith('CORS error:')) {
    return res.status(403).json({ success: false, message: 'Origin not allowed' })
  }

  // multer's fileFilter rejects by passing a plain Error through.
  if (typeof err?.message === 'string' && /only .*files are allowed/i.test(err.message)) {
    return res.status(400).json({ success: false, message: err.message })
  }

  // body-parser rejects unparseable JSON with an already-classified 4xx.
  // Without this the client's malformed request was reported as a server fault.
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Malformed JSON body.' })
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request body too large.' })
  }

  // Prisma known errors reaching the top: unique conflict, missing row, FK.
  if (err?.code === 'P2002') {
    return res.status(409).json({ success: false, message: 'That already exists.' })
  }
  if (err?.code === 'P2025') {
    return res.status(404).json({ success: false, message: 'Not found.' })
  }
  if (err?.code === 'P2003') {
    return res.status(400).json({ success: false, message: 'Related record missing.' })
  }

  console.error('Unhandled error:', err)
  if (res.headersSent) return next(err)
  res.status(500).json({ success: false, message: 'Server error.' })
})

const startServer = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ PostgreSQL connected successfully');
  } catch (error) {
    console.error('❌ PostgreSQL connection error:', error.message);
    console.log('⚠️  Starting server anyway...');
  }

  startSweeper();

  const server = app.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
  });

  // Collaborative map editing rides the same HTTP server and the same origin
  // allowlist the REST routes use. Initialized here, not at module scope, so
  // importing server.js (supertest) never opens a socket listener.
  initCollab(server, { allowedOrigins, allowAll: isAllowAll });

  // Render sends SIGTERM on deploy. Open SSE streams would otherwise stall
  // the drain until the kill timeout.
  const shutdown = async () => {
    console.log('SIGTERM received: closing realtime streams and server.');
    closeRealtime();
    closeCollab();
    server.close(async () => {
      await prisma.$disconnect().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
};

// Only listen when run directly. Importing this module (as the supertest
// suites do) must not open a port or connect to a production database.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer();
}

export { startServer };
export default app;
