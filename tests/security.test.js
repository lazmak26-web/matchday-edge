'use strict';
// Regression tests for the fixes in SECURITY_AUDIT_REPORT.md. Each server runs as a child process (temp data folder, no external keys).
// Server D has email OTP switched ON against a local fake mail server (MAIL_API_URL is only honoured when NODE_ENV=test).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http'), net = require('node:net'), os = require('node:os'), fs = require('node:fs'), path = require('node:path');

const freePort = () => new Promise((ok, no) => {
  const s = net.createServer();
  s.on('error', no);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); });
});

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mde-sec-'));
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), HISTORY_FILE: path.join(dir, 'history.json'), ...extraEnv };
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
  return { base: 'http://127.0.0.1:' + port, stop, dir, log: () => out };
}

async function call(base, method, url, { body, token, ip, headers, raw } = {}) {
  const r = await fetch(base + url, {
    method,
    headers: Object.assign(raw ? {} : { 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}, ip ? { 'x-forwarded-for': ip } : {}, headers || {}),
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: r.status, headers: r.headers, json, text };
}

const ADMIN_MAIL = 'marocheat2@gmail.com';
const PW = 'correct-horse-battery';
const signup = (email, password = PW) => ({ email, password, consent: true, ageConfirmed: true });

// fake mail provider: remembers the last code sent to each address
const mails = new Map();
let mailServer, mailUrl;
async function startMail() {
  const port = await freePort();
  mailServer = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => {
      try { const m = JSON.parse(b), code = /code is (\d{6})/.exec(m.text); if (code) mails.set(m.to[0], code[1]); } catch (e) { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"x"}');
    });
  });
  await new Promise(ok => mailServer.listen(port, '127.0.0.1', ok));
  mailUrl = `http://127.0.0.1:${port}/emails`;
}

let C, D;
before(async () => {
  await startMail();
  C = await startServer({ ADMIN_ALLOW_NO_OTP: '1' });                    // OTP off, admin allowed (test-only switch)
  D = await startServer({ RESEND_API_KEY: 'test-key', MAIL_API_URL: mailUrl });   // OTP on
});
after(async () => { await Promise.all([C && C.stop(), D && D.stop()]); await new Promise(ok => mailServer.close(ok)); });

async function adminToken(S, ip) {
  let r = await call(S.base, 'POST', '/api/auth/register', { ip, body: signup(ADMIN_MAIL) });
  if (r.status === 409) r = await call(S.base, 'POST', '/api/auth/login', { ip, body: { username: ADMIN_MAIL, password: PW } });
  assert.ok(r.json && r.json.token, 'admin login: ' + r.text);
  return r.json.token;
}

/* ---------- CSP / third-party scripts ---------- */
test('CSP trusts no third-party script host and the pinned libraries are self-hosted', async () => {
  const r = await call(C.base, 'GET', '/', { ip: '10.9.0.1' });
  const csp = r.headers.get('content-security-policy') || '';
  const scriptSrc = (csp.split(';').find(d => d.trim().startsWith('script-src')) || '').trim();
  assert.strictEqual(scriptSrc, "script-src 'self' 'unsafe-inline'");
  assert.ok(!/cdn\.jsdelivr\.net\/npm\/chart\.js['"]/.test(r.text), 'index.html no longer loads an unpinned Chart.js from a CDN');
  for (const f of ['/vendor/chart.umd.min.js', '/vendor/cobe.esm.js', '/vendor/lenis.min.js']) {
    const v = await call(C.base, 'GET', f, { ip: '10.9.0.1' });
    assert.strictEqual(v.status, 200, f);
    assert.ok(/javascript/.test(v.headers.get('content-type') || ''), f);
  }
  const globe = await call(C.base, 'GET', '/live-globe.js', { ip: '10.9.0.1' });
  assert.ok(!/https?:\/\//.test(globe.text.match(/var CDN = \{[\s\S]*?\};/)[0]), 'globe libraries come from our origin');
});

/* ---------- uploads ---------- */
const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f9e1f00000000049454e44ae426082', 'hex');
function form(buf, type, name) { const fd = new FormData(); fd.append('image', new Blob([buf], { type }), name); return fd; }

test('upload: a file whose bytes are not the image type it claims is rejected and deleted', async () => {
  const tok = await adminToken(C, '10.9.1.1');
  const fake = await call(C.base, 'POST', '/api/upload', { ip: '10.9.1.1', token: tok, raw: form(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 'x.png') });
  assert.strictEqual(fake.status, 400);
  assert.match(fake.json.error, /not a valid/);
  const left = fs.readdirSync(path.join(C.dir, 'uploads'));
  assert.deepStrictEqual(left, [], 'the rejected file was removed from disk');
  const gifAsJpeg = await call(C.base, 'POST', '/api/upload', { ip: '10.9.1.1', token: tok, raw: form(Buffer.from('GIF89a........'), 'image/jpeg', 'x.jpg') });
  assert.strictEqual(gifAsJpeg.status, 400, 'signature must match the declared type');
});

test('upload: a real image is accepted, served sandboxed, and the action is audit-logged', async () => {
  const tok = await adminToken(C, '10.9.1.2');
  const ok = await call(C.base, 'POST', '/api/upload', { ip: '10.9.1.2', token: tok, raw: form(PNG_1x1, 'image/png', 'a.png') });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.match(ok.json.url, /^\/uploads\/[a-f0-9]{16}\.png$/);
  const img = await fetch(C.base + ok.json.url);
  assert.strictEqual(img.status, 200);
  assert.match(img.headers.get('content-security-policy') || '', /sandbox/);
  assert.strictEqual(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(C.log(), /AUDIT \{[^\n]*"action":"upload"/);
});

test('upload stays admin-only', async () => {
  const u = await call(C.base, 'POST', '/api/auth/register', { ip: '10.9.1.3', body: signup('uploader@example.com') });
  const r = await call(C.base, 'POST', '/api/upload', { ip: '10.9.1.3', token: u.json.token, raw: form(PNG_1x1, 'image/png', 'a.png') });
  assert.strictEqual(r.status, 404);
});

/* ---------- Discover comments ---------- */
test('discover: one account cannot fill a post\'s whole comment allowance', async () => {
  const adm = await adminToken(C, '10.9.2.1');
  const post = await call(C.base, 'POST', '/api/discover', { ip: '10.9.2.1', token: adm, body: { text: 'hello' } });
  assert.strictEqual(post.status, 200, post.text);
  const id = post.json.post.id;
  const u = await call(C.base, 'POST', '/api/auth/register', { ip: '10.9.2.2', body: signup('spammer@example.com') });
  for (let i = 0; i < 10; i++) {
    const r = await call(C.base, 'POST', `/api/discover/${id}/comment`, { ip: '10.9.2.' + (10 + i), token: u.json.token, body: { text: 'c' + i } });
    assert.strictEqual(r.status, 200, 'comment ' + i);
  }
  const over = await call(C.base, 'POST', `/api/discover/${id}/comment`, { ip: '10.9.2.30', token: u.json.token, body: { text: 'one more' } });
  assert.strictEqual(over.status, 429);
  // another account can still comment
  const v = await call(C.base, 'POST', '/api/auth/register', { ip: '10.9.2.31', body: signup('other@example.com') });
  assert.strictEqual((await call(C.base, 'POST', `/api/discover/${id}/comment`, { ip: '10.9.2.31', token: v.json.token, body: { text: 'hi' } })).status, 200);
  // the feed exposes counts and the viewer's own vote, never voter identities
  await call(C.base, 'POST', `/api/discover/${id}/like`, { ip: '10.9.2.31', token: v.json.token });
  const feed = await call(C.base, 'GET', '/api/discover', { ip: '10.9.2.31', token: v.json.token });
  const p = feed.json.posts.find(x => x.id === id);
  assert.strictEqual(p.likes, 1); assert.strictEqual(p.isLiked, true);
  assert.ok(!feed.text.includes('other@example.com') && !feed.text.includes('spammer@example.com'));
  assert.match(C.log(), /AUDIT \{[^\n]*"action":"discover_post"/);
});

/* ---------- OTP sign-up ---------- */
test('OTP on: a pending sign-up cannot be re-registered with a different password', async () => {
  const email = 'victim@example.com';
  const reg = await call(D.base, 'POST', '/api/auth/register', { ip: '10.9.3.1', body: signup(email, 'victims-password-1') });
  assert.strictEqual(reg.status, 200); assert.strictEqual(reg.json.otpRequired, true);
  assert.ok(!reg.json.token, 'no session before the code is verified');
  const code = mails.get(email); assert.ok(code, 'code delivered');

  const hijack = await call(D.base, 'POST', '/api/auth/register', { ip: '10.9.3.2', body: signup(email, 'attackers-password') });
  assert.strictEqual(hijack.status, 409);
  assert.strictEqual(hijack.json.code, 'signup_pending');

  const retry = await call(D.base, 'POST', '/api/auth/register', { ip: '10.9.3.3', body: signup(email, 'victims-password-1') });
  assert.strictEqual(retry.status, 200, 'the same person retrying with the same password is fine');

  const ver = await call(D.base, 'POST', '/api/auth/verify-otp', { ip: '10.9.3.1', body: { email, code: mails.get(email) } });
  assert.strictEqual(ver.status, 200); assert.ok(ver.json.token);

  // the victim's password is the one in force; the attacker's is not
  const bad = await call(D.base, 'POST', '/api/auth/login', { ip: '10.9.3.4', body: { username: email, password: 'attackers-password' } });
  assert.strictEqual(bad.status, 401);
  const good = await call(D.base, 'POST', '/api/auth/login', { ip: '10.9.3.5', body: { username: email, password: 'victims-password-1' } });
  assert.strictEqual(good.status, 200); assert.strictEqual(good.json.otpRequired, true);
});

test('OTP on: a wrong code never opens a session and the code dies after 5 tries', async () => {
  const email = 'brute@example.com';
  await call(D.base, 'POST', '/api/auth/register', { ip: '10.9.4.1', body: signup(email) });
  const real = mails.get(email);
  const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await call(D.base, 'POST', '/api/auth/verify-otp', { ip: '10.9.4.' + (10 + i), body: { email, code: wrong } });
    assert.strictEqual(r.status, 400); assert.ok(!r.json.token);
  }
  const late = await call(D.base, 'POST', '/api/auth/verify-otp', { ip: '10.9.4.20', body: { email, code: real } });
  assert.notStrictEqual(late.status, 200, 'even the right code is refused once the tries are used up');
  assert.ok(!late.json.token);
});

test('OTP on: the admin email becomes admin only after its emailed code is verified', async () => {
  const reg = await call(D.base, 'POST', '/api/auth/register', { ip: '10.9.5.1', body: signup(ADMIN_MAIL) });
  assert.strictEqual(reg.json.otpRequired, true); assert.ok(!reg.json.token);
  const ver = await call(D.base, 'POST', '/api/auth/verify-otp', { ip: '10.9.5.1', body: { email: ADMIN_MAIL, code: mails.get(ADMIN_MAIL) } });
  assert.strictEqual(ver.json.profile.isAdmin, true);
  assert.strictEqual((await call(D.base, 'GET', '/api/admin/users', { ip: '10.9.5.1', token: ver.json.token })).status, 200);
  // a second registration of the (now verified) admin email is refused
  assert.strictEqual((await call(D.base, 'POST', '/api/auth/register', { ip: '10.9.5.2', body: signup(ADMIN_MAIL, 'another-password-9') })).status, 409);
});

/* ---------- misc ---------- */
test('MAIL_API_URL is ignored outside NODE_ENV=test', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /process\.env\.NODE_ENV === 'test' && \/\^http:\\\/\\\/127\\\.0\\\.0\\\.1/);
});

test('session tokens are stored hashed on disk, never in clear', async () => {
  const r = await call(C.base, 'POST', '/api/auth/register', { ip: '10.9.6.1', body: signup('disk@example.com') });
  await new Promise(ok => setTimeout(ok, 1500));   // sessions are saved within ~1 s
  const disk = fs.readFileSync(path.join(C.dir, 'sessions.json'), 'utf8');
  assert.ok(!disk.includes(r.json.token), 'raw bearer token must not be on disk');
  const users = fs.readFileSync(path.join(C.dir, 'users.json'), 'utf8');
  assert.ok(!users.includes(PW), 'no clear-text password');
});
