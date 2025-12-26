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
import premiumRoutes from './src/routes/premium/premium.js'
import settingsRoutes from './src/routes/settings/settings.js'
import userRoutes from './src/routes/user/user.js'
import connectRouter from './src/routes/connect/connect.js'
import debugRouter from './src/routes/debug.js'

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cparser())

app.set("trust proxy", 1);

const envAllowed = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
const defaultAllowed = [
  "https://alertup.world",
  "https://www.alertup.world",
  "https://alertup.vercel.app",
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

app.use(adminRoutes)
app.use(authRoutes)
app.use(resetRoutes)
app.use(buildingRoutes)
app.use(contactRoutes)
app.use(reportRoutes)
app.use(dashboardRoutes)
app.use(premiumRoutes)
app.use(settingsRoutes)
app.use(userRoutes)
app.use(connectRouter)
app.use(debugRouter)

mongoose.connect(process.env.MONGO_STRING).then(()=>{
    app.listen(PORT,()=>console.log("Server is Running."))
}).catch((e)=>{
    console.error('Error: ' + e)
})