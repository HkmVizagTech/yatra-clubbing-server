// Roles and what they may do. Permissions are checked in two places: the
// central route policy below (so a route can't be left open by accident) and,
// on the client, to hide controls a person can't use.

const ALL = [
  'dashboard:read',
  'dashboard:revenue', // rupee totals on the dashboard
  'events:list', //     the trip list (needed for the trip filters), nothing more
  'events:read',
  'events:write',
  'registrations:read',
  'registrations:write',
  'students:verify',
  'colleges:read',
  'colleges:write',
  'refunds:manage',
  'users:manage',
];

const ROLES = {
  super_admin: {
    label: 'Super admin',
    description: 'Everything, including adding and removing team members.',
    permissions: ALL,
  },
  admin: {
    label: 'Admin',
    description: 'Create and edit trips, manage registrations, verify IDs, issue refunds and see revenue.',
    permissions: ALL.filter((p) => p !== 'users:manage'),
  },
  verifier: {
    label: 'ID verifier',
    description: 'See registrations and approve or reject student IDs. No trip editing, refunds or revenue.',
    permissions: ['dashboard:read', 'events:list', 'events:read', 'registrations:read', 'students:verify', 'colleges:read'],
  },
  viewer: {
    label: 'Viewer',
    description: 'Read-only: dashboard counts, trips and registrations. No revenue figures.',
    permissions: ['dashboard:read', 'events:list', 'events:read', 'registrations:read', 'colleges:read'],
  },
  devotee: {
    label: 'Devotee (read-only)',
    description: 'Can only look at registrations and the dashboard counts. Cannot change anything.',
    permissions: ['dashboard:read', 'events:list', 'registrations:read'],
  },
};

const ROLE_KEYS = Object.keys(ROLES);
const isRole = (r) => ROLE_KEYS.includes(r);
const permissionsFor = (role) => (ROLES[role] ? [...ROLES[role].permissions] : []);
const can = (role, perm) => !!ROLES[role] && ROLES[role].permissions.includes(perm);

// Central policy: first matching rule wins.
//   perm = null    → public (no sign-in)
//   perm = 'auth'  → any signed-in admin user
//   otherwise      → that permission
// Anything under /api/admin that is not listed fails closed to super admins.
const POLICY = [
  ['*', /^\/api\/admin\/auth\/(login|logout)$/, null],
  ['*', /^\/api\/admin\/auth\//, 'auth'],
  ['*', /^\/api\/admin\/users(\/|$)/, 'users:manage'],
  ['*', /^\/api\/admin\/refund-/, 'refunds:manage'],
  ['*', /^\/api\/admin\/send-confirmations/, 'registrations:write'],
  ['GET', /^\/api\/admin\/colleges(\/|$)/, 'colleges:read'],
  ['*', /^\/api\/admin\/colleges(\/|$)/, 'colleges:write'],
  ['*', /^\/api\/admin(\/|$)/, 'users:manage'],
  ['POST', /^\/api\/verify-student$/, 'students:verify'],
  ['GET', /^\/api\/registrations(\/|$)/, 'registrations:read'],
  ['*', /^\/api\/registrations(\/|$)/, 'registrations:write'],
  ['GET', /^\/api\/events\/check-(code|slug)$/, 'events:write'],
  ['GET', /^\/api\/events$/, 'events:list'],
  ['GET', /^\/api\/events(\/|$)/, 'events:read'],
  ['*', /^\/api\/events(\/|$)/, 'events:write'],
];

function requiredPermission(method, path) {
  const p = String(path || '').split('?')[0].replace(/\/+$/, '') || '/';
  const m = String(method || 'GET').toUpperCase();
  for (const [rm, re, perm] of POLICY) {
    if ((rm === '*' || rm === m) && re.test(p)) return perm;
  }
  return null; // not an admin-protected path (public booking routes etc.)
}

module.exports = { ALL, ROLES, ROLE_KEYS, isRole, permissionsFor, can, requiredPermission, POLICY };
