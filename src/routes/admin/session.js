const express = require('express');
const config = require('../../config');

const router = express.Router();

// POST /api/admin/login
router.post('/login', (req, res) => {
  const { token } = req.body || {};
  const adminToken = config.adminToken;

  if (!adminToken) {
    return res.status(500).json({ error: 'Admin not configured' });
  }
  if (!token || token !== adminToken) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const isProd = config.env === 'production';
  res.cookie('yc_admin_token', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 60 * 60 * 8 * 1000, // 8 hours
    path: '/',
  });
  res.json({ ok: true, token });
});

// POST /api/admin/logout
router.post('/logout', (req, res) => {
  res.clearCookie('yc_admin_token', { httpOnly: true, secure: config.env === 'production', path: '/' });
  res.json({ ok: true });
});

module.exports = router;
