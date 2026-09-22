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
    // Resend primary, SendGrid fallback — see services/sendEmail.js. SendGrid
    // stays wired until Resend's domain verification has been live for a while.
    provider: env.EMAIL_PROVIDER || 'resend',
    resendApiKey: env.RESEND_API_KEY,
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

  // Provider-independent AI settings. `provider` names the primary; the other
  // one becomes the fallback (see features/ai/aiClient.js).
  ai: {
    provider: env.AI_PROVIDER || 'gemini',
    disabled: env.AI_DISABLED === 'true',
  },

  // Gemini (Google AI Studio). Model names move quickly — override per
  // environment rather than editing these defaults.
  gemini: {
    apiKey: env.GEMINI_API_KEY,
    // Terse visitor concierge: the cheapest, fastest tier is the right fit.
    model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    // The floor designer emits a whole drawing and benefits from more headroom.
    designModel: env.GEMINI_DESIGN_MODEL || env.GEMINI_MODEL || 'gemini-3.8-flash',
    // Reads uploaded floor-plan images. Empty string disables image analysis
    // without touching the rest of the assistant.
    visionModel: env.GEMINI_VISION_MODEL ?? 'gemini-3.8-flash',
    maxTokens: Number(env.AI_MAX_TOKENS) || 300,
  },

  groq: {
    apiKey: env.GROQ_API_KEY,
    // Groq retired the Llama family: llama-3.3-70b-versatile now 404s with
    // model_not_found, which is why the assistant was answering with its
    // "unavailable" fallback. These are the current chat models on the account.
    model: env.GROQ_MODEL || 'openai/gpt-oss-20b',
    // The floor designer benefits from a stronger model than the concierge;
    // defaults to the main model when unset.
    designModel: env.GROQ_DESIGN_MODEL || env.GROQ_MODEL || 'openai/gpt-oss-120b',
    // Empty by default: Groq no longer offers a multimodal model (llama-4-scout
    // went with the Llama retirement), so reading uploaded plan images is
    // Gemini-only. Setting this re-enables the path if Groq ships one again.
    visionModel: env.GROQ_VISION_MODEL ?? '',
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
  // Any working transport will do — naming SENDGRID_API_KEY specifically would
  // refuse to boot a Resend-only production, and password resets and invites
  // are load-bearing enough that booting with neither must stay fatal.
  ['RESEND_API_KEY or SENDGRID_API_KEY', config.email.resendApiKey || config.email.sendgridApiKey],
];

if (config.isProduction) {
  const missing = REQUIRED_IN_PRODUCTION.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

export default config;
