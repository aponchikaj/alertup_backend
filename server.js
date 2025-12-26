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

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cparser())
const allowedOrigins = [
  'http://localhost:5173',            // Localhost        // Your LAN IP
];

app.use(cors({
  origin:'http://localhost:5173',
  credentials: true
}));
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

mongoose.connect(process.env.MONGO_STRING).then(()=>{
    app.listen(PORT,()=>console.log("Server is Running."))
}).catch((e)=>{
    console.error('Error: ' + e)
})