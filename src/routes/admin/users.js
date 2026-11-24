const express = require('express');
const {
  publicUser, listUsers, createUser, findById, findByEmail, updateUser, countActiveSuperAdmins, normEmail,
} = require('../../lib/adminUsers');
const { hashPassword, passwordProblem } = require('../../lib/passwords');
const { ROLES, isRole } = require('../../lib/permissions');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// GET /api/admin/users -> { users, roles }
router.get('/', async (req, res) => {
  try {
    const roles = Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, description: r.description }));
    res.json({ users: await listUsers(), roles });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

// POST /api/admin/users { name, email, password, role }
router.post('/', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const email = normEmail(b.email);
  if (!name) return res.status(400).json({ error: 'Enter a name.', field: 'name' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.', field: 'email' });
  if (!isRole(b.role)) return res.status(400).json({ error: 'Choose a role.', field: 'role' });
  const problem = passwordProblem(b.password);
  if (problem) return res.status(400).json({ error: problem, field: 'password' });
  try {
    if (await findByEmail(email)) return res.status(409).json({ error: 'A team member with that email already exists.', field: 'email' });
    const user = await createUser({ name, email, password: b.password, role: b.role });
    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'A team member with that email already exists.', field: 'email' });
    res.status(502).json({ error: String(e) });
  }
});

// PATCH /api/admin/users/:id { name?, role?, active?, password? }
router.patch('/:id', async (req, res) => {
  const b = req.body || {};
  try {
    const target = await findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Team member not found.' });
    const isSelf = String(target._id) === req.user.id;

    const set = {};
    let bump = false;

    if (b.name !== undefined) {
      const name = String(b.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
      set.name = name;
    }
    if (b.role !== undefined && b.role !== target.role) {
      if (!isRole(b.role)) return res.status(400).json({ error: 'Unknown role.' });
      if (isSelf) return res.status(400).json({ error: 'You cannot change your own role.' });
      set.role = b.role;
      bump = true;
    }
    if (b.active !== undefined && Boolean(b.active) !== (target.active !== false)) {
      if (isSelf) return res.status(400).json({ error: 'You cannot disable your own account.' });
      set.active = Boolean(b.active);
      bump = true;
    }
    if (b.password !== undefined && b.password !== '') {
      const problem = passwordProblem(b.password);
      if (problem) return res.status(400).json({ error: problem, field: 'password' });
      set.passwordHash = await hashPassword(b.password);
      bump = true;
    }

    // Never leave the team without a working super admin.
    const losesSuper = target.role === 'super_admin' && target.active !== false &&
      ((set.role && set.role !== 'super_admin') || set.active === false);
    if (losesSuper && (await countActiveSuperAdmins()) <= 1) {
      return res.status(400).json({ error: 'There must be at least one active super admin.' });
    }

    if (Object.keys(set).length === 0) return res.json({ user: publicUser(target) });
    const updated = await updateUser(target._id, set, { bumpToken: bump });
    res.json({ user: publicUser(updated) });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

module.exports = router;
