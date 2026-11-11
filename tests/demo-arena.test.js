'use strict';
// Demo Arena: wallet, prediction, settlement, recovery and config rules (pure store, fake clock, fake match feed).
const { test } = require('node:test');
const assert = require('node:assert');
const { DemoStore, DEFAULT_CONFIG, sanitizeConfig, consensusOdds, oddsFor, toCard, outcomeOf, MIN_MATCH_MS } = require('../demo-arena');

const HOUR = 3600000, DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-02T10:00:00Z');

function mk(opts = {}) {
  const clock = { t: T0 };
  const store = new DemoStore({ now: () => clock.t });
  Object.assign(store.s.config, opts.config || {});
  return { store, clock };
}
function fixture(over = {}) {
  const ko = new Date(T0 + 5 * HOUR);
  return Object.assign({
    id: 'bzz_1', league: 'Test League', date: ko.toISOString().slice(0, 10), kickoff: ko.toISOString().slice(11, 16), status: 'notstarted', homeScore: 0, awayScore: 0,
    home: { name: 'Madrid', logo: null }, away: { name: 'Barca', logo: null },
    odds: [{ book: 'A', home: 2.0, draw: 3.4, away: 3.6, over25: 1.9, under25: 1.95 }, { book: 'B', home: 2.0, draw: 3.5, away: 3.5, over25: 2.0, under25: 1.9 }, { book: 'C', home: 2.2, draw: 3.3, away: 3.4, over25: null, under25: null }]
  }, over);
}
const U = 'email:a@x.com';
const ledgerOk = (store, key) => {
  const w = store.s.wallets[key];
  assert.strictEqual(w.tx.reduce((s, t) => s + t.amountC, 0), w.balanceC, 'sum of transactions must equal the balance');
};
const place = (store, fx, over = {}) => store.place(U, 'free', Object.assign({ matchId: fx.id, market: '1x2', selection: 'home', stake: 100, odds: 2.0 }, over), fx, '1.1.1.1');

test('odds: demo odds are the market median; only provider-supplied markets exist', () => {
  const c = consensusOdds(fixture().odds);
  assert.deepStrictEqual(c.x12, { home: 2.0, draw: 3.4, away: 3.5 });
  assert.strictEqual(c.ou25.over, 1.95);
  assert.ok(Math.abs(c.ou25.under - 1.925) <= 0.0051);
  assert.strictEqual(consensusOdds([{ book: 'A', home: 2, draw: 3, away: 4 }]).ou25, null);        // no O/U from the provider -> no market
  assert.strictEqual(consensusOdds([{ book: 'A', home: 1.0, draw: 3, away: 4 }]).x12, null);       // insane price rejected
  assert.strictEqual(oddsFor(fixture(), 'btts', 'yes'), null);                                      // BTTS is never offered
  assert.strictEqual(oddsFor(fixture({ odds: [] }), '1x2', 'home'), null);
});

test('toCard: live / scheduled / unavailable data are distinguished and scores are hidden before kickoff', () => {
  const now = T0;
  assert.strictEqual(toCard(fixture(), now).bettable, true);
  assert.strictEqual(toCard(fixture({ odds: [] }), now).bettable, false);                           // no odds -> not bettable
  assert.strictEqual(toCard(fixture({ homeScore: 3 }), now).homeScore, null);                       // scheduled: no score
  const live = toCard(fixture({ status: 'started', homeScore: 1, awayScore: 0 }), now);
  assert.strictEqual(live.live, true); assert.strictEqual(live.homeScore, 1); assert.strictEqual(live.bettable, false);
});

test('new wallets receive the configured virtual balance and the ledger balances', () => {
  const { store } = mk();
  const w = store.walletPublic(U, 'free');
  assert.strictEqual(w.balance, 2000);
  assert.strictEqual(store.walletPublic('email:b@x.com', 'free').balance, 2000);
  ledgerOk(store, U);
});

test('placing a prediction validates stake, odds, market and kickoff; stake is deducted once', () => {
  const { store, clock } = mk();
  const fx = fixture();
  let r = place(store, fx);
  assert.ok(r.ok); assert.strictEqual(store.walletPublic(U, 'free').balance, 1900);
  assert.strictEqual(r.prediction.potentialC, 20000);
  assert.strictEqual(place(store, fx, { stake: 5 }).code, 'stake_range');
  assert.strictEqual(place(store, fx, { stake: 99999 }).code, 'stake_range');
  assert.strictEqual(place(store, fx, { stake: 10.5 }).code, 'bad_stake');
  assert.strictEqual(place(store, fx, { stake: '100' }).code, 'bad_stake');
  assert.strictEqual(place(store, fx, { selection: 'banana' }).code, 'bad_selection');
  assert.strictEqual(place(store, fx, { market: 'btts', selection: 'yes' }).code, 'bad_selection');
  assert.strictEqual(place(store, fx, { market: 'ou25', selection: 'over', odds: 1.95 }).ok, true);
  const noOu = fixture({ id: 'bzz_9', odds: [{ book: 'A', home: 2, draw: 3, away: 4 }] });
  assert.strictEqual(place(store, noOu, { market: 'ou25', selection: 'over', odds: undefined }).code, 'market_unavailable');
  const changed = place(store, fx, { odds: 2.5 });
  assert.strictEqual(changed.code, 'odds_changed'); assert.strictEqual(changed.odds, 2.0);
  assert.strictEqual(store.place(U, 'free', { matchId: 'nope', market: '1x2', selection: 'home', stake: 100 }, null).code, 'match_not_found');
  assert.strictEqual(place(store, fixture({ status: 'started' })).code, 'closed');
  clock.t = T0 + 6 * HOUR;                                                                        // kickoff passed even if the feed still says notstarted
  assert.strictEqual(place(store, fx).code, 'closed');
  ledgerOk(store, U);
});

test('a retried request id never double-charges', () => {
  const { store } = mk();
  const fx = fixture();
  const a = place(store, fx, { requestId: 'req-12345678' }), b = place(store, fx, { requestId: 'req-12345678' });
  assert.ok(a.ok && b.ok && b.duplicate);
  assert.strictEqual(a.prediction.id, b.prediction.id);
  assert.strictEqual(store.walletPublic(U, 'free').balance, 1900);
  assert.strictEqual(store.walletPublic(U, 'free').predictions, 1);
});

test('balance rules: cannot stake more than the balance; at zero nothing can be placed', () => {
  const { store } = mk({ config: { maxStake: 5000 } });
  const fx = fixture();
  assert.strictEqual(place(store, fx, { stake: 2001 }).code, 'insufficient_balance');
  assert.ok(place(store, fx, { stake: 2000 }).ok);
  assert.strictEqual(store.walletPublic(U, 'free').balance, 0);
  assert.strictEqual(place(store, fx, { stake: 10 }).code, 'insufficient_balance');
  ledgerOk(store, U);
});

test('max open predictions is enforced', () => {
  const { store } = mk({ config: { maxOpenPredictions: 2 } });
  const fx = fixture();
  assert.ok(place(store, fx, { stake: 10 }).ok); assert.ok(place(store, fx, { stake: 10 }).ok);
  assert.strictEqual(place(store, fx, { stake: 10 }).code, 'too_many_open');
});

const finished = (h, a) => ({ status: 'finished', homeScore: h, awayScore: a });

test('settlement: win credits the return, loss records the loss, never twice', () => {
  const { store, clock } = mk({ config: { settleDelayMin: 0 } });
  const fx = fixture();
  const win = place(store, fx).prediction;                                                         // Madrid win @2.00, 100 DH
  const loss = place(store, fx, { selection: 'away', odds: 3.5, stake: 50 }).prediction;
  assert.strictEqual(store.walletPublic(U, 'free').balance, 1850);
  clock.t = T0 + 5 * HOUR + MIN_MATCH_MS + 1000;
  const r1 = store.settleDue(() => finished(2, 1));
  assert.deepStrictEqual([r1.settled, r1.voided], [2, 0]);
  assert.strictEqual(win.status, 'won'); assert.strictEqual(loss.status, 'lost');
  assert.strictEqual(store.walletPublic(U, 'free').balance, 2050);                                // 1850 + 200 return
  const r2 = store.settleDue(() => finished(0, 5));                                               // a later, different result must be ignored
  assert.strictEqual(r2.settled, 0);
  assert.strictEqual(store.walletPublic(U, 'free').balance, 2050);
  const w = store.walletPublic(U, 'free');
  assert.deepStrictEqual([w.wins, w.losses, w.winRate, w.profit, w.won, w.lost, w.used], [1, 1, 50, 50, 200, 50, 150]);
  assert.strictEqual(w.pending, 0);
  ledgerOk(store, U);
});

test('settlement: over/under 2.5 and draw outcomes', () => {
  assert.strictEqual(outcomeOf('ou25', 2, 1), 'over'); assert.strictEqual(outcomeOf('ou25', 1, 1), 'under'); assert.strictEqual(outcomeOf('1x2', 1, 1), 'draw');
  const { store, clock } = mk({ config: { settleDelayMin: 0 } });
  const fx = fixture();
  const o = place(store, fx, { market: 'ou25', selection: 'over', odds: 1.95, stake: 100 }).prediction;
  const d = place(store, fx, { selection: 'draw', odds: 3.4, stake: 100 }).prediction;
  clock.t = T0 + 5 * HOUR + MIN_MATCH_MS;
  store.settleDue(() => finished(1, 1));
  assert.strictEqual(o.status, 'lost'); assert.strictEqual(d.status, 'won'); assert.strictEqual(d.payoutC, 34000);
  ledgerOk(store, U);
});

test('settlement waits for a verified, stable final result', () => {
  const { store, clock } = mk({ config: { settleDelayMin: 3 } });
  const p = place(store, fixture()).prediction;
  clock.t = T0 + 5 * HOUR + 10 * 60000;                                                           // too early after kickoff even if "finished"
  assert.strictEqual(store.settleDue(() => finished(1, 0)).settled, 0);
  assert.strictEqual(p.finalSeen, null);
  clock.t = T0 + 5 * HOUR + MIN_MATCH_MS + 1000;
  assert.strictEqual(store.settleDue(() => finished(1, 0)).settled, 0);                           // first sighting only
  clock.t += 60000;
  assert.strictEqual(store.settleDue(() => finished(2, 0)).settled, 0);                           // score corrected -> timer restarts
  clock.t += 2 * 60000;
  assert.strictEqual(store.settleDue(() => finished(2, 0)).settled, 0);
  clock.t += 2 * 60000;
  assert.strictEqual(store.settleDue(() => finished(2, 0)).settled, 1);
  assert.strictEqual(p.status, 'won');
  assert.strictEqual(store.settleDue(() => ({ status: 'finished', homeScore: null, awayScore: null })).settled, 0);
});

test('a finished match without integer scores is never settled', () => {
  const { store, clock } = mk({ config: { settleDelayMin: 0 } });
  const p = place(store, fixture()).prediction;
  clock.t = T0 + 8 * HOUR;
  assert.strictEqual(store.settleDue(() => ({ status: 'finished', homeScore: null, awayScore: 1 })).settled, 0);
  assert.strictEqual(store.settleDue(() => ({ status: 'started', homeScore: 1, awayScore: 1 })).settled, 0);
  assert.strictEqual(p.status, 'pending');
});

test('cancelled matches are voided and the stake refunded', () => {
  const { store, clock } = mk();
  const p = place(store, fixture()).prediction;
  clock.t = T0 + 5 * HOUR + 1000;
  const r = store.settleDue(() => ({ status: 'canceled', homeScore: 0, awayScore: 0 }));
  assert.strictEqual(r.voided, 1); assert.strictEqual(p.status, 'void'); assert.strictEqual(p.voidReason, 'match_canceled');
  const w = store.walletPublic(U, 'free');
  assert.deepStrictEqual([w.balance, w.used, w.voided, w.pending], [2000, 0, 1, 0]);
  assert.strictEqual(store.settleDue(() => ({ status: 'canceled' })).voided, 0);                  // idempotent
  ledgerOk(store, U);
});

test('postponed / unresolved matches are voided after the timeout and logged as a settlement failure', () => {
  const { store, clock } = mk({ config: { voidAfterHours: 24 } });
  const p = place(store, fixture()).prediction;
  clock.t = T0 + 5 * HOUR + 23 * HOUR;
  assert.strictEqual(store.settleDue(() => null).voided, 0);                                      // still within the window
  clock.t = T0 + 5 * HOUR + 25 * HOUR;
  assert.strictEqual(store.settleDue(() => null).voided, 1);
  assert.strictEqual(p.voidReason, 'unresolved');
  assert.strictEqual(store.walletPublic(U, 'free').balance, 2000);
  assert.strictEqual(store.s.failures.length, 1);
  ledgerOk(store, U);
});

test('feed errors during settlement are logged and do not lose predictions', () => {
  const { store, clock } = mk();
  const p = place(store, fixture()).prediction;
  clock.t = T0 + 6 * HOUR;
  const r = store.settleDue(() => { throw new Error('boom'); });
  assert.strictEqual(r.waiting, 1); assert.strictEqual(p.status, 'pending');
  assert.strictEqual(store.s.errors.length, 1);
});

test('free recovery: only below the starting balance, once per interval, with a countdown', () => {
  const { store, clock } = mk({ config: { settleDelayMin: 0 } });
  assert.strictEqual(store.recover(U, 'free').code, 'balance_ok');                                // nothing to recover at 2000
  place(store, fixture(), { stake: 1000 });
  const st = store.recoveryState(U, 'free');
  assert.deepStrictEqual([st.needs, st.cooling, st.allowed], [true, false, true]);
  assert.ok(store.recover(U, 'free').ok);
  assert.strictEqual(store.walletPublic(U, 'free').balance, 2000);
  place(store, fixture(), { stake: 1000 });
  const again = store.recover(U, 'free');
  assert.strictEqual(again.code, 'cooldown'); assert.strictEqual(again.status, 429);
  assert.strictEqual(again.recovery.nextAt, T0 + 30 * DAY);
  clock.t = T0 + 30 * DAY - 1;
  assert.strictEqual(store.recover(U, 'free').code, 'cooldown');
  clock.t = T0 + 30 * DAY;
  assert.ok(store.recover(U, 'free').ok);
  assert.strictEqual(store.recoveries(U).length, 2);
  ledgerOk(store, U);
});

test('pro recovery: whenever wanted (unless the admin disables it)', () => {
  const { store } = mk();
  place(store, fixture(), { stake: 1000 });
  assert.ok(store.recover(U, 'pro').ok);
  place(store, fixture(), { stake: 1000 });
  assert.ok(store.recover(U, 'pro').ok);                                                          // instantly, again
  assert.strictEqual(store.recoveryState(U, 'pro').unlimited, true);
  place(store, fixture(), { stake: 1000 });
  store.setConfig({ proRecoveryEnabled: false }, 'admin');
  assert.strictEqual(store.recover(U, 'pro').code, 'cooldown');                                   // falls back to the Free rule
  ledgerOk(store, U);
});

test('recovery can be used while predictions are pending and does not touch them', () => {
  const { store, clock } = mk({ config: { settleDelayMin: 0 } });
  const p = place(store, fixture(), { stake: 1000 }).prediction;
  assert.ok(store.recover(U, 'pro').ok);
  clock.t = T0 + 6 * HOUR + MIN_MATCH_MS;
  store.settleDue(() => finished(3, 0));
  assert.strictEqual(p.status, 'won');
  assert.strictEqual(store.walletPublic(U, 'free').balance, 2000 + 2000);
  ledgerOk(store, U);
});

test('config: validated, audited and applied to new wallets', () => {
  const { store } = mk();
  assert.deepStrictEqual(sanitizeConfig({ initialBalance: 50 }, DEFAULT_CONFIG).errors.length, 1);
  assert.strictEqual(store.setConfig({ minStake: 500, maxStake: 100 }, 'admin').ok, false);
  assert.strictEqual(store.setConfig({ dataMode: 'nope' }, 'admin').ok, false);
  assert.strictEqual(store.config.initialBalance, 2000);                                          // rejected changes leave the config untouched
  const r = store.setConfig({ initialBalance: '3000', freeRecoveryDays: 7 }, 'admin', '9.9.9.9');
  assert.ok(r.ok); assert.strictEqual(store.config.initialBalance, 3000);
  assert.strictEqual(store.walletPublic('email:new@x.com', 'free').balance, 3000);
  assert.ok(store.s.audit.some(a => a.action === 'config_change' && a.user === 'admin'));
});

test('analytics: profit curve, markets, streaks', () => {
  const { store, clock } = mk({ config: { settleDelayMin: 0 } });
  const fx = fixture();
  place(store, fx, { stake: 100 }); place(store, fx, { selection: 'away', odds: 3.5, stake: 100 }); place(store, fx, { market: 'ou25', selection: 'over', odds: 1.95, stake: 100 });
  clock.t = T0 + 7 * HOUR;
  store.settleDue(() => finished(3, 0));
  const a = store.analytics(U);
  assert.strictEqual(a.settled, 3);
  assert.strictEqual(a.profit, 100 + (-100) + (95));                                              // 3-0: 1X2 home win +100, away -100, over 2.5 win (+95)
  assert.strictEqual(a.series.length, 3);
  assert.strictEqual(a.bestStreak >= 1, true);
  assert.deepStrictEqual(store.formGuide(U).length, 3);
  const ov = store.adminOverview(() => 'free');
  assert.strictEqual(ov.totals.wallets, 1); assert.strictEqual(ov.totals.pending, 0);
});

test('prediction list filters: active vs pending vs settled', () => {
  const { store, clock } = mk({ config: { settleDelayMin: 0 } });
  place(store, fixture(), { stake: 10 });
  assert.strictEqual(store.listPredictions(U, { filter: 'pending' }).total, 1);
  assert.strictEqual(store.listPredictions(U, { filter: 'active' }).total, 0);
  clock.t = T0 + 5 * HOUR + 60000;                                                                 // kicked off, no result yet
  assert.strictEqual(store.listPredictions(U, { filter: 'active' }).total, 1);
  assert.strictEqual(store.listPredictions(U, { filter: 'all' }).items[0].phase, 'active');
});

test('idempotency keys named like Object.prototype members cannot confuse the duplicate check', () => {
  const { store } = mk(), fx = fixture();
  // "constructor" is an inherited property of every plain object: it must not be mistaken for a stored request
  const a = place(store, fx, { requestId: 'constructor' });
  assert.strictEqual(a.ok, true); assert.ok(!a.duplicate);
  const b = place(store, fx, { requestId: 'constructor' });
  assert.strictEqual(b.duplicate, true, 'a real retry with the same key is still recognised');
  assert.strictEqual(b.prediction.id, a.prediction.id);
  // "__proto__" cannot be stored as an own key: it is ignored as an idempotency key instead of silently breaking it
  const c = place(store, fx, { requestId: '__proto__' });
  assert.strictEqual(c.ok, true); assert.ok(!c.duplicate);
  assert.strictEqual(Object.getPrototypeOf(store.s.wallets[U].idem), Object.prototype, 'the idem map prototype is untouched');
  assert.strictEqual(store.s.wallets[U].openIds.length, 2);
  ledgerOk(store, U);
});
