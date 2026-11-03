'use strict';
// Demo Arena routes, exercised WITHOUT express: create() is wired to a tiny fake `app`, a fake session table, a fake feed and a fake clock.
// This covers the real route code (auth, Pro/admin gates, validation, settlement through the feed lookup, persistence) with no network.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create } = require('../demo-arena');

const HOUR = 3600000, MIN = 60000;
const T0 = Date.parse('2026-11-02T10:00:00Z');

function harness(over = {}) {
  const routes = {}, sessions = new Map();
  const app = { get: (p, ...h) => { routes['GET ' + p] = h; }, post: (p, ...h) => { routes['POST ' + p] = h; } };
  const clock = { t: T0 }, feed = { ok: true, error: null, fixtures: [] }, prov = { configured: true };
  const dir = over.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'mde-routes-'));
  const file = path.join(dir, 'demo-arena.json');
  const savers = [];
  const arena = create({
    app, now: () => clock.t, file,
    authMiddleware: (req, res, next) => { if (!sessions.has(req.headers.authorization)) return res.status(401).json({ error: 'Session expired' }); req.authToken = req.headers.authorization; next(); },
    requireAdmin: (req, res, next) => (sessions.get(req.authToken) || {}).admin ? next() : res.status(404).json({ error: 'Not found' }),
    dataLimiter: (req, res, next) => next(),
    writeAtomic: (f, d) => fs.writeFileSync(f, d),
    makeSaver: (label, fn) => { const s = { soon() {}, now() { fn(); } }; savers.push(s); return s; },
    planOf: s => (s && s.plan) || 'free',
    isAdminSession: s => !!(s && s.admin),
    getSession: req => sessions.get(req.authToken),
    getFeed: async () => (feed.ok ? { ok: true, fixtures: feed.fixtures } : { ok: false, error: feed.error, fixtures: [] }),
    lookupMatch: id => { const f = feed.fixtures.find(x => String(x.id) === String(id)); return f ? { status: f.status, homeScore: f.homeScore, awayScore: f.awayScore } : null; },
    providerStatus: () => ({ configured: prov.configured, providers: { bzzoiro: prov.configured } }),
    planOfUserKey: () => 'free'
  });
  async function call(method, url, { token, body, query } = {}) {
    const chain = routes[method + ' ' + url];
    assert.ok(chain, 'route exists: ' + method + ' ' + url);
    const req = { method, path: url, headers: { authorization: token }, query: query || {}, body: body || {}, ip: '9.9.9.9' };
    let status = 200, json;
    const res = { headersSent: false, setHeader() {}, status(c) { status = c; return res; }, json(o) { json = o; res.headersSent = true; return res; } };
    for (const fn of chain) {
      let went = false;
      await new Promise(resolve => { const r = fn(req, res, () => { went = true; resolve(); }); Promise.resolve(r).then(() => resolve(), () => resolve()); });
      if (!went && !(fn === chain[chain.length - 1])) break;
      if (fn === chain[chain.length - 1]) break;
    }
    return { status, json };
  }
  const login = (token, sess) => sessions.set(token, Object.assign({ kind: 'local', username: token + '@x.com', plan: 'free' }, sess || {}));
  return { call, login, clock, feed, prov, arena, dir, file, savers, sessions };
}
const ko = new Date(T0 + 5 * HOUR);
const fx = (over = {}) => Object.assign({
  id: 'bzz_77', league: 'La Liga', date: ko.toISOString().slice(0, 10), kickoff: ko.toISOString().slice(11, 16), status: 'notstarted', homeScore: 0, awayScore: 0, big: 2,
  home: { name: 'Real Madrid', logo: null }, away: { name: 'Barcelona', logo: null },
  odds: [{ book: 'A', home: 2.0, draw: 3.4, away: 3.6, over25: 1.9, under25: 1.95 }]
}, over);
const body = (o = {}) => Object.assign({ matchId: 'bzz_77', market: '1x2', selection: 'home', stake: 100, odds: 2.0 }, o);

test('every route needs a session; admin routes look missing to normal users', async () => {
  const h = harness();
  for (const k of ['GET /api/demo/me', 'GET /api/demo/matches', 'POST /api/demo/predict', 'GET /api/demo/predictions', 'GET /api/demo/transactions', 'POST /api/demo/recover', 'GET /api/demo/analytics', 'GET /api/demo/admin/overview']) {
    const [m, u] = k.split(' ');
    assert.strictEqual((await h.call(m, u, {})).status, 401, k);
  }
  h.login('u1');
  for (const k of ['GET /api/demo/admin/overview', 'POST /api/demo/admin/config', 'POST /api/demo/admin/settle']) {
    const [m, u] = k.split(' ');
    assert.strictEqual((await h.call(m, u, { token: 'u1' })).status, 404, k);
  }
});

test('full flow: matches -> prediction -> stake deducted -> verified result -> virtual return credited', async () => {
  const h = harness(); h.login('u1'); h.feed.fixtures = [fx(), fx({ id: 'bzz_78', odds: [], big: 0 })];
  const m = await h.call('GET', '/api/demo/matches', { token: 'u1', query: { view: 'upcoming' } });
  assert.strictEqual(m.json.data.mode, 'live');
  const card = m.json.matches.find(c => c.id === 'bzz_77'), nodds = m.json.matches.find(c => c.id === 'bzz_78');
  assert.ok(card.bettable && card.featured && card.markets.x12.home === 2.0 && card.markets.ou25.over === 1.9);
  assert.ok(!nodds.bettable && nodds.markets.x12 === null);                                         // unavailable data is shown as unavailable
  const p = await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ requestId: 'abcdefgh12' }) });
  assert.strictEqual(p.status, 200); assert.strictEqual(p.json.prediction.potential, 200); assert.strictEqual(p.json.wallet.balance, 1900);
  assert.strictEqual((await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ requestId: 'abcdefgh12' }) })).json.wallet.balance, 1900);   // retry: no double charge
  const list = await h.call('GET', '/api/demo/predictions', { token: 'u1', query: {} });
  assert.strictEqual(list.json.total, 1); assert.strictEqual(list.json.items[0].phase, 'pending'); assert.strictEqual(list.json.counts.pending, 1);

  h.clock.t = T0 + 5 * HOUR + 30 * MIN;                                                             // in play
  h.feed.fixtures[0] = fx({ status: 'started', homeScore: 1, awayScore: 0 });
  assert.strictEqual((await h.call('GET', '/api/demo/predictions', { token: 'u1', query: { filter: 'active' } })).json.total, 1);
  assert.strictEqual((await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ stake: 50 }) })).json.code, 'closed');

  h.clock.t = T0 + 5 * HOUR + 110 * MIN;                                                            // full time, score first seen
  h.feed.fixtures[0] = fx({ status: 'finished', homeScore: 2, awayScore: 0 });
  let me = await h.call('GET', '/api/demo/me', { token: 'u1' });
  assert.strictEqual(me.json.wallet.balance, 1900); assert.strictEqual(me.json.wallet.pending, 1);   // not trusted until it stays stable
  h.clock.t += 4 * MIN;
  me = await h.call('GET', '/api/demo/me', { token: 'u1' });
  assert.strictEqual(me.json.wallet.balance, 2100); assert.strictEqual(me.json.wallet.wins, 1); assert.strictEqual(me.json.wallet.winRate, 100);
  h.clock.t += HOUR;
  me = await h.call('GET', '/api/demo/me', { token: 'u1' });
  assert.strictEqual(me.json.wallet.balance, 2100);                                                 // no double settlement
  const tx = await h.call('GET', '/api/demo/transactions', { token: 'u1', query: {} });
  assert.deepStrictEqual(tx.json.items.map(t => t.type), ['win', 'stake', 'grant']);
});

test('odds that moved are rejected with the new price; unknown markets (BTTS) are refused', async () => {
  const h = harness(); h.login('u1'); h.feed.fixtures = [fx()];
  const r = await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ odds: 2.5 }) });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.json.code, 'odds_changed'); assert.strictEqual(r.json.odds, 2.0);
  assert.strictEqual((await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ market: 'btts', selection: 'yes' }) })).status, 400);
  assert.strictEqual((await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ matchId: 'nope' }) })).status, 404);
  assert.strictEqual((await h.call('GET', '/api/demo/me', { token: 'u1' })).json.wallet.balance, 2000);
});

test('the browser can never choose the odds, balance, plan or result', async () => {
  const h = harness(); h.login('u1'); h.feed.fixtures = [fx()];
  const r = await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ odds: undefined, balance: 1e9, plan: 'pro', result: 'won', payout: 99999, status: 'won' }) });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.prediction.odds, 2.0); assert.strictEqual(r.json.prediction.status, 'pending');
  assert.strictEqual(r.json.wallet.balance, 1900); assert.strictEqual(r.json.wallet.plan, 'free');
});

test('Free vs Pro: analytics and history depth are enforced on the server', async () => {
  const h = harness(); h.login('free'); h.login('pro', { plan: 'pro' }); h.feed.fixtures = [fx()];
  assert.strictEqual((await h.call('GET', '/api/demo/analytics', { token: 'free' })).status, 403);
  const a = await h.call('GET', '/api/demo/analytics', { token: 'pro' });
  assert.strictEqual(a.status, 200); assert.ok(Array.isArray(a.json.series));
  h.arena.store.config.maxOpenPredictions = 200;
  const bulk = (key, plan, n) => { for (let i = 0; i < n; i++) assert.ok(h.arena.store.place(key, plan, { matchId: 'bzz_77', market: '1x2', selection: 'home', stake: 10, odds: 2.0 }, fx(), '1.1.1.1').ok); };
  bulk('email:free@x.com', 'free', 50); bulk('email:pro@x.com', 'pro', 50);
  const f = await h.call('GET', '/api/demo/predictions', { token: 'free', query: { limit: '50', offset: '0' } });
  assert.strictEqual(f.json.items.length, 20); assert.strictEqual(f.json.limited, true); assert.strictEqual(f.json.total, 50);
  const f2 = await h.call('GET', '/api/demo/predictions', { token: 'free', query: { limit: '50', offset: '20' } });
  assert.deepStrictEqual(f2.json.items.map(x => x.id), f.json.items.map(x => x.id));                 // offset is ignored for Free
  const p = await h.call('GET', '/api/demo/predictions', { token: 'pro', query: { limit: '50', offset: '0' } });
  assert.strictEqual(p.json.items.length, 50); assert.strictEqual(p.json.limited, false);
  const p2 = await h.call('GET', '/api/demo/predictions', { token: 'pro', query: { limit: '20', offset: '40' } });
  assert.strictEqual(p2.json.items.length, 10);                                                       // Pro can page through the whole history
});

test('prediction placement is rate limited per user', async () => {
  const h = harness(); h.login('u1'); h.login('u2'); h.feed.fixtures = [fx()];
  h.arena.store.config.maxOpenPredictions = 200;
  let last;
  for (let i = 0; i < 22; i++) last = await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ stake: 10 }) });
  assert.strictEqual(last.status, 429);
  assert.strictEqual((await h.call('POST', '/api/demo/predict', { token: 'u2', body: body({ stake: 10 }) })).status, 200);   // other users are unaffected
});

test('recovery: Free = once per interval with a countdown, Pro = whenever', async () => {
  const h = harness(); h.login('free'); h.login('pro', { plan: 'pro' }); h.feed.fixtures = [fx()];
  assert.strictEqual((await h.call('POST', '/api/demo/recover', { token: 'free', body: { confirm: true } })).json.code, 'balance_ok');
  for (const t of ['free', 'pro']) await h.call('POST', '/api/demo/predict', { token: t, body: body({ stake: 1000 }) });
  assert.strictEqual((await h.call('POST', '/api/demo/recover', { token: 'free', body: {} })).json.code, 'confirm_required');
  const ok = await h.call('POST', '/api/demo/recover', { token: 'free', body: { confirm: true } });
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.wallet.balance, 2000); assert.strictEqual(ok.json.recoveries.length, 1);
  await h.call('POST', '/api/demo/predict', { token: 'free', body: body({ stake: 1000 }) });
  const again = await h.call('POST', '/api/demo/recover', { token: 'free', body: { confirm: true } });
  assert.strictEqual(again.status, 429); assert.strictEqual(again.json.code, 'cooldown'); assert.strictEqual(again.json.recovery.nextAt, T0 + 30 * 24 * HOUR);
  for (let i = 0; i < 3; i++) {
    assert.strictEqual((await h.call('POST', '/api/demo/recover', { token: 'pro', body: { confirm: true } })).status, 200);
    await h.call('POST', '/api/demo/predict', { token: 'pro', body: body({ stake: 1000 }) });
  }
  const me = await h.call('GET', '/api/demo/me', { token: 'free' });
  assert.strictEqual(me.json.recovery.cooling, true); assert.strictEqual(me.json.recovery.intervalDays, 30);
});

test('data modes: no provider -> labelled sample data; feed outage -> unavailable (+ logged); admin can switch the feed off', async () => {
  const h = harness(); h.login('u1'); h.login('boss', { admin: true });
  h.prov.configured = false;
  let r = await h.call('GET', '/api/demo/matches', { token: 'u1', query: {} });
  assert.strictEqual(r.json.data.mode, 'sample'); assert.ok(r.json.matches.every(m => m.sample && !m.bettable));
  assert.strictEqual((await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ matchId: 'sample_1' }) })).json.code, 'no_live_data');
  h.prov.configured = true; h.feed.ok = false; h.feed.error = 'HTTP 500 from provider';
  r = await h.call('GET', '/api/demo/matches', { token: 'u1', query: {} });
  assert.strictEqual(r.json.data.mode, 'unavailable'); assert.deepStrictEqual(r.json.matches, []);
  const ov = await h.call('GET', '/api/demo/admin/overview', { token: 'boss' });
  assert.ok(ov.json.errors.some(e => e.source === 'feed' && /HTTP 500/.test(e.message)));
  h.feed.ok = true; h.feed.fixtures = [fx()];
  assert.strictEqual((await h.call('POST', '/api/demo/admin/config', { token: 'boss', body: { config: { dataMode: 'off' } } })).status, 200);
  r = await h.call('GET', '/api/demo/matches', { token: 'u1', query: {} });
  assert.strictEqual(r.json.data.mode, 'off'); assert.deepStrictEqual(r.json.matches, []);
});

test('admin: validated config, audit trail, overview and manual settlement', async () => {
  const h = harness(); h.login('u1'); h.login('boss', { admin: true }); h.feed.fixtures = [fx()];
  await h.call('POST', '/api/demo/predict', { token: 'u1', body: body() });
  assert.strictEqual((await h.call('POST', '/api/demo/admin/config', { token: 'boss', body: { config: { initialBalance: 1 } } })).status, 400);
  const c = await h.call('POST', '/api/demo/admin/config', { token: 'boss', body: { config: { freeRecoveryDays: 7, maxStake: 500 } } });
  assert.strictEqual(c.status, 200); assert.strictEqual(c.json.config.freeRecoveryDays, 7);
  assert.strictEqual((await h.call('POST', '/api/demo/predict', { token: 'u1', body: body({ stake: 501 }) })).json.code, 'stake_range');   // takes effect immediately
  h.clock.t = T0 + 8 * HOUR; h.feed.fixtures = [fx({ status: 'finished', homeScore: 0, awayScore: 1 })];
  await h.call('POST', '/api/demo/admin/settle', { token: 'boss' });                                // first sighting
  h.clock.t += 4 * MIN;
  const s = await h.call('POST', '/api/demo/admin/settle', { token: 'boss' });
  assert.strictEqual(s.json.totals.lost, 1);
  const ov = await h.call('GET', '/api/demo/admin/overview', { token: 'boss' });
  assert.strictEqual(ov.json.totals.wallets, 1); assert.strictEqual(ov.json.users[0].predictions, 1);
  const actions = ov.json.audit.map(a => a.action);
  for (const a of ['wallet_created', 'predict', 'config_change', 'settle', 'settle_now']) assert.ok(actions.includes(a), a);
  assert.strictEqual(ov.json.users[0].profit, -100);
});

test('state survives a restart (wallet, prediction, config)', async () => {
  const h = harness(); h.login('u1'); h.feed.fixtures = [fx()];
  await h.call('POST', '/api/demo/predict', { token: 'u1', body: body() });
  h.arena.store.setConfig({ freeRecoveryDays: 9 }, 'boss');
  h.savers.forEach(s => s.now());
  const h2 = harness({ dir: h.dir }); h2.login('u1'); h2.feed.fixtures = h.feed.fixtures;
  const me = await h2.call('GET', '/api/demo/me', { token: 'u1' });
  assert.strictEqual(me.json.wallet.balance, 1900); assert.strictEqual(me.json.wallet.pending, 1); assert.strictEqual(me.json.config.freeRecoveryDays, 9);
  assert.strictEqual((await h2.call('GET', '/api/demo/predictions', { token: 'u1', query: {} })).json.total, 1);
});
