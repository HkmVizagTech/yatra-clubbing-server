const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');

// Cloudflare R2 over its S3 API — the same account the Vanabhojanam site uses.
// Yatra's files live under the "yatra/" prefix so the two never mix.

const SIGNED_URL_TTL = 2 * 60 * 60; // seconds a "View ID" link stays valid
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function configured() {
  const r = config.r2 || {};
  return Boolean(r.accountId && r.accessKeyId && r.secretAccessKey && (r.idBucket || r.bucket));
}

let client = null;
function s3() {
  if (!configured()) {
    const e = new Error('Cloudflare R2 is not configured');
    e.code = 'NOT_CONFIGURED';
    throw e;
  }
  const r = config.r2;
  client = client || new S3Client({
    region: 'auto',
    endpoint: `https://${r.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: r.accessKeyId, secretAccessKey: r.secretAccessKey },
  });
  return client;
}

const idBucket = () => config.r2.idBucket || config.r2.bucket;
const safe = (s) => String(s || 'x').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'x';

// Stores a student's ID photo and returns its object key (what we keep in the DB).
async function uploadStudentId(buffer, mime, ref, eventCode) {
  const ext = EXT[mime];
  if (!ext) throw new Error('Unsupported image type');
  const key = `yatra/student-id-cards/${safe(eventCode)}/${safe(ref)}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  await s3().send(new PutObjectCommand({ Bucket: idBucket(), Key: key, Body: buffer, ContentType: mime }));
  return key;
}

// A temporary link an admin can open. The bucket itself stays private.
function signedIdUrl(key, ttl = SIGNED_URL_TTL) {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: idBucket(), Key: key }), { expiresIn: ttl });
}

function removeObject(key) {
  return s3().send(new DeleteObjectCommand({ Bucket: idBucket(), Key: key }));
}

module.exports = { configured, uploadStudentId, signedIdUrl, removeObject };
