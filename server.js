'use strict';
/*
 * ClassPulse server. Zero dependencies. Run: node server.js
 *
 * Stateless by design: every request loads the session from storage (store.js),
 * so it works on Vercel/serverless, survives restarts, and lets a teacher come
 * back to an old session with all data intact. Live updates use short polling.
 */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const S = require('./store');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const EMOJI = ['like', 'love', 'idea', 'smile', 'wow'];
const ONLINE_MS = 15000, BEAT_MS = 8000;

const now = () => Date.now();
const KS = c => 'cp:s:' + c, KT = t => 'cp:t:' + t;
const parse = s => { try { return JSON.parse(s); } catch (e) { return null; } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const json = (res, o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const fail = (res, s, msg) => json(res, { error: msg }, s);

async function readBody(req) {
  try { const pre = req.body; if (pre && typeof pre === 'object' && !Buffer.isBuffer(pre)) return pre; if (typeof pre === 'string') return parse(pre) || {}; } catch (e) { /* fall through */ }
  return new Promise(r => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 2e5) req.destroy(); });
    req.on('end', () => r(parse(d || '{}') || {}));
    req.on('error', () => r({}));
  });
}

/* ------------------------------------------------------------------ load / save
 * One hash per session:  meta | q | queue | u:<sid> | qa:<id> | h:<n> | rx:<emoji>
 * Frequent writers (students) only touch their own field, so there are no lost updates.
 */
async function load(code) {
  if (!/^\d{4,6}$/.test(code || '')) return null;
  const h = await S.hgetall(KS(code));
  if (!h.meta) return null;
  const s = { code, meta: parse(h.meta) || {}, q: parse(h.q), queue: parse(h.queue) || [], users: {}, qa: [], hist: [], rx: {} };
  for (const [f, v] of Object.entries(h)) if (f.startsWith('u:')) { const u = parse(v); if (u) s.users[f.slice(2)] = u; }
  for (const [f, v] of Object.entries(h)) {
    if (f.startsWith('a:')) { const u = s.users[f.slice(2)], x = parse(v); if (u && x) u.a = x; }
    else if (f.startsWith('seen:')) { const u = s.users[f.slice(5)]; if (u) u.seen = +v || 0; }
    else if (f.startsWith('qa:')) { const x = parse(v); if (x) s.qa.push(x); }
    else if (f.startsWith('h:')) { const x = parse(v); if (x) s.hist.push(x); }
    else if (f.startsWith('rx:')) s.rx[f.slice(3)] = +v || 0;
  }
  s.hist.sort((a, b) => a.n - b.n);
  s.archived = new Set(s.hist.map(x => x.n));
  return s;
}
const saveMeta = s => S.hset(KS(s.code), 'meta', JSON.stringify(s.meta));
/* A student's data is split in 3 independent fields so that a heartbeat can never overwrite a fresh answer:
 *   u:<sid> profile (name, pace, confused)   a:<sid> latest answer   seen:<sid> last-seen time */
const saveUser = (s, sid) => { const { a, seen, ...rest } = s.users[sid]; return S.hset(KS(s.code), 'u:' + sid, JSON.stringify(rest)); };
const touch = (s, sid) => { s.users[sid].seen = now(); return S.hset(KS(s.code), 'seen:' + sid, String(now())); };
const curN = s => (s.q ? s.q.n : 0);
const isOpen = s => !!s.q && !s.archived.has(s.q.n) && !(s.q.dur && now() > s.q.start + s.q.dur * 1000);
const online = u => u.fake || now() - (u.seen || 0) < ONLINE_MS;
const isConf = (s, u) => !!(u.conf && u.conf.n === curN(s));

/* ------------------------------------------------------------------ answers / scoring */
function currentAnswers(s) {
  const a = {}, q = s.q; if (!q) return a;
  for (const [sid, u] of Object.entries(s.users)) if (u.a && u.a.n === q.n) a[sid] = u.a.v;
  return a;
}
function tally(q, answers, names, teacher) {
  if (!q) return [];
  if (q.type === 'text') return teacher ? Object.entries(answers).map(([sid, t]) => [t, names[sid] || 'Anon']) : [];
  if (q.type === 'cloud') {
    const m = {}; Object.values(answers).forEach(t => { const w = String(t).toLowerCase().trim(); if (w) m[w] = (m[w] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 40);
  }
  return q.options.map((_, i) => Object.values(answers).filter(a => a === i).length);
}
const namesOf = s => { const m = {}; for (const [sid, u] of Object.entries(s.users)) m[sid] = u.name; return m; };

/* Close a question once: HSETNX on h:<n> makes sure only one request wins. */
async function archive(s) {
  const q = s.q; if (!q || s.archived.has(q.n)) return;
  const ans = {}, times = {}, pts = {}; let confused = 0;
  for (const [sid, u] of Object.entries(s.users)) {
    if (u.a && u.a.n === q.n) { ans[sid] = u.a.v; times[sid] = u.a.t; }
    if (isConf(s, u)) confused++;
  }
  if (q.correct !== null) for (const sid in ans) if (ans[sid] === q.correct) {
    const frac = q.dur ? Math.max(0, 1 - (times[sid] - q.start) / (q.dur * 1000)) : 0.5;
    pts[sid] = 100 + Math.round(400 * frac);
  }
  const names = namesOf(s);
  const entry = { n: q.n, text: q.text, type: q.type, options: q.options, correct: q.correct, ans, pts, times, qstart: q.start,
    res: tally(q, ans, names, true), answered: Object.keys(ans).length, confused, joined: Object.keys(s.users).length };
  if (await S.hsetnx(KS(s.code), 'h:' + q.n, JSON.stringify(entry))) { s.hist.push(entry); s.archived.add(q.n); }
  else { const h = parse(await S.hget(KS(s.code), 'h:' + q.n)); if (h) { s.hist.push(h); s.archived.add(q.n); } }
}
const settle = async s => { if (s.q && !isOpen(s) && !s.archived.has(s.q.n)) await archive(s); };

/* One row per (student, question): who answered what, when, and how many seconds after the question was sent. */
function answerRows(s) {
  const names = namesOf(s), rows = [];
  const fmt = (q, v) => q.type === 'rating' ? String(v + 1) : (q.type === 'text' || q.type === 'cloud') ? String(v) : (q.options[v] === undefined ? '' : q.options[v]);
  const add = (sid, q, v, t, qstart, live) => rows.push({ sid, n: q.n, q: q.text, name: names[sid] || 'Anon', ans: fmt(q, v),
    ok: q.correct === null || q.correct === undefined ? null : v === q.correct, at: t || null,
    secs: t && qstart ? Math.max(0, Math.round((t - qstart) / 100) / 10) : null, live: !!live });
  for (const h of s.hist) for (const sid in h.ans) add(sid, h, h.ans[sid], h.times && h.times[sid], h.qstart, false);
  if (s.q && isOpen(s)) for (const [sid, u] of Object.entries(s.users)) if (u.a && u.a.n === s.q.n) add(sid, s.q, u.a.v, u.a.t, s.q.start, true);
  return rows.sort((a, b) => a.n - b.n || (a.at || 0) - (b.at || 0));
}

function totals(s) {
  const pts = {}, done = {}, right = {};
  for (const h of s.hist) {
    for (const sid in h.ans) { done[sid] = (done[sid] || 0) + 1; if (h.correct !== null && h.ans[sid] === h.correct) right[sid] = (right[sid] || 0) + 1; }
    for (const sid in h.pts) pts[sid] = (pts[sid] || 0) + h.pts[sid];
  }
  return { pts, done, right };
}

/* ------------------------------------------------------------------ view (what each role sees) */
function view(s, role, sid, full) {
  const q = s.q, T = role === 'teacher', open = isOpen(s), me = s.users[sid] || {};
  const users = Object.entries(s.users), on = users.filter(([, u]) => online(u));
  const pace = { fast: 0, ok: 0, slow: 0 }; on.forEach(([, u]) => { if (pace[u.pace] !== undefined) pace[u.pace]++; });
  const tot = totals(s), names = namesOf(s), M = s.meta;
  const entry = q ? s.hist.find(x => x.n === q.n) : null;
  const answers = entry ? entry.ans : currentAnswers(s);
  const v = {
    code: s.code, title: M.title, cls: M.cls, date: M.date, start: M.start, end: M.end, ended: !!M.ended,
    joined: on.length, total: users.length, confused: users.filter(([, u]) => isConf(s, u)).length, pace,
    reacts: s.rx, n: curN(s), name: me.name, mod: !!M.mod,
    q: q ? { text: q.text, type: q.type, options: q.options, open } : null,
    left: q && open && q.dur ? Math.max(0, q.start + q.dur * 1000 - now()) : null,
    board: Object.entries(tot.pts).map(([id, p]) => ({ name: names[id] || 'Anon', pts: p })).sort((a, b) => b.pts - a.pts).slice(0, 10),
    qa: s.qa.filter(x => T || x.ok || x.by === sid).map(x => ({ id: x.id, text: x.text, votes: x.votes.length, done: x.done, ok: x.ok, mine: x.votes.includes(sid), own: x.by === sid }))
      .sort((a, b) => a.done - b.done || b.votes - a.votes)
  };
  if (T) {
    const nq = s.hist.length + (open ? 1 : 0);
    v.res = tally(q, answers, names, true); v.answered = Object.keys(answers).length; v.correct = q ? q.correct : null;
    v.history = s.hist.map(h => ({ n: h.n, text: h.text, type: h.type, correct: h.correct, res: h.res, answered: h.answered, confused: h.confused, joined: h.joined }));
    v.queue = s.queue;
    const rows = answerRows(s), st = {};
    for (const r of rows) { const x = st[r.sid] || (st[r.sid] = { secs: 0, k: 0, lastAt: 0 }); if (r.secs !== null) { x.secs += r.secs; x.k++; } if (r.at > x.lastAt) x.lastAt = r.at; }
    if (full) v.log = rows.map(({ sid: _s, ...r }) => r);
    v.students = users.map(([id, u]) => ({
      joinedAt: u.joined || null, lastAt: (st[id] && st[id].lastAt) || null, secs: st[id] ? Math.round(st[id].secs * 10) / 10 : 0, avg: st[id] && st[id].k ? Math.round(st[id].secs / st[id].k * 10) / 10 : null,
      name: u.name, online: online(u), answered: id in answers && (open || !!entry), confused: isConf(s, u), pace: u.pace || null,
      pts: tot.pts[id] || 0, done: (tot.done[id] || 0) + (open && id in answers ? 1 : 0), of: nq, right: tot.right[id] || 0
    })).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
  } else {
    v.mine = sid in answers ? answers[sid] : null; v.confusedMe = isConf(s, me); v.paceMe = me.pace || null;
    if (q && !open) { v.res = entry ? tally(q, entry.ans, names, false) : []; v.correct = q.correct; }
    v.myPts = tot.pts[sid] || 0;
  }
  return v;
}

/* ------------------------------------------------------------------ teacher accounts / session list */
async function teacherLogin(b) {
  const name = clean(b.name, 30), pin = clean(b.pin, 40);
  if (!name) return { s: 400, e: 'Enter your name' };
  if (pin.length < 4) return { s: 400, e: 'PIN must be at least 4 characters' };
  const key = name.toLowerCase(), tkey = sha(key + '|' + pin + '|classpulse');
  if (!(await S.hsetnx('cp:names', key, tkey))) {
    if ((await S.hget('cp:names', key)) !== tkey) return { s: 401, e: 'Wrong PIN for this name' };
    return { tkey, name, created: false };
  }
  return { tkey, name, created: true };
}
const listSessions = async tkey => Object.values(await S.hgetall(KT(tkey))).map(parse).filter(Boolean).sort((a, b) => b.created - a.created);
async function newCode(tkey) {
  for (let i = 0; i < 80; i++) { const c = String(10000 + Math.floor(Math.random() * 90000)); if (await S.hsetnx('cp:codes', c, tkey)) return c; }
  throw new Error('no free room code');
}
const summary = m => ({ code: m.code, title: m.title, cls: m.cls, date: m.date, start: m.start, end: m.end, created: m.created, ended: !!m.ended });

/* ------------------------------------------------------------------ room-code brute-force guard
 * Room codes are the only thing students need, so wrong guesses are limited per IP (20 misses / minute).
 * In-memory: on serverless it is per instance, which still slows guessing down a lot. */
const misses = new Map();
const ipOf = req => String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '?').split(',')[0].trim();
const blocked = req => { const m = misses.get(ipOf(req)); return !!m && now() - m.t < 60000 && m.n >= 20; };
const miss = req => { const ip = ipOf(req), m = misses.get(ip); if (!m || now() - m.t >= 60000) misses.set(ip, { n: 1, t: now() }); else m.n++; if (misses.size > 5000) misses.clear(); };

/* ------------------------------------------------------------------ router */
async function handler(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname, Q = k => url.searchParams.get(k) || '';
  try {
    if (p === '/healthz' || p === '/api/health') {
      try { await S.ping(); return json(res, { ok: true, storage: S.kind }); }
      catch (e) { return json(res, { ok: false, storage: S.kind, error: 'database not reachable: ' + String(e.message).slice(0, 160) }, 503); }
    }
    if (p === '/api/info') {
      const urls = [];
      for (const l of Object.values(os.networkInterfaces())) for (const i of l) if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
      return json(res, { urls: urls.length ? urls : [`http://localhost:${PORT}`], storage: S.kind });
    }

    /* --- live state (polled by both teacher and students) --- */
    if (p === '/api/state' && req.method === 'GET') {
      const s = await load(Q('code'));
      if (!s) return fail(res, 404, 'no session');
      const role = Q('role') === 'teacher' ? 'teacher' : 'student', sid = clean(Q('sid'), 24);
      if (role === 'teacher' && Q('tkey') !== s.meta.owner) return fail(res, 403, 'not your session');
      if (role === 'student') {
        const u = s.users[sid];
        if (!u) return fail(res, 404, 'not joined');
        if (now() - (u.seen || 0) > BEAT_MS) await touch(s, sid);
      }
      await settle(s);
      return json(res, view(s, role, sid, Q('full') === '1'));
    }

    if (p === '/api/t/sessions' && req.method === 'GET') {
      const tkey = Q('tkey'); if (!tkey) return fail(res, 401, 'login first');
      return json(res, { sessions: await listSessions(tkey) });
    }

    if (!p.startsWith('/api/') || req.method !== 'POST') return serveStatic(p, res);
    const b = await readBody(req);

    if (p === '/api/t/login') { const r = await teacherLogin(b); return r.e ? fail(res, r.s, r.e) : json(res, r); }

    if (p === '/api/create') {
      const tkey = clean(b.tkey, 64), title = clean(b.title, 60);
      if (!tkey) return fail(res, 401, 'login first');
      const code = await newCode(tkey);
      const meta = { code, owner: tkey, title: title || 'Untitled session', cls: clean(b.cls, 40), date: clean(b.date, 10), start: clean(b.start, 5), end: clean(b.end, 5), created: now(), ended: false, mod: false };
      await S.hset(KS(code), 'meta', JSON.stringify(meta));
      await S.hset(KT(tkey), code, JSON.stringify(summary(meta)));
      return json(res, { code });
    }

    if (p === '/api/join' && blocked(req)) return fail(res, 429, 'Too many wrong room codes. Please wait a minute and try again.');
    const s = await load(clean(b.code, 6));
    if (!s) { if (p === '/api/join') miss(req); return fail(res, 404, 'no session'); }
    const K = KS(s.code), sid = clean(b.sid, 24), T = b.tkey === s.meta.owner;
    const teacherOnly = ['/api/question', '/api/close', '/api/clear-react', '/api/qa-done', '/api/qa-approve', '/api/qa-del', '/api/qa-mod', '/api/queue', '/api/t/status', '/api/t/delete', '/api/demo-join'];
    if (teacherOnly.includes(p) && !T) return fail(res, 403, 'not your session');
    const studentOnly = ['/api/answer', '/api/confused', '/api/pace', '/api/ask', '/api/vote'];
    if (studentOnly.includes(p) && !s.users[sid]) return fail(res, 404, 'not joined');
    if (studentOnly.includes(p) && s.meta.ended) return fail(res, 410, 'session ended');

    switch (p) {
      case '/api/join': {
        const name = clean(b.name, 20);
        if (!name) return fail(res, 400, 'Enter your name');
        if (!sid) return fail(res, 400, 'bad id');
        if (s.meta.ended) return fail(res, 410, 'This session has ended');
        const u = s.users[sid] || { joined: now() };
        u.name = name; s.users[sid] = u;
        await saveUser(s, sid); await touch(s, sid);
        return json(res, { ok: true, title: s.meta.title, cls: s.meta.cls });
      }
      case '/api/demo-join': {
        s.users[sid] = { name: clean(b.name, 20), fake: true, joined: now() };
        await saveUser(s, sid); await touch(s, sid); break;
      }
      case '/api/question': {
        await archive(s);
        const nq = { n: curN(s) + 1, text: clean(b.text, 300), type: clean(b.type, 10) || 'mcq', options: (Array.isArray(b.options) ? b.options : []).slice(0, 6).map(o => clean(o, 100)),
          correct: Number.isInteger(b.correct) ? b.correct : null, start: now(), dur: +b.dur > 0 ? +b.dur : 0 };
        await S.hset(K, 'q', JSON.stringify(nq)); break;
      }
      case '/api/answer': {
        const q = s.q, u = s.users[sid];
        if (q && u && isOpen(s)) {
          let v;
          if (q.type === 'cloud' || q.type === 'text') { const t = clean(b.text, q.type === 'text' ? 200 : 30); if (t) v = t; }
          else if (Number.isInteger(b.choice) && b.choice >= 0 && b.choice < q.options.length) v = b.choice;
          if (v !== undefined) { u.a = { n: q.n, v, t: now() }; u.seen = now(); await S.hset(K, 'a:' + sid, JSON.stringify(u.a)); }
        }
        break;
      }
      case '/api/confused': { const u = s.users[sid]; u.conf = b.on ? { n: curN(s) } : null; await saveUser(s, sid); break; }
      case '/api/pace': {
        const u = s.users[sid];
        if (['fast', 'ok', 'slow'].includes(b.value)) { u.pace = u.pace === b.value ? null : b.value; await saveUser(s, sid); }
        break;
      }
      case '/api/react': if (EMOJI.includes(b.emoji)) await S.hincr(K, 'rx:' + b.emoji, 1); break;
      case '/api/clear-react': for (const e of EMOJI) await S.hdel(K, 'rx:' + e); break;
      case '/api/close': await archive(s); break;
      case '/api/ask': {
        const t = clean(b.text, 200);
        if (t) { const id = now().toString(36) + Math.random().toString(36).slice(2, 6); await S.hset(K, 'qa:' + id, JSON.stringify({ id, text: t, votes: [sid], done: false, ok: !s.meta.mod, by: sid })); }
        break;
      }
      case '/api/vote': case '/api/qa-done': case '/api/qa-approve': {
        const x = s.qa.find(i => i.id === b.id); if (!x) break;
        if (p === '/api/vote') x.votes = x.votes.includes(sid) ? x.votes.filter(i => i !== sid) : x.votes.concat(sid);
        else if (p === '/api/qa-done') x.done = !x.done; else x.ok = true;
        await S.hset(K, 'qa:' + x.id, JSON.stringify(x)); break;
      }
      case '/api/qa-del': await S.hdel(K, 'qa:' + b.id); break;
      case '/api/qa-mod':
        s.meta.mod = !!b.on; await saveMeta(s);
        if (!s.meta.mod) for (const x of s.qa) if (!x.ok) { x.ok = true; await S.hset(K, 'qa:' + x.id, JSON.stringify(x)); }
        break;
      case '/api/queue': await S.hset(K, 'queue', JSON.stringify((Array.isArray(b.queue) ? b.queue : []).slice(0, 100))); break;
      case '/api/t/status':
        s.meta.ended = !!b.ended; if (s.meta.ended) await archive(s); await saveMeta(s);
        await S.hset(KT(s.meta.owner), s.code, JSON.stringify(summary(s.meta))); break;
      case '/api/t/delete':
        await S.del(K); await S.hdel(KT(s.meta.owner), s.code); await S.hdel('cp:codes', s.code); break;
      default: return fail(res, 404, 'unknown');
    }
    return json(res, { ok: true });
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'server error');
  }
}

function serveStatic(p, res) {
  const file = p === '/' ? 'index.html' : p === '/teacher' ? 'teacher.html' : p === '/student' ? 'student.html' : p.slice(1);
  const fp = path.join(PUB, path.normalize(file));
  if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain', 'Cache-Control': 'no-cache' });
    res.end(d);
  });
}

module.exports = handler;
if (require.main === module) {
  http.createServer(handler).listen(PORT, '0.0.0.0', () => {
    console.log(`\nClassPulse running on port ${PORT}  (storage: ${S.kind})\n  Teacher: http://localhost:${PORT}/teacher`);
    for (const l of Object.values(os.networkInterfaces())) for (const i of l) if (i.family === 'IPv4' && !i.internal) console.log(`  Students (same WiFi): http://${i.address}:${PORT}/student`);
  });
}
