import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';

let srv, base, cookie = '';
const sms = { dev: true, async send() {} };
before(async () => {
  const app = createApp({ db: openDb(':memory:'), sms, env: { NODE_ENV: 'test' } });
  srv = app.listen(0); base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => srv.close());

async function call(method, path, body, extra = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { s: r.status, j: await r.json().catch(() => ({})) };
}
const ph = { cc: '+91', phone: '9876543210' };
const field = { id: 'abc1', n: 'North plot', c: 0, a: 2.5, u: 'ha', sd: '2026-11-01', done: { 0: true } };

test('rejects bad phone numbers', async () => {
  assert.equal((await call('POST', '/api/otp/send', { cc: '+91', phone: '1234567890' })).s, 400);
});
test('health check verifies the database is reachable', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});
test('requires auth for protected routes', async () => {
  assert.equal((await call('GET', '/api/me')).s, 401);
  assert.equal((await call('PUT', '/api/fields', { fields: [] })).s, 401);
});
test('blocks cross-origin and non-JSON writes', async () => {
  assert.equal((await call('POST', '/api/otp/send', ph, { Origin: 'https://evil.example' })).s, 403);
  const r = await fetch(base + '/api/otp/send', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
});
test('wrong code decrements tries, then locks', async () => {
  const { j } = await call('POST', '/api/otp/send', ph);
  assert.match(j.devCode, /^\d{6}$/);
  const wrong = j.devCode === '000000' ? '111111' : '000000';
  let last;
  for (let i = 0; i < 5; i++) last = await call('POST', '/api/otp/verify', { ...ph, code: wrong });
  assert.equal(last.s, 429); assert.equal(last.j.error, 'locked');
  assert.equal((await call('POST', '/api/otp/verify', { ...ph, code: j.devCode })).s, 429);
});
test('an OTP can only be used once', async () => {
  const p = { cc: '+91', phone: '9987654321' };
  const { j } = await call('POST', '/api/otp/send', p);
  const results = await Promise.all([
    call('POST', '/api/otp/verify', { ...p, code: j.devCode }),
    call('POST', '/api/otp/verify', { ...p, code: j.devCode }),
  ]);
  assert.deepEqual(results.map((r) => r.s).sort(), [200, 400]);
});
test('concurrent wrong codes cannot exceed the attempt limit', async () => {
  const p = { cc: '+91', phone: '9876543211' };
  const { j } = await call('POST', '/api/otp/send', p);
  const wrong = j.devCode === '000000' ? '111111' : '000000';
  const results = await Promise.all(Array.from({ length: 7 }, () =>
    call('POST', '/api/otp/verify', { ...p, code: wrong }),
  ));
  assert.equal(results.filter((r) => r.s === 400).length, 4);
  assert.equal(results.filter((r) => r.s === 429).length, 3);
});
test('resend is throttled', async () => {
  const r = await call('POST', '/api/otp/send', ph);
  assert.equal(r.s, 429); assert.equal(r.j.error, 'wait');
});
test('full login, profile, fields, logout, re-login', async () => {
  const p2 = { cc: '+91', phone: '9123456780' };
  let { j } = await call('POST', '/api/otp/send', p2);
  let v = await call('POST', '/api/otp/verify', { ...p2, code: j.devCode });
  assert.equal(v.s, 200); assert.equal(v.j.isNew, true);
  assert.ok(cookie.startsWith('ks_sid='));
  assert.equal((await call('POST', '/api/profile', { name: '  ' })).s, 400);
  const pr = await call('POST', '/api/profile', { name: 'Ravi', region: '25', crop: '0', lang: 'hi' });
  assert.equal(pr.j.user.name, 'Ravi');
  assert.equal((await call('PUT', '/api/fields', { fields: [{ ...field, a: -1 }] })).s, 400);
  assert.equal((await call('PUT', '/api/fields', { fields: Array(9).fill(field) })).s, 400);
  assert.equal((await call('PUT', '/api/fields', { fields: [{ ...field, evil: '<script>' }] })).s, 200);
  let me = await call('GET', '/api/me');
  assert.equal(me.j.fields.length, 1); assert.equal(me.j.fields[0].evil, undefined); assert.equal(me.j.fields[0].done['0'], true);
  await call('POST', '/api/logout', {}); cookie = '';
  assert.equal((await call('GET', '/api/me')).s, 401);
  // existing user logs in again (after resend window the code can be requested again by clearing rate via new phone-less path)
  await new Promise((r) => setTimeout(r, 30100));
  ({ j } = await call('POST', '/api/otp/send', p2));
  v = await call('POST', '/api/otp/verify', { ...p2, code: j.devCode });
  assert.equal(v.j.isNew, false); assert.equal(v.j.user.name, 'Ravi'); assert.equal(v.j.fields.length, 1);
  assert.equal((await call('DELETE', '/api/me')).s, 200);
  assert.equal((await call('GET', '/api/me')).s, 401);
});
