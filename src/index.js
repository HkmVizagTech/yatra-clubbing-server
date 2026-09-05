require('dotenv').config();
const express = require('express');
const cors = require('cors');
const config = require('./config');

const publicEventRouter = require('./routes/publicEvent');
const eventsRouter = require('./routes/events');
const registrationsRouter = require('./routes/registrations');
const registerRouter = require('./routes/register');
const createOrderRouter = require('./routes/createOrder');
const verifyPaymentRouter = require('./routes/verifyPayment');
const verifyStudentRouter = require('./routes/verifyStudent');
const whatsappRouter = require('./routes/whatsapp');
const webhookRazorpayRouter = require('./routes/webhookRazorpay');const adminSessionRouter = require('./routes/admin/session');
const adminRefundAllRouter = require('./routes/admin/refundAll');
const adminRefundAuditRouter = require('./routes/admin/refundAudit');
const adminRefundManualRouter = require('./routes/admin/refundManual');
const { publicRouter: collegesPublicRouter, adminRouter: collegesAdminRouter } = require('./routes/colleges');

const app = express();
app.disable('x-powered-by');

// CORS — allow the configured frontend origin(s) with credentials (admin cookie).
//
// FRONTEND_URL is a comma-separated allowlist. Origins are compared after
// normalising case and any trailing slash, because "https://Example.org/" and
// "https://example.org" are the same origin but not the same string — that
// mismatch is the usual cause of a working local build and a CORS-blocked
// production one.
function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

const allowedOrigins = new Set(
  (config.frontendUrls.length ? config.frontendUrls : ['http://localhost:3000'])
    .map(normalizeOrigin)
    .filter(Boolean)
);

app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / no-origin (curl, health checks, server-side fetches).
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(normalizeOrigin(origin))) return cb(null, true);
      console.warn(
        `[cors] blocked origin ${origin} — add it to FRONTEND_URL (currently: ${[...allowedOrigins].join(', ') || 'unset'})`
      );
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

// The Razorpay webhook needs the RAW body for HMAC signature verification, so it
// is mounted BEFORE the JSON body parser.
// type:'*/*' rather than 'application/json': if Razorpay ever sends a charset
// parameter or a different content-type, a narrower matcher silently skips the
// raw parser, and the signature would then be computed over re-serialised JSON
// that no longer matches the bytes Razorpay signed.
app.use('/api/webhook/razorpay', express.raw({ type: '*/*', limit: '1mb' }), webhookRazorpayRouter);

// Everything else uses JSON; generous limit to accept base64 student-ID uploads.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check (used by Railway / uptime monitors)
app.get('/health', (req, res) => res.json({ ok: true, service: 'yatra-backend' }));

// Public + booking routes
app.use('/api/public', publicEventRouter);
app.use('/api/events', eventsRouter);
app.use('/api/registrations', registrationsRouter);
app.use('/api/register', registerRouter);
app.use('/api/create-order', createOrderRouter);
app.use('/api/verify-payment', verifyPaymentRouter);
app.use('/api/verify-student', verifyStudentRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/colleges', collegesPublicRouter);

// Admin routes
app.use('/api/admin', adminSessionRouter);
app.use('/api/admin', adminRefundAllRouter);
app.use('/api/admin', adminRefundAuditRouter);
app.use('/api/admin', adminRefundManualRouter);
app.use('/api/admin/colleges', collegesAdminRouter);

// Fallback: unknown API route
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler (CORS errors, body parse errors, etc.)
app.use((err, req, res, next) => {
  console.error('[server] error:', err && err.message);
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Not allowed by CORS' });
  }
  res.status(500).json({ error: String((err && err.message) || err) });
});

app.listen(config.port, () => {
  console.log(`Yatra backend listening on port ${config.port} (${config.env})`);
  // Printed on every boot so a CORS misconfiguration is visible in the deploy
  // log rather than only in a browser console.
  console.log(`[cors] allowed origins: ${[...allowedOrigins].join(', ') || '(none)'}`);
});
