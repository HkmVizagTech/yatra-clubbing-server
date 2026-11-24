// Create (or reset) an admin user from the command line:
//   npm run create-admin -- you@example.com "StrongPass123" "Your Name" super_admin
// Roles: super_admin | admin | verifier | viewer
require('dotenv').config();
const { createUser, findByEmail, updateUser, ensureIndexes } = require('../src/lib/adminUsers');
const { hashPassword, passwordProblem } = require('../src/lib/passwords');
const { isRole, ROLE_KEYS } = require('../src/lib/permissions');

(async () => {
  const [email, password, name = 'Admin', role = 'super_admin'] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: npm run create-admin -- <email> <password> [name] [role]');
    process.exit(2);
  }
  if (!isRole(role)) { console.error('Role must be one of:', ROLE_KEYS.join(', ')); process.exit(2); }
  const problem = passwordProblem(password);
  if (problem) { console.error('Password:', problem); process.exit(2); }
  await ensureIndexes();
  const existing = await findByEmail(email);
  if (existing) {
    await updateUser(existing._id, { passwordHash: await hashPassword(password), role, active: true, name }, { bumpToken: true });
    console.log('Updated existing user:', email, '→', role);
  } else {
    await createUser({ name, email, password, role });
    console.log('Created user:', email, '→', role);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
