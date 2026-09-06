require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI,
  mongoDb: process.env.MONGODB_DB || 'yatra',
  adminToken: process.env.ADMIN_TOKEN,
  frontendUrls: (process.env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
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
    // Gupshup addresses templates by UUID. An event can override these in its
    // advanced settings, but only with a UUID — see resolveTemplateId().
    templates: {
      booking: process.env.GUPSHUP_TEMPLATE_BOOKING,
      studentApproved: process.env.GUPSHUP_TEMPLATE_STUDENT_APPROVED,
      studentRejected: process.env.GUPSHUP_TEMPLATE_STUDENT_REJECTED,
    },
  },
};
