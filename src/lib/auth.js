const jwt = require('jsonwebtoken');
const config = require('../config');
const { findById } = require('./adminUsers');
const { requiredPermission, can, permissionsFor, ROLES } = require('./permissions');

const ISSUER = 'yatra-clubbing';
const AUDIENCE = 'admin';

function signAccessToken(user) {
  return jwt.sign(
    { role: user.role, ver: user.tokenVersion || 0, name: user.name, email: user.email },
    config.jwtSecret,
    { algorithm: 'HS256', subject: String(user._id), issuer: ISSUER, audience: AUDIENCE, expiresIn: config.jwtExpiresIn }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
}

function getToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : '';
}

// Runs on every /api request. A valid token is not enough on its own: the user
// is loaded from the database each time, so deactivating someone, changing
// their role or resetting their password takes effect on their very next
// request instead of when the token happens to expire.
async function authenticate(req, res, next) {
  req.user = null;
  const token = getToken(req);
  if (!token) return next();

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (e) {
    return next(); // expired / forged / wrong audience → simply not signed in
  }

  try {
    const user = await findById(claims.sub);
    if (user && user.active !== false && (user.tokenVersion || 0) === claims.ver) {
      req.user = { id: String(user._id), name: user.name, email: user.email, role: user.role };
    }
    next();
  } catch (e) {
    res.status(503).json({ error: 'Sign-in service is unavailable right now. Please try again.' });
  }
}

// Central gate: looks the request up in the policy table and checks the role.
function enforce(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  const perm = requiredPermission(req.method, req.originalUrl || req.url);
  if (perm === null) return next();
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  if (perm !== 'auth' && !can(req.user.role, perm)) {
    return res.status(403).json({ error: 'You do not have permission to do that.', required: perm });
  }
  next();
}

// Route files still call this as a second line of defence.
function isAdminAuthorized(req) {
  return !!req.user;
}

function describeUser(user) {
  return {
    id: String(user._id || user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    roleLabel: (ROLES[user.role] || {}).label || user.role,
    permissions: permissionsFor(user.role),
  };
}

module.exports = { signAccessToken, verifyAccessToken, getToken, authenticate, enforce, isAdminAuthorized, describeUser };
