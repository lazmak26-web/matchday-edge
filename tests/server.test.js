'use strict';
// Integration tests for the HTTP server: auth, license activation, the Pro gate, rate limiting and lockout.
// Each test server runs as a child process on a free port with a temp data folder and NO external API keys,
// so nothing here touches football-data, Bzzoiro, KeyAuth or the mail provider.
// Rate limiters are keyed by req.ip; the server uses `trust proxy 1`, so a unique X-Forwarded-For per test keeps them independent.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const net = require('node:net'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');

const freePort = () => new Promise((ok, no) => {
  const s = net.createServer();
  s.on('error', no);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
});

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mde-test-'));
  const env = { PATH: process.env.PATH, PORT: String(port), HISTORY_FILE: path.join(dir, 'history.json'), ...extraEnv };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error('server did not start in time:\n' + out)), 15000);
    const poll = setInterval(() => { if (/Server on/.test(out)) { clearTimeout(timer); clearInterval(poll); ok(); } }, 50);
    child.on('exit', code => { clearTimeout(timer); clearInterval(poll); no(new Error('server exited early (' + code + '):\n' + out)); });
  });
  const stop = () => new Promise(done => {
    if (child.exitCode !== null) return done();
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(kill); fs.rmSync(dir, { recursive: true, force: true }); done(); });
    child.kill('SIGTERM');
  });
  return { base: 'http://127.0.0.1:' + port, stop };
}

async function call(base, method, url, { body, token, ip, headers } = {}) {
  const r = await fetch(base + url, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}, ip ? { 'x-forwarded-for': ip } : {}, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
}

const ADMIN = 'test-admin-token-1234567890';
const signup = (email, over) => Object.assign({ email, password: 'correct-horse-battery', consent: true, ageConfirmed: true }, over);

let A, B, C; // C: admin dashboard enabled without OTP (dev/test only). A: normal server (OTP off, admin enabled). B: REQUIRE_OTP=1 without a mail key, no admin token.
before(async () => {
  A = await startServer({ ADMIN_TOKEN: ADMIN });
  B = await startServer({ REQUIRE_OTP: '1' });
  C = await startServer({ ADMIN_ALLOW_NO_OTP: '1' });
});
after(async () => { await Promise.all([A && A.stop(), B && B.stop(), C && C.stop()]); });

test('security headers are set and x-powered-by is hidden', async () => {
  const r = await call(A.base, 'GET', '/api/public/fixtures', { ip: '10.0.1.1' });
  assert.strictEqual(r.status, 200);
  assert.ok(/default-src 'self'/.test(r.headers.get('content-security-policy') || ''));
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(r.headers.get('x-powered-by'), null);
});

test('only GET/HEAD/POST/OPTIONS are allowed', async () => {
  const r = await call(A.base, 'PUT', '/api/auth/login', { ip: '10.0.1.2', body: {} });
  assert.strictEqual(r.status, 405);
});

test('protected routes need a token', async () => {
  for (const url of ['/api/fixtures', '/api/engine/predictions', '/api/auth/verify']) {
    const r = await call(A.base, 'GET', url, { ip: '10.0.1.3' });
    assert.strictEqual(r.status, 401, url);
  }
});

test('public fixtures never leak odds, forms, xG or predictions', async () => {
  const r = await call(A.base, 'GET', '/api/public/fixtures', { ip: '10.0.1.4' });
  assert.ok(Array.isArray(r.json.fixtures));
  for (const f of r.json.fixtures) for (const k of ['odds', 'xgSource', 'h2h', 'prediction']) assert.ok(!(k in f));
});

test('register validates consent, email and password', async () => {
  const ip = '10.0.2.1';
  assert.strictEqual((await call(A.base, 'POST', '/api/auth/register', { ip, body: signup('a1@example.com', { consent: false }) })).status, 400);
  assert.strictEqual((await call(A.base, 'POST', '/api/auth/register', { ip, body: signup('a1@example.com', { ageConfirmed: false }) })).status, 400);
  assert.strictEqual((await call(A.base, 'POST', '/api/auth/register', { ip, body: signup('not-an-email') })).status, 400);
  assert.strictEqual((await call(A.base, 'POST', '/api/auth/register', { ip, body: signup('a2@example.com', { password: 'short' }) })).status, 400);
});

test('register -> duplicate -> login -> verify -> logout', async () => {
  const ip = '10.0.3.1', email = 'flow@example.com';
  const reg = await call(A.base, 'POST', '/api/auth/register', { ip, body: signup(email) });
  assert.strictEqual(reg.status, 200);
  assert.ok(reg.json.token && reg.json.token.length >= 32);
  assert.strictEqual(reg.json.profile.plan, 'free');

  const dup = await call(A.base, 'POST', '/api/auth/register', { ip, body: signup(email) });
  assert.strictEqual(dup.status, 409);

  const bad = await call(A.base, 'POST', '/api/auth/login', { ip, body: { username: email, password: 'wrong-password-123' } });
  assert.strictEqual(bad.status, 401);

  const login = await call(A.base, 'POST', '/api/auth/login', { ip, body: { username: email, password: 'correct-horse-battery' } });
  assert.strictEqual(login.status, 200);
  const token = login.json.token;

  const ver = await call(A.base, 'GET', '/api/auth/verify', { token, ip });
  assert.strictEqual(ver.status, 200);
  assert.strictEqual(ver.json.username, email);

  assert.strictEqual((await call(A.base, 'POST', '/api/auth/logout', { token, ip })).status, 200);
  assert.strictEqual((await call(A.base, 'GET', '/api/auth/verify', { token, ip })).status, 401);
});

test('free accounts are blocked from Pro data', async () => {
  const ip = '10.0.4.1';
  const reg = await call(A.base, 'POST', '/api/auth/register', { ip, body: signup('free@example.com') });
  const r = await call(A.base, 'GET', '/api/fixtures', { token: reg.json.token, ip });
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await call(A.base, 'GET', '/api/engine/predictions', { token: reg.json.token, ip })).status, 403);
});

test('admin endpoints reject a wrong token', async () => {
  const r = await call(A.base, 'POST', '/api/admin/license', { ip: '10.0.5.1', headers: { 'x-admin-token': 'wrong' }, body: { days: 30 } });
  assert.strictEqual(r.status, 403);
  const r2 = await call(A.base, 'POST', '/api/admin/license', { ip: '10.0.5.2', body: { days: 30 } });
  assert.strictEqual(r2.status, 403);
});

test('admin license -> activate -> Pro; a key works once', async () => {
  const gen = await call(A.base, 'POST', '/api/admin/license', { ip: '10.0.6.1', headers: { 'x-admin-token': ADMIN }, body: { days: 30, count: 1, note: 'test' } });
  assert.strictEqual(gen.status, 200);
  const key = gen.json.keys[0];
  assert.ok(/^LB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key));

  const u1 = await call(A.base, 'POST', '/api/auth/register', { ip: '10.0.6.2', body: signup('buyer1@example.com') });
  const act = await call(A.base, 'POST', '/api/license/activate', { ip: '10.0.6.2', token: u1.json.token, body: { key } });
  assert.strictEqual(act.status, 200);
  assert.strictEqual(act.json.profile.plan, 'pro');
  assert.ok(act.json.profile.planUntil > Date.now());

  const pro = await call(A.base, 'GET', '/api/fixtures', { token: u1.json.token, ip: '10.0.6.2' });
  assert.strictEqual(pro.status, 200);
  assert.ok(Array.isArray(pro.json.fixtures));

  const u2 = await call(A.base, 'POST', '/api/auth/register', { ip: '10.0.6.3', body: signup('buyer2@example.com') });
  const reuse = await call(A.base, 'POST', '/api/license/activate', { ip: '10.0.6.3', token: u2.json.token, body: { key } });
  assert.strictEqual(reuse.status, 400);
  assert.strictEqual((await call(A.base, 'GET', '/api/fixtures', { token: u2.json.token, ip: '10.0.6.3' })).status, 403);
});

test('license activation needs a login and a plausible key', async () => {
  assert.strictEqual((await call(A.base, 'POST', '/api/license/activate', { ip: '10.0.7.1', body: { key: 'LB-AAAA-BBBB-CCCC-DDDD' } })).status, 401);
  const u = await call(A.base, 'POST', '/api/auth/register', { ip: '10.0.7.2', body: signup('badkey@example.com') });
  assert.strictEqual((await call(A.base, 'POST', '/api/license/activate', { ip: '10.0.7.2', token: u.json.token, body: { key: 'x' } })).status, 400);
});

test('per-IP login rate limit returns 429 with Retry-After', async () => {
  const ip = '10.0.8.1';
  let last;
  for (let i = 0; i < 12; i++) {
    last = await call(A.base, 'POST', '/api/auth/login', { ip, body: { username: 'nobody' + i + '@example.com', password: 'whatever-password' } });
    if (last.status === 429) break;
  }
  assert.strictEqual(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('per-account lockout after 8 failed logins, even from rotating IPs', async () => {
  const email = 'lock@example.com';
  const reg = await call(A.base, 'POST', '/api/auth/register', { ip: '10.0.9.100', body: signup(email) });
  assert.strictEqual(reg.status, 200);
  for (let i = 1; i <= 8; i++) {
    const r = await call(A.base, 'POST', '/api/auth/login', { ip: '10.0.9.' + i, body: { username: email, password: 'wrong-password-' + i } });
    assert.strictEqual(r.status, 401);
  }
  const locked = await call(A.base, 'POST', '/api/auth/login', { ip: '10.0.9.50', body: { username: email, password: 'correct-horse-battery' } });
  assert.strictEqual(locked.status, 429);
});

test('oversized JSON bodies are rejected cleanly', async () => {
  const r = await call(A.base, 'POST', '/api/auth/login', { ip: '10.0.10.1', body: { username: 'a@example.com', password: 'x'.repeat(20000) } });
  assert.strictEqual(r.status, 413);
});

test('cross-origin writes are refused', async () => {
  const r = await call(A.base, 'POST', '/api/auth/login', { ip: '10.0.11.1', headers: { origin: 'https://evil.example' }, body: { username: 'a@example.com', password: 'whatever-password' } });
  assert.strictEqual(r.status, 403);
});

test('REQUIRE_OTP=1 without a mail key refuses email sign-up and login (fail closed)', async () => {
  const reg = await call(B.base, 'POST', '/api/auth/register', { ip: '10.1.0.1', body: signup('closed@example.com') });
  assert.strictEqual(reg.status, 503);
  const login = await call(B.base, 'POST', '/api/auth/login', { ip: '10.1.0.2', body: { username: 'closed@example.com', password: 'correct-horse-battery' } });
  assert.strictEqual(login.status, 503);
});

test('admin endpoints are hidden (404) when ADMIN_TOKEN is not configured', async () => {
  const r = await call(B.base, 'POST', '/api/admin/license', { ip: '10.1.0.3', headers: { 'x-admin-token': 'anything' }, body: {} });
  assert.strictEqual(r.status, 404);
});

const ADMIN_MAIL = 'marocheat2@gmail.com';

test('admin dashboard: only the admin email can list users (with plans), nobody else', async () => {
  // not logged in
  assert.strictEqual((await call(C.base, 'GET', '/api/admin/users', { ip: '10.2.0.1' })).status, 401);
  // normal user: 404, and profile says isAdmin=false
  const u = await call(C.base, 'POST', '/api/auth/register', { ip: '10.2.0.2', body: signup('normal@example.com') });
  assert.strictEqual(u.json.profile.isAdmin, false);
  assert.strictEqual((await call(C.base, 'GET', '/api/admin/users', { ip: '10.2.0.2', token: u.json.token })).status, 404);
  // admin email
  const a = await call(C.base, 'POST', '/api/auth/register', { ip: '10.2.0.3', body: signup(ADMIN_MAIL) });
  assert.strictEqual(a.json.profile.isAdmin, true);
  const r = await call(C.base, 'GET', '/api/admin/users', { ip: '10.2.0.3', token: a.json.token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.total, 2);
  assert.strictEqual(r.json.free, 2);
  const row = r.json.users.find(x => x.email === 'normal@example.com');
  assert.strictEqual(row.plan, 'free');
  assert.ok(!JSON.stringify(r.json).match(/salt|hash|password/i), 'no secrets in the response');
  // grant Pro via the owner endpoint -> dashboard shows pro
  assert.strictEqual((await call(C.base, 'POST', '/api/admin/plan', { ip: '10.2.0.4', headers: { 'x-admin-token': 'x' }, body: {} })).status, 404); // no ADMIN_TOKEN on C
});

test('admin dashboard is refused when OTP is off (anyone could have registered the admin email)', async () => {
  const a = await call(A.base, 'POST', '/api/auth/register', { ip: '10.2.1.1', body: signup(ADMIN_MAIL) });
  assert.strictEqual(a.json.profile.isAdmin, false);
  assert.strictEqual((await call(A.base, 'GET', '/api/admin/users', { ip: '10.2.1.1', token: a.json.token })).status, 404);
});
