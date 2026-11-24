const express = require('express');
const { findByEmail, findById, updateUser } = require('../../lib/adminUsers');
const { verifyPassword, hashPassword, dummyHash, passwordProblem } = require('../../lib/passwords');
const { signAccessToken, describeUser } = require('../../lib/auth');
const config = require('../../config');

const router = express.Router();

// Slow down password guessing: 8 failed sign-ins per email+IP per 15 minutes.
const fails = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILS = 8;
function failKey(req, email) {
  return (req.ip || 'ip') + '|' + email;
}
function tooMany(key) {
  const rec = fails.get(key);
  if (!rec) return false;
  if (Date.now() - rec.t > WINDOW) { fails.delete(key); return false; }
  return rec.n >= MAX_FAILS;
}
function noteFail(key) {
  const rec = fails.get(key);
  if (!rec || Date.now() - rec.t > WINDOW) fails.set(key, { n: 1, t: Date.now() });
  else rec.n += 1;
}

// POST /api/admin/auth/login { email, password } -> { token, expiresIn, user }
router.post('/login', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' });

  const key = failKey(req, email);
  if (tooMany(key)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });

  try {
    const user = await findByEmail(email);
    const ok = await verifyPassword(password, user ? user.passwordHash : await dummyHash());
    if (!user || !ok) {
      noteFail(key);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (user.active === false) {
      return res.status(403).json({ error: 'This account has been disabled. Ask a super admin.' });
    }
    fails.delete(key);
    await updateUser(user._id, { lastLoginAt: new Date().toISOString() });
    res.json({ token: signAccessToken(user), expiresIn: config.jwtExpiresIn, user: describeUser(user) });
  } catch (e) {
    res.status(503).json({ error: 'Sign-in service is unavailable right now. Please try again.' });
  }
});

// POST /api/admin/auth/logout — the token is held by the browser, so this just
// confirms; "sign out everywhere" is a password change or deactivation.
router.post('/logout', (req, res) => res.json({ ok: true }));

// GET /api/admin/auth/me -> { user } (also how the console re-checks a session)
router.get('/me', (req, res) => res.json({ user: describeUser(req.user) }));

// POST /api/admin/auth/change-password { current, next }
router.post('/change-password', async (req, res) => {
  const { current, next } = req.body || {};
  try {
    const user = await findById(req.user.id);
    if (!user || !(await verifyPassword(String(current || ''), user.passwordHash))) {
      return res.status(400).json({ error: 'Your current password is not correct.' });
    }
    const problem = passwordProblem(next);
    if (problem) return res.status(400).json({ error: problem });
    // Bumping the token version signs out every other session.
    const updated = await updateUser(user._id, { passwordHash: await hashPassword(next) }, { bumpToken: true });
    res.json({ ok: true, token: signAccessToken(updated), user: describeUser(updated) });
  } catch (e) {
    res.status(503).json({ error: 'Could not change the password right now.' });
  }
});

module.exports = router;
