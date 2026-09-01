const crypto = require('crypto');
const config = require('../config');

// Upload a base64 data-URI (or raw base64 with explicit mime) to Cloudinary.
// Returns the secure URL or null on any failure/config-missing.
async function uploadToCloudinary(b64, mime, publicId, folder) {
  const { cloudName, apiKey, apiSecret } = config.cloudinary;
  if (!cloudName || !apiKey || !apiSecret) return null;

  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}`;
  const signature = crypto.createHash('sha256').update(paramsToSign + apiSecret).digest('hex');

  const form = new FormData();
  form.append('file', `data:${mime};base64,${b64}`);
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', folder);
  form.append('public_id', publicId);

  const resourceType = mime.includes('pdf') ? 'raw' : 'image';
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`, {
    method: 'POST',
    body: form,
  });
  if (!r.ok) return null;
  const data = await r.json();
  return data.secure_url || null;
}

function parseDataUri(dataUri, fallbackType) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUri || '');
  const mime = m ? m[1] : fallbackType || 'application/octet-stream';
  const b64 = m ? m[2] : dataUri;
  return { mime, b64 };
}

module.exports = { uploadToCloudinary, parseDataUri };
