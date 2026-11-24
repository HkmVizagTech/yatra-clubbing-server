require('dotenv').config();

// Some Windows setups (VPN / virtual adapters) leave Node with only a loopback
// DNS server where nothing is listening. Every `mongodb+srv://` lookup then
// fails with `querySrv ECONNREFUSED` even though the machine's own DNS works.
// If that is the situation, use public resolvers instead. DNS_SERVERS
// (comma-separated) overrides this explicitly. A normal host is left untouched.
{
  const dns = require('dns');
  const explicit = (process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const loopbackOnly = dns.getServers().every((s) => s === '127.0.0.1' || s === '::1');
  if (explicit.length) dns.setServers(explicit);
  else if (loopbackOnly) {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    console.warn('[dns] Node had only a loopback DNS server; using 8.8.8.8 / 1.1.1.1 for lookups.');
  }
}

const config = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI,
  mongoDb: process.env.MONGODB_DB || 'yatra',
  // Admin sign-in: signed JWTs. JWT_SECRET must be a long random string in
  // production (the server refuses to start without one).
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  // Used once, to create the first super admin when the user list is empty.
  bootstrapEmail: process.env.ADMIN_EMAIL,
  bootstrapPassword: process.env.ADMIN_PASSWORD,
  frontendUrls: (process.env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },
  // Cloudflare R2 (S3-compatible). Student ID cards go here, in a private bucket,
  // and are only ever viewed through short-lived signed links.
  r2: {
    accountId: process.env.R2_ACCOUNT_ID,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    idBucket: process.env.R2_ID_BUCKET, // optional: defaults to R2_BUCKET
  },
  // Vanabhojanam's "who attended" API — the source for returning-attendee pricing.
  vanabhojanam: {
    // Tolerates a missing scheme ("host.up.railway.app") and a trailing slash.
    apiUrl: (process.env.VANABHOJANAM_API_URL || '').trim().replace(/\/+$/, '').replace(/^(?!https?:\/\/)(?=.)/i, 'https://'),
    apiKey: process.env.VANABHOJANAM_API_KEY,
  },
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
  // WhatsApp via Gupshup. The API key is a secret and belongs only in the
  // Railway environment — never in this repo.
  gupshup: {
    apiKey: process.env.GUPSHUP_API_KEY,
    appId: process.env.GUPSHUP_APP_ID,
    appName: process.env.GUPSHUP_APP_NAME,
    source: process.env.GUPSHUP_SOURCE,
    apiUrl: process.env.GUPSHUP_API_URL || 'https://api.gupshup.io/wa/api/v1/template/msg',
    // Optional secret for verifying /api/webhook/gupshup callbacks. Gupshup
    // signs with the app token: set this to the same value to require it.
    webhookSecret: process.env.GUPSHUP_WEBHOOK_SECRET,
    // Gupshup addresses templates by UUID. An event can override these in its
    // advanced settings, but only with a UUID — see resolveTemplateId().
    templates: {
      booking: process.env.GUPSHUP_TEMPLATE_BOOKING,
      studentApproved: process.env.GUPSHUP_TEMPLATE_STUDENT_APPROVED,
      studentRejected: process.env.GUPSHUP_TEMPLATE_STUDENT_REJECTED,
    },
  },
};

// The signing key for admin JWTs.
if (!config.jwtSecret || config.jwtSecret.length < 32) {
  if (config.env === 'production') {
    console.error('[auth] JWT_SECRET must be set to a random string of at least 32 characters in production.');
    process.exit(1);
  }
  // Local development: a per-run secret. Sign-ins end when the server restarts.
  config.jwtSecret = require('crypto').randomBytes(48).toString('hex');
  console.warn('[auth] JWT_SECRET is not set (or is shorter than 32 characters). Using a temporary one — admin sessions will end on restart.');
}

module.exports = config;
