import cors from 'cors'
import express from 'express'
import bparser from 'body-parser'
import cparser from 'cookie-parser'
import mongoose from 'mongoose'
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

const app = express();
const PORT = process.env.PORT || 3001;
app.set('trust proxy', true);

app.use(cparser())

app.set("trust proxy", 1);

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

    // env-configured whitelist
    if (allowedOrigins.includes(origin)) return callback(null, true);

    // allow common preview hosts
    if (origin.endsWith('.vercel.app') || origin.endsWith('.onrender.com')) return callback(null, true);

    // allow localhost and local network (helpful for testing from phone)
    try {
      const u = new URL(origin);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return callback(null, true);
      if (/^192\.168\./.test(u.hostname) || /^10\./.test(u.hostname) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(u.hostname)) return callback(null, true);
    } catch (e) {
      // ignore parse errors
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
    } else if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/*');
    }
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}))

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

startServer();
