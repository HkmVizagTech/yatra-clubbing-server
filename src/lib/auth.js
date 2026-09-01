const config = require('../config');

function getToken(req) {
  const cookie = req.headers.cookie || '';
  const raw = (cookie.match(/yc_admin_token=([^;]+)/) || [])[1] || '';
  let cookieToken = '';
  if (raw) {
    try {
      cookieToken = decodeURIComponent(raw);
    } catch {
      cookieToken = raw;
    }
  }
  const auth = req.headers.authorization || '';
  const bearer = auth.replace(/^Bearer\s+/i, '');
  return cookieToken || bearer;
}

function isAdminAuthorized(req) {
  if (!config.adminToken) return false;
  const token = getToken(req);
  return Boolean(token && token === config.adminToken);
}

module.exports = { getToken, isAdminAuthorized };
