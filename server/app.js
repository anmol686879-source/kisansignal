import express from 'express';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DAY = 864e5, SESSION_DAYS = 30, OTP_TTL = 5 * 60e3, MAX_TRIES = 5, RESEND_MS = 30e3, MAX_PER_HOUR = 5;
const sha = (s) => createHash('sha256').update(s).digest('hex');

function normPhone(cc, phone) {
  if (typeof cc !== 'string' || typeof phone !== 'string' || !/^\+\d{1,3}$/.test(cc)) return null;
  const d = phone.replace(/\D/g, '');
  const ok = cc === '+91' ? /^[6-9]\d{9}$/.test(d) : /^\d{6,12}$/.test(d);
  return ok ? cc + d : null;
}
const mask = (p) => p.slice(0, -3).replace(/\d/g, '•') + p.slice(-3);

function cleanField(f) {
  if (!f || typeof f !== 'object') return null;
  const a = Number(f.a), c = Number(f.c);
  if (typeof f.id !== 'string' || !/^[\w-]{1,40}$/.test(f.id)) return null;
  if (typeof f.n !== 'string' || !f.n.trim()) return null;
  if (!(a > 0 && a <= 1e5) || !Number.isInteger(c) || c < 0 || c > 40) return null;
  if (f.u !== 'ha' && f.u !== 'ac') return null;
  if (typeof f.sd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(f.sd)) return null;
  const done = {};
  if (f.done && typeof f.done === 'object')
    for (const [k, v] of Object.entries(f.done).slice(0, 200)) if (/^\d{1,3}$/.test(k)) done[k] = !!v;
  return { id: f.id, n: f.n.trim().slice(0, 30), c, a, u: f.u, sd: f.sd, done };
}

export function createApp({ db, sms, env = process.env }) {
  const app = express();
  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const prod = env.NODE_ENV === 'production';
  const secret = env.OTP_SECRET || (prod ? null : 'dev-secret');
  if (!secret) throw new Error('OTP_SECRET is required in production (use a long random string).');
  if (env.TRUST_PROXY) app.set('trust proxy', env.TRUST_PROXY === 'true' ? 1 : env.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' https://power.larc.nasa.gov https://api.open-meteo.com",
    });
    if (prod) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  app.get('/healthz', asyncRoute(async (_q, r) => { await db.ping(); r.type('text').send('ok'); }));
  app.use(express.json({ limit: '32kb' }));

  // Per-IP rate limit (in memory; use a shared store if you run several instances).
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.t < n) hits.delete(k); }, 6e4).unref();
  const limit = (max, windowMs, tag) => (req, res, next) => {
    const k = tag + req.ip, n = Date.now(); let h = hits.get(k);
    if (!h || h.t < n) h = { c: 0, t: n + windowMs };
    hits.set(k, h);
    if (++h.c > max) return res.status(429).json({ api: true, error: 'rate' });
    next();
  };

  // CSRF defence: JSON bodies only, and a browser Origin header must match this host.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') {
      if (!(req.get('content-type') || '').startsWith('application/json')) return res.status(415).json({ api: true, error: 'json' });
      const o = req.get('origin');
      if (o) { try { if (new URL(o).host !== req.get('host')) return res.status(403).json({ api: true, error: 'origin' }); } catch { return res.status(403).json({ api: true, error: 'origin' }); } }
    }
    next();
  });

  const q = {
    otpGet: db.prepare('SELECT * FROM otps WHERE phone=?'),
    otpPut: db.prepare('INSERT INTO otps (phone, hash, expires, tries, last_sent, hour_start, hour_count) VALUES (?,?,?,?,?,?,?) ON CONFLICT(phone) DO UPDATE SET hash=excluded.hash, expires=excluded.expires, tries=excluded.tries, last_sent=excluded.last_sent, hour_start=excluded.hour_start, hour_count=excluded.hour_count'),
    otpDel: db.prepare('DELETE FROM otps WHERE phone=?'),
    otpConsume: db.prepare('DELETE FROM otps WHERE phone=? AND hash=?'),
    otpTry: db.prepare('UPDATE otps SET tries=tries-1 WHERE phone=? AND tries>0 RETURNING tries'),
    userByPhone: db.prepare('SELECT * FROM users WHERE phone=?'),
    userAdd: db.prepare('INSERT INTO users (phone, created) VALUES (?,?)'),
    userSet: db.prepare('UPDATE users SET name=?, region=?, crop=?, lang=? WHERE id=?'),
    sessAdd: db.prepare('INSERT INTO sessions VALUES (?,?,?)'),
    sessGet: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?'),
    sessDel: db.prepare('DELETE FROM sessions WHERE hash=?'),
    sessClean: db.prepare('DELETE FROM sessions WHERE expires<?'),
    fieldsGet: db.prepare('SELECT json FROM fields WHERE user_id=?'),
    fieldsPut: db.prepare('INSERT INTO fields (user_id, json, updated) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json, updated=excluded.updated'),
  };
  const otpSending = new Set();
  setInterval(() => Promise.resolve(q.sessClean.run(Date.now())).catch((e) => console.error('Session cleanup failed:', e)), 36e5).unref();

  const cookieOf = (req) => (req.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === 'ks_sid')?.[1];
  const auth = asyncRoute(async (req, _res, next) => { const t = cookieOf(req); req.user = t ? await q.sessGet.get(sha(t), Date.now()) : null; req.token = t; next(); });
  const need = (req, res, next) => (req.user ? next() : res.status(401).json({ api: true, error: 'auth' }));
  const pub = (u) => ({ id: u.id, phone: u.phone, name: u.name, region: u.region, crop: u.crop, lang: u.lang });
  const fieldsOf = async (u) => { const r = await q.fieldsGet.get(u.id); try { return r ? JSON.parse(r.json) : []; } catch { return []; } };

  app.post('/api/otp/send', limit(20, 6e4, 'send'), asyncRoute(async (req, res) => {
    const phone = normPhone(req.body?.cc, req.body?.phone);
    if (!phone) return res.status(400).json({ api: true, error: 'phone' });
    if (otpSending.has(phone)) return res.status(429).json({ api: true, error: 'wait', retryIn: RESEND_MS / 1000 });
    otpSending.add(phone);
    try {
      const now = Date.now(), prev = await q.otpGet.get(phone);
      let hourStart = now, hourCount = 0;
      if (prev) {
        if (now - prev.last_sent < RESEND_MS) return res.status(429).json({ api: true, error: 'wait', retryIn: Math.ceil((RESEND_MS - (now - prev.last_sent)) / 1000) });
        if (now - prev.hour_start < 36e5) { hourStart = prev.hour_start; hourCount = prev.hour_count; }
        if (hourCount >= MAX_PER_HOUR) return res.status(429).json({ api: true, error: 'hourly' });
      }
      const code = String(randomInt(0, 1e6)).padStart(6, '0');
      await q.otpPut.run(phone, sha(secret + phone + code), now + OTP_TTL, MAX_TRIES, now, hourStart, hourCount + 1);
      try { await sms.send(phone, `Your KisanSignal code is ${code}. It expires in 5 minutes. Do not share it.`); }
      catch (e) { console.error('SMS failed:', e.message); await q.otpDel.run(phone); return res.status(502).json({ api: true, error: 'sms' }); }
      res.json({ api: true, ok: true, masked: mask(phone), ...(sms.dev ? { devCode: code } : {}) });
    } finally {
      otpSending.delete(phone);
    }
  }));

  app.post('/api/otp/verify', limit(40, 6e4, 'verify'), asyncRoute(async (req, res) => {
    const phone = normPhone(req.body?.cc, req.body?.phone), code = String(req.body?.code ?? '');
    if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ api: true, error: 'input' });
    const o = await q.otpGet.get(phone);
    if (!o || o.expires < Date.now()) return res.status(400).json({ api: true, error: 'expired' });
    if (o.tries <= 0) return res.status(429).json({ api: true, error: 'locked' });
    const a = Buffer.from(sha(secret + phone + code)), b = Buffer.from(o.hash);
    if (!timingSafeEqual(a, b)) {
      const attempt = await q.otpTry.get(phone);
      const left = attempt?.tries ?? 0;
      return res.status(left > 0 ? 400 : 429).json({ api: true, error: left > 0 ? 'bad' : 'locked', triesLeft: left });
    }
    const consumed = await q.otpConsume.run(phone, o.hash);
    if (consumed.changes !== 1) return res.status(400).json({ api: true, error: 'expired' });
    let u = await q.userByPhone.get(phone);
    if (!u) { await q.userAdd.run(phone, Date.now()); u = await q.userByPhone.get(phone); }
    const token = randomBytes(32).toString('base64url');
    await q.sessAdd.run(sha(token), u.id, Date.now() + SESSION_DAYS * DAY);
    res.append('Set-Cookie', `ks_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${prod ? '; Secure' : ''}`);
    res.json({ api: true, user: pub(u), fields: await fieldsOf(u), isNew: !u.name });
  }));

  app.get('/api/me', auth, asyncRoute(async (req, res) => {
    if (!req.user) return res.status(401).json({ api: true, error: 'auth' });
    res.json({ api: true, user: pub(req.user), fields: await fieldsOf(req.user) });
  }));

  app.post('/api/profile', auth, need, asyncRoute(async (req, res) => {
    const name = String(req.body?.name ?? '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ api: true, error: 'name' });
    const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
    await q.userSet.run(name, s(req.body.region, 20), s(req.body.crop, 20), s(req.body.lang, 8), req.user.id);
    res.json({ api: true, user: pub(await q.userByPhone.get(req.user.phone)) });
  }));

  app.put('/api/fields', auth, need, asyncRoute(async (req, res) => {
    const list = req.body?.fields;
    if (!Array.isArray(list) || list.length > 8) return res.status(400).json({ api: true, error: 'fields' });
    const clean = list.map(cleanField);
    if (clean.some((f) => !f)) return res.status(400).json({ api: true, error: 'fields' });
    await q.fieldsPut.run(req.user.id, JSON.stringify(clean), Date.now());
    res.json({ api: true, fields: clean });
  }));

  app.post('/api/logout', auth, asyncRoute(async (req, res) => {
    if (req.token) await q.sessDel.run(sha(req.token));
    res.append('Set-Cookie', `ks_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${prod ? '; Secure' : ''}`);
    res.json({ api: true, ok: true });
  }));

  // Account deletion (removes the user, sessions and fields).
  app.delete('/api/me', auth, need, asyncRoute(async (req, res) => {
    await db.prepare('DELETE FROM users WHERE id=?').run(req.user.id);
    res.append('Set-Cookie', `ks_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${prod ? '; Secure' : ''}`);
    res.json({ api: true, ok: true });
  }));

  app.use('/api', (_q, r) => r.status(404).json({ api: true, error: 'notfound' }));
  app.use(express.static(PUBLIC, { index: 'index.html', setHeaders: (r, p) => { if (p.endsWith('.html')) r.setHeader('Cache-Control', 'no-cache'); } }));
  app.use((err, _req, res, _next) => { console.error(err); res.status(err.status || 500).json({ api: true, error: 'server' }); });
  return app;
}
