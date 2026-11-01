'use strict';
const test = require('node:test'), assert = require('node:assert');
const { scoreMatrix, summarize } = require('../engine/poisson');
const { predict } = require('../engine/prematch');
const { predictLive } = require('../engine/live');
const { validate } = require('../engine/validate');
const { decide } = require('../engine/decision');
const { upsetRisk } = require('../engine/upset');
const M = require('../engine/metrics');
const elo = require('../engine/elo');

const team = (n, xf, xa, extra) => Object.assign({ name: n, xgFor: xf, xgAgainst: xa }, extra);
const book = (b, h, d, a, o, u) => ({ book: b, home: h, draw: d, away: a, over25: o, under25: u });
const fx = (H, A, odds) => ({ id: 'x', status: 'notstarted', home: H, away: A, odds });
const sum3 = p => p.h + p.d + p.a;

test('score matrix sums to 1 and probabilities sum to 1', () => {
  const s = summarize(scoreMatrix(1.5, 1.1));
  assert.ok(Math.abs(sum3(s) - 1) < 1e-9);
  assert.ok(Math.abs(s.over + s.under - 1) < 1e-9);
});
test('Dixon-Coles with negative rho raises draw probability vs independent', () => {
  const a = summarize(scoreMatrix(1.2, 1.0, -0.12)).d, b = summarize(scoreMatrix(1.2, 1.0, 0)).d;
  assert.ok(a > b);
});
test('extreme: huge favourite (4.0 vs 0.3 xG) is well-formed and dominant', () => {
  const s = summarize(scoreMatrix(4.0, 0.3));
  assert.ok(s.h > 0.9 && Math.abs(sum3(s) - 1) < 1e-9);
});
test('extreme: two defensive sides (0.4 vs 0.4) -> under, 0-0 likely', () => {
  const s = summarize(scoreMatrix(0.4, 0.4));
  assert.ok(s.under > 0.8 && s.top === '0-0');
});
test('invalid lambda throws instead of returning garbage', () => {
  assert.throws(() => scoreMatrix(0, 1)); assert.throws(() => scoreMatrix(NaN, 1));
});
test('prematch: missing xG and no odds -> null (no fabrication)', () => {
  assert.strictEqual(predict(fx(team('A'), team('B'), [])), null);
});
test('prematch: market only when xG missing', () => {
  const p = predict(fx(team('A'), team('B'), [book('b1', 2, 3.4, 3.8), book('b2', 2.05, 3.3, 3.7)]));
  assert.strictEqual(p.source, 'market'); assert.ok(Math.abs(sum3(p.p) - 1) < 1e-9);
});
test('prematch: ignores invalid odds (<=1, NaN)', () => {
  const p = predict(fx(team('A', 1.5, 1.2), team('B', 1.2, 1.4), [book('bad', 0.5, NaN, 3)]));
  assert.strictEqual(p.source, 'model');
});
test('live: leading team late is near-certain; trailing early keeps chances', () => {
  const f = fx(team('A', 1.5, 1.2), team('B', 1.2, 1.4), []);
  assert.ok(predictLive(f, { minute: 88, homeScore: 2, awayScore: 0 }).p.h > 0.99);
  assert.ok(predictLive(f, { minute: 10, homeScore: 0, awayScore: 1 }).p.h > 0.2);
});
test('live: red card lowers the penalised side', () => {
  const f = fx(team('A', 1.5, 1.2), team('B', 1.5, 1.2), []);
  const n = predictLive(f, { minute: 30, homeScore: 0, awayScore: 0 }), r = predictLive(f, { minute: 30, homeScore: 0, awayScore: 0, homeReds: 1 });
  assert.ok(r.p.h < n.p.h && r.p.a > n.p.a);
});
test('live: full time is deterministic; missing real data -> null', () => {
  const f = fx(team('A', 1.5, 1.2), team('B', 1.5, 1.2), []);
  assert.deepStrictEqual(predictLive(f, { minute: 90, homeScore: 1, awayScore: 1, finished: true }).p, { h: 0, d: 1, a: 0 });
  assert.strictEqual(predictLive(f, { minute: 30 }), null);
  assert.strictEqual(predictLive(fx(team('A'), team('B'), []), { minute: 30, homeScore: 0, awayScore: 0 }), null);
});
test('validate: catches bad sums, NaN, odds <= 1, big model/market gap', () => {
  assert.ok(!validate({ p: { h: 0.5, d: 0.5, a: 0.5 } }).ok);
  assert.ok(!validate({ p: { h: NaN, d: 0.5, a: 0.5 } }).ok);
  assert.ok(!validate({ p: { h: 0.4, d: 0.3, a: 0.3 } }, { odds: [{ home: 0.9, book: 'x' }] }).ok);
  assert.ok(!validate({ p: { h: 0.4, d: 0.3, a: 0.3 }, sources: { model: { h: 0.8, d: 0.1, a: 0.1 }, market: { h: 0.4, d: 0.3, a: 0.3 } } }).ok);
});
test('decision: NO BET when only one bookmaker, started match, or no edge', () => {
  const H = team('A', 1.8, 1.0), A = team('B', 1.0, 1.6);
  const one = fx(H, A, [book('b1', 1.9, 3.5, 4.2)]);
  assert.strictEqual(decide(one, predict(one)).action, 'NO BET');
  const live = Object.assign(fx(H, A, [book('b1', 1.9, 3.5, 4.2), book('b2', 1.9, 3.5, 4.2)]), { status: 'inplay' });
  assert.strictEqual(decide(live, predict(live)).action, 'NO BET');
  assert.strictEqual(decide(fx(team('A'), team('B'), []), null).action, 'NO BET');
});
test('decision: BET when model sees real edge with 2+ books', () => {
  const f = fx(team('A', 1.5, 1.2), team('B', 1.2, 1.4), [book('b1', 2.0, 3.5, 4.0), book('b2', 2.1, 3.4, 3.9)]);
  const d = decide(f, predict(f, { marketWeight: 0.3 }));
  assert.strictEqual(d.action, 'BET'); assert.strictEqual(d.pick.key, 'home');
});
test('upset: flags a shaky favourite, none for a clean one', () => {
  const f = fx(team('A', 2, 0.9, { form: 'WLLWW', injuries: 4 }), team('B', 1, 1.5, { form: 'WWW' }), []);
  const u = upsetRisk(f, { p: { h: 0.55, d: 0.28, a: 0.17 } });
  assert.ok(u.signals.length >= 3 && u.risk === 'High');
  assert.strictEqual(upsetRisk(fx(team('A'), team('B'), []), { p: { h: 0.6, d: 0.2, a: 0.2 } }).risk, 'None');
});
test('metrics: perfect and uniform predictions', () => {
  const perfect = [{ p: { h: 1, d: 0, a: 0 }, outcome: 'home' }];
  assert.ok(M.brier(perfect) < 1e-12 && M.logLoss(perfect) < 1e-9);
  const u = [{ p: { h: 1 / 3, d: 1 / 3, a: 1 / 3 }, outcome: 'draw' }];
  assert.ok(Math.abs(M.brier(u) - 2 / 3) < 1e-9 && Math.abs(M.logLoss(u) - Math.log(3)) < 1e-9);
  assert.strictEqual(M.brier([]), null);
});
test('metrics: ROI and CLV skip missing data instead of inventing it', () => {
  assert.strictEqual(M.roi([{ odds: 2, won: true }, { odds: 3, won: false }]).profit, 0);
  assert.strictEqual(M.clv([{ odds: 2 }]), null);
  assert.ok(Math.abs(M.clv([{ odds: 2.1, closingFairProb: 0.5 }]).avg - 0.05) < 1e-9);
});
test('elo: no history -> null rating; winner gains', () => {
  const b = elo.build([{ status: 'finished', date: '2026-01-01', home: { name: 'A' }, away: { name: 'B' }, homeScore: 2, awayScore: 0 }]);
  assert.strictEqual(b.rating('Z'), null); assert.ok(b.rating('A') > 1500 && b.rating('B') < 1500);
  assert.strictEqual(elo.probs(null, 1500), null);
});
test('prematch: xG invented by the server (league-avg / h2h) is refused, not used', () => {
  for (const src of ['league-avg', 'h2h']) {
    const f = Object.assign(fx(team('A', 1.4, 1.2), team('B', 1.2, 1.4), []), { xgSource: src });
    assert.strictEqual(predict(f), null);
  }
  assert.strictEqual(predict(fx(team('A', 0, 1), team('B', 1, 1), [])), null); // zero xG is not clamped into a fake 0.2
});
test('robustness: non-array odds, null fixture, bad rho, NaN in calibration', () => {
  assert.strictEqual(predict(fx(team('A'), team('B'), 'oops')), null);
  assert.strictEqual(decide(null, null).action, 'NO BET');
  assert.throws(() => scoreMatrix(1, 1, -5));
  assert.doesNotThrow(() => M.calibration([{ p: { h: NaN, d: 0.5, a: 0.5 }, outcome: 'draw' }]));
  assert.throws(() => M.brier([{ p: { h: 1, d: 0, a: 0 }, outcome: 'Home' }]));
  assert.strictEqual(M.roi([{ odds: 2, won: true, stake: 0 }]), null);
});
test('live: minute 90 is stoppage (not certain) until the feed says finished; reds are capped', () => {
  const f = fx(team('A', 1.5, 1.2), team('B', 1.5, 1.2), []);
  const p90 = predictLive(f, { minute: 90, homeScore: 1, awayScore: 0 });
  assert.ok(p90.p.h < 1 && p90.p.h > 0.9);
  assert.deepStrictEqual(predictLive(f, { minute: 90, homeScore: 1, awayScore: 0, finished: true }).p, { h: 1, d: 0, a: 0 });
  const r3 = predictLive(f, { minute: 30, homeScore: 0, awayScore: 0, homeReds: 3 }), r9 = predictLive(f, { minute: 30, homeScore: 0, awayScore: 0, homeReds: 9 });
  assert.deepStrictEqual(r3.p, r9.p);
});
test('decision: backtest option lets finished fixtures be evaluated', () => {
  const f = Object.assign(fx(team('A', 1.5, 1.2), team('B', 1.2, 1.4), [book('b1', 2.0, 3.5, 4.0), book('b2', 2.1, 3.4, 3.9)]), { status: 'finished' });
  const p = predict(f, { marketWeight: 0.3 });
  assert.ok(decide(f, p).reasons.includes('match already started'));
  assert.ok(!decide(f, p, { backtest: true }).reasons.includes('match already started'));
});
test('decision: safety blocks (single book, started) are separate from edge reasons', () => {
  const H = team('A', 1.5, 1.2), A = team('B', 1.2, 1.4);
  const one = fx(H, A, [book('b1', 2.0, 3.5, 4.0)]);
  const d = decide(one, predict(one));
  assert.ok(d.safety.some(r => /bookmaker/.test(r)));
  const two = fx(H, A, [book('b1', 1.5, 4.5, 8), book('b2', 1.5, 4.5, 8)]); // no edge -> NO BET but NOT a safety block
  const e = decide(two, predict(two));
  assert.strictEqual(e.action, 'NO BET'); assert.deepStrictEqual(e.safety, []);
});

test('maxGap: model-vs-market disagreement gate is 20 points by default and configurable', () => {
  // strong home model (xG) vs a market that sees a near-even match: big disagreement
  const H = team('A', 2.2, 0.8), A = team('B', 0.9, 1.7);
  const f = fx(H, A, [book('b1', 2.6, 3.2, 2.9), book('b2', 2.6, 3.2, 2.9)]);
  const p = predict(f);
  const gap = Math.max(Math.abs(p.sources.model.h - p.sources.market.h), Math.abs(p.sources.model.d - p.sources.market.d), Math.abs(p.sources.model.a - p.sources.market.a));
  assert.ok(gap > 0.2 && gap < 0.6, 'fixture must disagree by more than 20 points, got ' + gap);
  assert.ok(validate(p, f).issues.some(i => /more than 20 points/.test(i)), 'default stays at 20');
  assert.ok(decide(f, p).safety.some(i => /more than 20 points/.test(i)));
  const wide = Math.min(0.6, Math.ceil(gap * 100 + 1) / 100);
  assert.ok(!validate(p, f, { maxGap: wide }).issues.some(i => /disagree/.test(i)), 'raised limit lets it through the validity check');
  assert.ok(!decide(f, p, { maxGap: wide }).safety.some(i => /disagree/.test(i)));
  assert.ok(validate(p, f, { maxGap: 0.1 }).issues.some(i => /more than 10 points/.test(i)), 'message shows the configured limit');
  assert.ok(validate(p, f, { maxGap: 'x' }).issues.some(i => /more than 20 points/.test(i)), 'invalid value falls back to 20');
});
