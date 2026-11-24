const crypto = require('crypto');

// scrypt with a per-password random salt. Stored as
//   scrypt$N$r$p$<salt b64>$<hash b64>
// so the cost can be raised later without breaking existing hashes.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}

// A real hash of a throwaway value: verifying against it costs the same time as
// a real check, so "unknown email" and "wrong password" can't be told apart by
// how long the response takes.
let dummy = null;
async function dummyHash() {
  if (!dummy) dummy = await hashPassword(crypto.randomBytes(12).toString('hex'));
  return dummy;
}

// Returns an error message, or null when the password is acceptable.
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 10) return 'Use at least 10 characters.';
  if (s.length > 128) return 'That password is too long.';
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return 'Include at least one letter and one number.';
  return null;
}

module.exports = { hashPassword, verifyPassword, dummyHash, passwordProblem };
