'use strict';
/*
 * ClassPulse storage layer (zero dependencies).
 * Same small "hash" API on top of four backends, chosen automatically:
 *   0. MongoDB Atlas    – when MONGODB_URI is set (collection "kv", one doc per hash field)
 *   1. Redis over REST  – Upstash Redis / Vercel KV   (needed on Vercel: survives cold starts)
 *   2. JSON file        – local machine or a Render disk (data/db.json)
 *   3. Memory           – fallback only (data is lost on restart)
 */
const fs = require('fs'), path = require('path');

/* tiny .env loader (no dependency): KEY=value or KEY="value"; real environment variables win */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]; if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch (e) { /* no .env file: fine */ }

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

function redisStore() {
  const cmd = async (...args) => {
    const r = await fetch(REST_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + REST_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.result;
  };
  return {
    kind: 'redis',
    async ping() { await cmd('PING'); return true; },
    async hgetall(k) { const a = (await cmd('HGETALL', k)) || [], o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; },
    async hget(k, f) { return cmd('HGET', k, f); },
    async hset(k, f, v) { await cmd('HSET', k, f, v); },
    async hsetnx(k, f, v) { return (await cmd('HSETNX', k, f, v)) === 1; },
    async hdel(k, f) { await cmd('HDEL', k, f); },
    async hincr(k, f, n) { return cmd('HINCRBY', k, f, n); },
    async del(k) { await cmd('DEL', k); }
  };
}

/* MongoDB: every hash field is one document {k, f, v | n}. A unique index on (k, f) makes
 * HSETNX / upsert atomic, and HINCRBY uses $inc, so concurrent students never overwrite each other. */
function mongoStore(getCol) {
  const dup = e => e && (e.code === 11000 || /E11000/.test(String(e.message)));
  const val = d => String(d.v !== undefined ? d.v : d.n);
  return {
    kind: 'mongodb',
    async ping() { await getCol(); return true; },
    async hgetall(k) { const c = await getCol(), o = {}; for (const d of await c.find({ k }).toArray()) o[d.f] = val(d); return o; },
    async hget(k, f) { const d = await (await getCol()).findOne({ k, f }); return d ? val(d) : null; },
    async hset(k, f, v) {
      const c = await getCol(), run = () => c.updateOne({ k, f }, { $set: { v: String(v) }, $unset: { n: '' } }, { upsert: true });
      try { await run(); } catch (e) { if (dup(e)) await run(); else throw e; }
    },
    async hsetnx(k, f, v) {
      try { return (await (await getCol()).updateOne({ k, f }, { $setOnInsert: { v: String(v) } }, { upsert: true })).upsertedCount === 1; }
      catch (e) { if (dup(e)) return false; throw e; }
    },
    async hdel(k, f) { await (await getCol()).deleteOne({ k, f }); },
    async hincr(k, f, n) {
      const c = await getCol(), run = () => c.findOneAndUpdate({ k, f }, { $inc: { n } }, { upsert: true, returnDocument: 'after' });
      let r; try { r = await run(); } catch (e) { if (dup(e)) r = await run(); else throw e; }
      const d = r && r.value !== undefined ? r.value : r; return d ? d.n : n;
    },
    async del(k) { await (await getCol()).deleteMany({ k }); }
  };
}
function connectMongo(uri) {
  let p = null;
  return () => p || (p = (async () => {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 5 });
    await client.connect();
    const col = client.db(process.env.MONGODB_DB || 'classpulse').collection('kv');
    await col.createIndex({ k: 1, f: 1 }, { unique: true });
    return col;
  })().catch(e => { p = null; throw e; })); // retry on the next request if Atlas was unreachable
}

function memoryStore(file) {
  const db = new Map();
  let timer = null;
  if (file) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, h] of Object.entries(raw)) db.set(k, new Map(Object.entries(h)));
    } catch (e) { /* first run */ }
  }
  const writeNow = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const o = {}; for (const [k, h] of db) o[k] = Object.fromEntries(h);
      fs.writeFileSync(file + '.tmp', JSON.stringify(o));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { console.error('save failed:', e.message); }
  };
  const save = () => {
    if (!file || timer) return;
    timer = setTimeout(() => { timer = null; writeNow(); }, 400);
  };
  if (file) { // flush a pending write when the process is stopped
    const flush = () => { if (timer) { clearTimeout(timer); timer = null; writeNow(); } };
    process.on('exit', flush);
    ['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { flush(); process.exit(0); }));
  }
  const H = k => { let h = db.get(k); if (!h) db.set(k, h = new Map()); return h; };
  return {
    kind: file ? 'file' : 'memory',
    async ping() { return true; },
    async hgetall(k) { return Object.fromEntries(db.get(k) || []); },
    async hget(k, f) { const h = db.get(k); return h && h.has(f) ? h.get(f) : null; },
    async hset(k, f, v) { H(k).set(f, String(v)); save(); },
    async hsetnx(k, f, v) { const h = H(k); if (h.has(f)) return false; h.set(f, String(v)); save(); return true; },
    async hdel(k, f) { const h = db.get(k); if (h) { h.delete(f); if (!h.size) db.delete(k); save(); } },
    async hincr(k, f, n) { const h = H(k), v = (parseInt(h.get(f), 10) || 0) + n; h.set(f, String(v)); save(); return v; },
    async del(k) { db.delete(k); save(); }
  };
}

let store;
if (process.env.MONGODB_URI) store = mongoStore(connectMongo(process.env.MONGODB_URI));
else if (REST_URL && REST_TOKEN) store = redisStore();
else if (process.env.VERCEL) store = memoryStore(null); // Vercel disk is read-only / not shared
else store = memoryStore(process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'));

module.exports = store;
module.exports._mongoStore = mongoStore; // exported for tests
