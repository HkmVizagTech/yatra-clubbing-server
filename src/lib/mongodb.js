const { MongoClient } = require('mongodb');
const config = require('../config');

let _client;
let _db;
let _indexesEnsured = false;

async function getClient() {
  if (_client) return _client;
  if (!config.mongoUri) throw new Error('MONGODB_URI is not set');
  _client = new MongoClient(config.mongoUri, {
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
    socketTimeoutMS: 10000,
  });
  await _client.connect();
  return _client;
}

async function ensureIndexes(db) {
  if (_indexesEnsured) return;
  _indexesEnsured = true;
  try {
    await Promise.all([
      db.collection('registrations').createIndex({ event_code: 1, created_at: -1 }),
      db.collection('registrations').createIndex({ event_slug: 1, created_at: -1 }),
      db.collection('registrations').createIndex({ payment_status: 1 }),
      db.collection('registrations').createIndex({ event_code: 1, ref: 1 }, { unique: true }),
      db.collection('registrations').createIndex({ event_slug: 1, ref: 1 }, { unique: true }),
      db.collection('registrations').createIndex({ student_status: 1 }),
      db.collection('events').createIndex({ code: 1 }, { unique: true }),
      db.collection('events').createIndex({ slug: 1 }, { unique: true, sparse: true }),
      db.collection('events').createIndex({ status: 1 }),
    ]);
  } catch (e) {
    // unique index conflicts (legacy data) should never block a request
    console.warn('[mongodb] ensureIndexes warning:', e.message);
  }
}

async function getDb() {
  const client = await getClient();
  if (!_db) _db = client.db(config.mongoDb);
  ensureIndexes(_db).catch(() => {});
  return _db;
}

function isMongoConfigured() {
  return Boolean(config.mongoUri);
}

module.exports = { getDb, isMongoConfigured, getClient };
