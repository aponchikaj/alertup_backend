import dotenv from 'dotenv';

dotenv.config();

const env = process.env;

const config = {
  nodeEnv: env.NODE_ENV || 'development',
  isProduction: env.NODE_ENV === 'production',
  port: Number(env.PORT) || 3001,

  db: {
    url: env.DATABASE_URL,
    testUrl: env.TEST_DATABASE_URL,
  },

  jwt: {
    secret: env.JWT_SECRET,
  },

  admin: {
    user: env.ADMIN_USER,
    pass: env.ADMIN_PASS,
  },

  email: {
    sendgridApiKey: env.SENDGRID_API_KEY,
    from: env.EMAIL_FROM || 'lazaremirziashvili@alertup.world',
    replyTo: env.EMAIL_REPLY_TO || 'lazaremirziashvili8@gmail.com',
    // contact-form + admin-login notification recipient
    notifyRecipient: env.GMAIL_USER,
  },

  // Object storage. S3-compatible, so the same client drives AWS S3 or
  // Cloudflare R2 — only `endpoint` and `region` differ:
  //
  //   AWS S3:  endpoint unset,                            region eu-central-1
  //   R2:      https://<account>.r2.cloudflarestorage.com  region auto
  //
  // The STORAGE_* names are canonical; the AWS_*/S3_* names are still read so
  // a half-migrated deploy keeps working. Drop the fallbacks once every
  // environment sets STORAGE_*.
  storage: {
    endpoint: env.STORAGE_ENDPOINT || env.S3_ENDPOINT || null,
    region: env.STORAGE_REGION || env.AWS_REGION || 'eu-central-1',
    accessKeyId: env.STORAGE_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
    bucket: env.STORAGE_BUCKET || env.S3_BUCKET || 'alertup',
    // Public base for generated URLs. On R2 this is REQUIRED — buckets are
    // private by default and there is no predictable public host, so this
    // points at the custom domain bound to the bucket (assets.alertup.world).
    publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL || env.S3_PUBLIC_BASE_URL || null,
    // Hosts that served assets in an earlier era. Rows written then still hold
    // absolute URLs, and delete has to recognise them as ours. Comma-separated.
    legacyHosts: (env.STORAGE_LEGACY_HOSTS || '')
      .split(',')
      .map((h) => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean),
  },

  groq: {
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    // The floor designer benefits from a stronger model than the concierge;
    // defaults to the main model when unset.
    designModel: env.GROQ_DESIGN_MODEL || env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    // Multimodal model used to read uploaded floor-plan images. Empty string
    // disables image analysis without touching the rest of the assistant.
    visionModel: env.GROQ_VISION_MODEL ?? 'meta-llama/llama-4-scout-17b-16e-instruct',
    maxTokens: Number(env.AI_MAX_TOKENS) || 300,
    disabled: env.AI_DISABLED === 'true',
  },

  urls: {
    apiBase: env.API_BASE_URL || '',
    appBase: env.APP_BASE_URL || 'https://www.alertup.world',
    clientScanQr: env.CLIENT_SCAN_QR_URL || env.APP_BASE_URL || 'https://www.alertup.world',
  },

  cors: {
    allowedOrigins: (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    allowAll: env.ALLOW_ALL_ORIGINS === 'true',
  },

  flags: {
    enableDebugRoutes: env.ENABLE_DEBUG_ROUTES === 'true',
    maintenanceMode: env.MAINTENANCE_MODE === 'true',
  },
};

const REQUIRED_IN_PRODUCTION = [
  ['DATABASE_URL', config.db.url],
  ['JWT_SECRET', config.jwt.secret],
  ['SENDGRID_API_KEY', config.email.sendgridApiKey],
];

if (config.isProduction) {
  const missing = REQUIRED_IN_PRODUCTION.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export default config;
