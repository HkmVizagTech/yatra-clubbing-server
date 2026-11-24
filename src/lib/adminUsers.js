const { ObjectId } = require('mongodb');
const { getDb } = require('./mongodb');
const { hashPassword } = require('./passwords');
const config = require('../config');

const COL = 'admin_users';

const normEmail = (e) => String(e || '').trim().toLowerCase();

async function col() {
  return (await getDb()).collection(COL);
}

function toId(id) {
  try {
    return new ObjectId(String(id));
  } catch (e) {
    return null;
  }
}

// What the API may show about a user — never the hash.
function publicUser(u) {
  if (!u) return null;
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active !== false,
    createdAt: u.createdAt || null,
    lastLoginAt: u.lastLoginAt || null,
  };
}

let indexed = null;
function ensureIndexes() {
  if (!indexed) {
    indexed = col()
      .then((c) => c.createIndex({ email: 1 }, { unique: true }))
      .catch((e) => {
        console.warn('[auth] unique index on admin_users.email not created:', e.message);
        return null;
      });
  }
  return indexed;
}

async function findByEmail(email) {
  return (await col()).findOne({ email: normEmail(email) });
}

async function findById(id) {
  const _id = toId(id);
  if (!_id) return null;
  return (await col()).findOne({ _id });
}

async function listUsers() {
  const rows = await (await col()).find({}).toArray();
  return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(publicUser);
}

async function createUser({ name, email, password, role }) {
  const c = await col();
  await ensureIndexes();
  const doc = {
    name: String(name || '').trim(),
    email: normEmail(email),
    role,
    active: true,
    passwordHash: await hashPassword(password),
    tokenVersion: 0,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  const r = await c.insertOne(doc);
  return { ...doc, _id: r.insertedId };
}

async function updateUser(id, set, { bumpToken = false } = {}) {
  const _id = toId(id);
  if (!_id) return null;
  const update = { $set: set };
  if (bumpToken) update.$inc = { tokenVersion: 1 };
  const c = await col();
  await c.updateOne({ _id }, update);
  return c.findOne({ _id });
}

async function countActiveSuperAdmins() {
  return (await col()).countDocuments({ role: 'super_admin', active: true });
}

async function countUsers() {
  return (await col()).countDocuments({});
}

// First run: if there are no admin users yet and ADMIN_EMAIL / ADMIN_PASSWORD
// are set, create that person as a super admin. After that these variables are
// ignored, so change the password in the console, not in the env.
async function ensureBootstrapAdmin() {
  try {
    await ensureIndexes();
    if ((await countUsers()) > 0) return;
    const { bootstrapEmail, bootstrapPassword } = config;
    if (!bootstrapEmail || !bootstrapPassword) {
      console.warn('[auth] no admin users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD (or run: npm run create-admin) to create the first super admin.');
      return;
    }
    await createUser({ name: 'Super admin', email: bootstrapEmail, password: bootstrapPassword, role: 'super_admin' });
    console.log('[auth] created the first super admin:', normEmail(bootstrapEmail));
  } catch (e) {
    console.warn('[auth] bootstrap skipped:', e.message);
  }
}

module.exports = {
  normEmail,
  publicUser,
  ensureIndexes,
  findByEmail,
  findById,
  listUsers,
  createUser,
  updateUser,
  countActiveSuperAdmins,
  countUsers,
  ensureBootstrapAdmin,
};
