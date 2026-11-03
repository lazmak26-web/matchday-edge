'use strict';
// Demo Arena over HTTP: auth, server-side Pro/admin gates, wallet, recovery, sample-data mode.
// The test server has NO sports API keys, so it runs in clearly labelled sample-data mode and nothing external is called.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mde-demo-'));
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
  return { base: 'http://127.0.0.1:' + port, stop, dir };
}
async function call(base, method, url, { body, token, ip, headers } = {}) {
  const r = await fetch(base + url, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}, ip ? { 'x-forwarded-for': ip } : {}, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const ADMIN_TOKEN = 'test-admin-token-1234567890';
const signup = email => ({ email, password: 'correct-horse-battery', consent: true, ageConfirmed: true });

let S, tokenFree, tokenPro;
before(async () => {
  S = await startServer({ ADMIN_TOKEN, ADMIN_ALLOW_NO_OTP: '1', ADMIN_EMAIL: 'boss@example.com' });
  tokenFree = (await call(S.base, 'POST', '/api/auth/register', { ip: '10.7.0.1', body: signup('free@example.com') })).json.token;
  const pro = await call(S.base, 'POST', '/api/auth/register', { ip: '10.7.0.2', body: signup('pro@example.com') });
  tokenPro = pro.json.token;
  // grant Pro the way the owner does it: through the server's admin endpoint (never a client flag)
  const g = await call(S.base, 'POST', '/api/admin/plan', { ip: '10.7.0.3', headers: { 'x-admin-token': ADMIN_TOKEN }, body: { email: 'pro@example.com', plan: 'pro', days: 30 } });
  assert.strictEqual(g.status, 200);
});
after(async () => { await S && S.stop(); });

test('every Demo Arena endpoint needs a session', async () => {
  for (const [m, u] of [['GET', '/api/demo/me'], ['GET', '/api/demo/matches'], ['POST', '/api/demo/predict'], ['GET', '/api/demo/predictions'], ['GET', '/api/demo/transactions'], ['POST', '/api/demo/recover'], ['GET', '/api/demo/analytics'], ['GET', '/api/demo/admin/overview']]) {
    const r = await call(S.base, m, u, { ip: '10.7.1.1', body: m === 'POST' ? {} : undefined });
    assert.strictEqual(r.status, 401, m + ' ' + u);
  }
});

test('a new Free user gets a 2,000 DH virtual wallet and the Free rules', async () => {
  const r = await call(S.base, 'GET', '/api/demo/me', { token: tokenFree, ip: '10.7.2.1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.wallet.balance, 2000);
  assert.strictEqual(r.json.plan, 'free');
  assert.strictEqual(r.json.recovery.unlimited, false);
  assert.strictEqual(r.json.recovery.allowed, false);                                   // nothing to recover at 2,000
  assert.strictEqual(r.json.isAdmin, false);
  assert.strictEqual(r.json.data.mode, 'sample');                                       // no provider configured -> sample mode, labelled
});

test('sample-data mode: matches are labelled and cannot take predictions', async () => {
  const r = await call(S.base, 'GET', '/api/demo/matches?sport=football&view=upcoming', { token: tokenFree, ip: '10.7.3.1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.data.mode, 'sample');
  assert.ok(r.json.matches.length > 0 && r.json.matches.every(m => m.sample === true && m.bettable === false));
  assert.ok(r.json.matches.every(m => /sample/i.test(m.league)));
  const live = await call(S.base, 'GET', '/api/demo/matches?view=live', { token: tokenFree, ip: '10.7.3.2' });
  assert.strictEqual(live.json.matches.length, 0);
  const p = await call(S.base, 'POST', '/api/demo/predict', { token: tokenFree, ip: '10.7.3.3', body: { matchId: 'sample_1', market: '1x2', selection: 'home', stake: 100, odds: 2.1 } });
  assert.strictEqual(p.status, 503); assert.strictEqual(p.json.code, 'no_live_data');
  const me = await call(S.base, 'GET', '/api/demo/me', { token: tokenFree, ip: '10.7.3.4' });
  assert.strictEqual(me.json.wallet.balance, 2000);                                     // nothing was charged
});

test('basketball and tennis report that no data provider exists instead of inventing matches', async () => {
  for (const sport of ['basketball', 'tennis']) {
    const r = await call(S.base, 'GET', '/api/demo/matches?sport=' + sport, { token: tokenFree, ip: '10.7.4.1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.available, false); assert.deepStrictEqual(r.json.matches, []);
  }
  assert.strictEqual((await call(S.base, 'GET', '/api/demo/matches?sport=curling', { token: tokenFree, ip: '10.7.4.2' })).status, 400);
});

test('recovery needs an explicit confirmation and is refused when the balance is already full', async () => {
  assert.strictEqual((await call(S.base, 'POST', '/api/demo/recover', { token: tokenFree, ip: '10.7.5.1', body: {} })).status, 400);
  const r = await call(S.base, 'POST', '/api/demo/recover', { token: tokenFree, ip: '10.7.5.2', body: { confirm: true } });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.json.code, 'balance_ok');
});

test('client-supplied balances, plans and results are ignored', async () => {
  const r = await call(S.base, 'POST', '/api/demo/predict', { token: tokenFree, ip: '10.7.6.1', body: { matchId: 'x', market: '1x2', selection: 'home', stake: 100, balance: 999999, plan: 'pro', isPro: true, result: 'won' } });
  assert.notStrictEqual(r.status, 200);
  const me = await call(S.base, 'GET', '/api/demo/me', { token: tokenFree, ip: '10.7.6.2' });
  assert.strictEqual(me.json.wallet.balance, 2000); assert.strictEqual(me.json.plan, 'free');
});

test('advanced analytics are Pro-only, enforced on the server', async () => {
  const free = await call(S.base, 'GET', '/api/demo/analytics', { token: tokenFree, ip: '10.7.7.1' });
  assert.strictEqual(free.status, 403); assert.strictEqual(free.json.code, 'pro_required');
});

test('Pro: verified by the server, unlimited recovery flag and the advanced analytics', async () => {
  const me = await call(S.base, 'GET', '/api/demo/me', { token: tokenPro, ip: '10.7.7.5' });
  assert.strictEqual(me.json.plan, 'pro'); assert.strictEqual(me.json.recovery.unlimited, true); assert.strictEqual(me.json.wallet.balance, 2000);
  const a = await call(S.base, 'GET', '/api/demo/analytics', { token: tokenPro, ip: '10.7.7.6' });
  assert.strictEqual(a.status, 200); assert.strictEqual(a.json.settled, 0); assert.ok(Array.isArray(a.json.series));
});

test('Free prediction history is capped and flagged; empty history is fine', async () => {
  const r = await call(S.base, 'GET', '/api/demo/predictions?filter=all', { token: tokenFree, ip: '10.7.8.1' });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.total, 0); assert.strictEqual(r.json.limited, false); assert.strictEqual(r.json.freeCap, 20);
  const t = await call(S.base, 'GET', '/api/demo/transactions', { token: tokenFree, ip: '10.7.8.2' });
  assert.strictEqual(t.status, 200); assert.strictEqual(t.json.items[0].type, 'grant'); assert.strictEqual(t.json.items[0].amount, 2000);
});

test('admin endpoints are hidden from normal users (404) and validate input', async () => {
  for (const [m, u] of [['GET', '/api/demo/admin/overview'], ['POST', '/api/demo/admin/config'], ['POST', '/api/demo/admin/settle']]) {
    const r = await call(S.base, m, u, { token: tokenFree, ip: '10.7.9.1', body: m === 'POST' ? { config: { initialBalance: 5000 } } : undefined });
    assert.strictEqual(r.status, 404, u);
  }
  const me = await call(S.base, 'GET', '/api/demo/me', { token: tokenFree, ip: '10.7.9.2' });
  assert.strictEqual(me.json.config.initialBalance, 2000);
});

test('the administrator account can read the overview and change validated settings', async () => {
  const reg = await call(S.base, 'POST', '/api/auth/register', { ip: '10.7.10.1', body: signup('boss@example.com') });
  const t = reg.json.token;
  const ov = await call(S.base, 'GET', '/api/demo/admin/overview', { token: t, ip: '10.7.10.2' });
  assert.strictEqual(ov.status, 200);
  assert.ok(ov.json.totals.wallets >= 1); assert.ok(Array.isArray(ov.json.users)); assert.ok(ov.json.providers);
  const bad = await call(S.base, 'POST', '/api/demo/admin/config', { token: t, ip: '10.7.10.3', body: { config: { initialBalance: 5 } } });
  assert.strictEqual(bad.status, 400);
  const ok = await call(S.base, 'POST', '/api/demo/admin/config', { token: t, ip: '10.7.10.4', body: { config: { freeRecoveryDays: 14 } } });
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.config.freeRecoveryDays, 14);
  const ov2 = await call(S.base, 'GET', '/api/demo/admin/overview', { token: t, ip: '10.7.10.5' });
  assert.ok(ov2.json.audit.some(a => a.action === 'config_change'));
  const me = await call(S.base, 'GET', '/api/demo/me', { token: t, ip: '10.7.10.6' });
  assert.strictEqual(me.json.isAdmin, true);
});

test('wallets persist to disk', async () => {
  await new Promise(r => setTimeout(r, 700));                                           // saver debounce
  const f = path.join(S.dir, 'demo-arena.json');
  assert.ok(fs.existsSync(f));
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(Object.keys(j.wallets).some(k => k === 'email:free@example.com'));
});
