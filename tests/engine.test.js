'use strict';
const test = require('node:test'), assert = require('node:assert');
const { scoreMatrix, summarize } = require('../engine/poisson');
const { predict } = require('../engine/prematch');
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

// ---- shrinkage of noisy recent-match goals ----
const { lambdas } = require('../engine/prematch');
test('forms-based rates are shrunk toward the league average; real xG is not', () => {
  const hot = () => ({ id: 'x', status: 'notstarted', xgSource: 'forms', home: team('H', 11 / 5, 4 / 5, { formN: 5 }), away: team('A', 4 / 5, 11 / 5, { formN: 5 }), odds: [] });
  const raw = lambdas(Object.assign(hot(), { xgSource: 'direct' }));
  const shr = lambdas(hot());
  assert.ok(shr.h < raw.h && shr.a > raw.a, 'extreme form must be dampened');
  assert.ok(shr.h > 1.0, 'but a genuinely hot attack still counts');
  const more = lambdas(Object.assign(hot(), { home: team('H', 11 / 5, 4 / 5, { formN: 20 }), away: team('A', 4 / 5, 11 / 5, { formN: 20 }) }));
  assert.ok(more.h > shr.h, 'more games behind the same rate = less shrinkage');
});

test('shrinkage cuts the model/market gap that used to force NO BET', () => {
  const odds = [book('A', 2.1, 3.4, 3.5), book('B', 2.15, 3.3, 3.4)];
  const f = xs => ({ id: 'x', status: 'notstarted', xgSource: xs, home: team('H', 11 / 5, 4 / 5, { formN: 5 }), away: team('A', 4 / 5, 11 / 5, { formN: 5 }), odds });
  const gap = p => Math.max(Math.abs(p.sources.model.h - p.sources.market.h), Math.abs(p.sources.model.a - p.sources.market.a));
  assert.ok(gap(predict(f('forms'), { marketWeight: 0.7 })) < gap(predict(f('direct'), { marketWeight: 0.7 })));
});

test('elo is ignored unless both teams have enough real games', () => {
  const book8 = { rating: () => 1600, games: n => (n === 'H' ? 20 : 2) };
  const f = { id: 'x', status: 'notstarted', xgSource: 'direct', home: team('H', 1.5, 1.1), away: team('A', 1.2, 1.3), odds: [book('A', 2.1, 3.4, 3.5)] };
  const p = predict(f, { marketWeight: 0.7, eloWeight: 0.2, eloBook: book8 });
  assert.ok(!/elo/.test(p.source) && p.sources.elo === null);
});

// ---- football-data.org season stats ----
test('football-data standings: season goals per game, small samples dropped, fuzzy team lookup', () => {
  const { parseStandings, seasonFor } = require('../fdstats');
  const row = (name, played, gf, ga, short) => ({ team: { name, shortName: short || name }, playedGames: played, goalsFor: gf, goalsAgainst: ga });
  const m = parseStandings({ standings: [
    { type: 'TOTAL', table: [row('Arsenal FC', 10, 15, 9, 'Arsenal'), row('Brand New FC', 4, 8, 2), row('Chelsea FC', 10, 'x', 4)] },
    { type: 'HOME', table: [row('Arsenal FC', 5, 99, 99)] }
  ] });
  assert.deepStrictEqual({ gf: m.get('arsenalfc').gf, ga: m.get('arsenalfc').ga, n: m.get('arsenalfc').n }, { gf: 1.5, ga: 0.9, n: 10 });
  assert.strictEqual(m.has('brandnewfc'), false);
  assert.strictEqual(m.has('chelseafc'), false);
  assert.strictEqual(parseStandings(null).size, 0);
  const m2 = parseStandings({ standings: [{ type: 'TOTAL', table: [row('Everton FC', 10, 10, 10), row('Arsenal FC', 10, 15, 9, 'Arsenal')] }] });
  assert.deepStrictEqual(seasonFor([m2], 'Arsenal', 'Everton FC'), { home: { gf: 1.5, ga: 0.9, n: 10 }, away: { gf: 1, ga: 1, n: 10 } });
  assert.strictEqual(seasonFor([m2], 'Arsenal', 'Unknown United'), null);
  assert.deepStrictEqual(seasonFor([m2], 'Arsenal London', 'Everton', (a, b) => b.toLowerCase().includes(a.toLowerCase().split(' ')[0]))?.home.n, 10);
  const mk = (src, n) => ({ id: 'x', status: 'notstarted', xgSource: src, home: team('H', 2.2, 0.8, { formN: n }), away: team('A', 0.8, 2.2, { formN: n }), odds: [] });
  assert.ok(lambdas(mk('season', 30)).h > lambdas(mk('forms', 5)).h, 'season rates are shrunk less than 5-game forms');
});

test('per-league goal average changes the model; absurd values are ignored', () => {
  const base = () => ({ id: 'x', status: 'notstarted', xgSource: 'direct', home: team('H', 1.2, 1.0), away: team('A', 1.0, 1.2), odds: [] });
  const std = lambdas(base()), low = lambdas(Object.assign(base(), { leagueAvg: 1.1 })), bad = lambdas(Object.assign(base(), { leagueAvg: 9 }));
  assert.notStrictEqual(low.h, std.h);
  assert.deepStrictEqual(bad, std);
});

test('NO BET still exposes the best candidate (for the UI) but never a pick', () => {
  const f = fx(team('H', 1.4, 1.1), team('A', 1.2, 1.3), [book('A', 2.0, 3.4, 3.8)]);
  const d = decide(f, predict(f, { marketWeight: 0.7 }));
  assert.strictEqual(d.action, 'NO BET');
  assert.ok(d.best && typeof d.best.ev === 'number');
  assert.strictEqual(d.pick, undefined);
});

test('a null bookmaker entry does not crash validation or the decision', () => {
  const fx = { status: 'notstarted', odds: [null, { book: 'A', home: 2, draw: 3.4, away: 3.8 }], home: { name: 'H' }, away: { name: 'A' } };
  const pred = { p: { h: 0.45, d: 0.28, a: 0.27 }, over: null, lam: null, source: 'market', sources: { model: null, market: { h: 0.45, d: 0.28, a: 0.27 } }, marketBooks: 1 };
  assert.doesNotThrow(() => validate(pred, fx));
  assert.doesNotThrow(() => decide(fx, pred));
});

test('sliders: the browser re-run (public/reblend.js) gives exactly the server result for every slider position', () => {
  const serve = require('../engine/serve'), Reblend = require('../public/reblend');
  const mk = (over = {}) => Object.assign({ id: 1, status: 'notstarted', xgSource: 'season', league: 'L',
    home: { name: 'Alpha', xgFor: 1.5, xgAgainst: 1.1, formN: 20 }, away: { name: 'Beta', xgFor: 1.3, xgAgainst: 1.2, formN: 20 },
    odds: [{ book: 'A', home: 2.5, draw: 3.3, away: 3.0, over25: 1.9, under25: 1.95 }, { book: 'B', home: 2.7, draw: 3.25, away: 3.05, over25: 1.92, under25: 1.93 }] }, over);
  const eloBook = { rating: n => (n === 'Alpha' ? 1600 : 1500), games: () => 20 };
  let compared = 0;
  for (const [label, f, eb, ew] of [['no elo', mk(), null, 0], ['with elo', mk(), eloBook, 0.15], ['value-ish prices', mk({ odds: [{ book: 'A', home: 3.2, draw: 3.4, away: 2.6 }, { book: 'B', home: 3.1, draw: 3.5, away: 2.7 }] }), eloBook, 0.15]]) {
    const base = serve.item(f, { marketWeight: 0.7, eloWeight: ew, eloBook: eb, decide: { minEV: 0.045, minBooks: 2 }, maxGap: 0.4 });
    assert.ok(base.components, label + ': model + market present');
    for (const w of [0, 0.25, 0.5, 0.7, 1]) for (const ev of [0, 0.02, 0.045, 0.1]) {
      const want = serve.item(f, { marketWeight: w, eloWeight: ew, eloBook: eb, decide: { minEV: ev, minBooks: 2 }, maxGap: 0.4 });
      const got = Reblend.evaluate(base, w, ev);
      for (const k of ['h', 'd', 'a']) assert.ok(Math.abs(got.p[k] - want.prediction.p[k]) < 1e-9, `${label} w=${w} p.${k}`);
      assert.ok(Math.abs(got.over - want.prediction.over) < 1e-9, `${label} w=${w} over`);
      assert.strictEqual(got.bestEv == null, want.bestEv == null);
      if (want.bestEv != null) assert.ok(Math.abs(got.bestEv - want.bestEv) < 1e-9, `${label} w=${w} ev=${ev} bestEv`);
      assert.strictEqual(got.tier, want.tier, `${label} w=${w} ev=${ev} tier`);
      compared++;
    }
  }
  assert.strictEqual(compared, 60);
});

test('sliders: the EV slider really flips a price between WATCH and BET; market-only matches are not changeable', () => {
  const serve = require('../engine/serve'), Reblend = require('../public/reblend');
  const f = { id: 2, status: 'notstarted', xgSource: 'season', league: 'L',
    home: { name: 'Alpha', xgFor: 1.9, xgAgainst: 0.9, formN: 20 }, away: { name: 'Beta', xgFor: 1.0, xgAgainst: 1.5, formN: 20 },
    odds: [{ book: 'A', home: 2.2, draw: 3.6, away: 3.6 }, { book: 'B', home: 2.25, draw: 3.5, away: 3.7 }] };
  const base = serve.item(f, { marketWeight: 0.5, decide: { minEV: 0.045, minBooks: 2, maxGap: 0.4 }, maxGap: 0.4 });
  const low = Reblend.evaluate(base, 0.5, 0), high = Reblend.evaluate(base, 0.5, 0.5);
  assert.ok(low.bestEv > 0, 'there is a positive-EV price');
  assert.strictEqual(low.tier, 'BET');
  assert.strictEqual(high.tier, 'WATCH', 'a 50% threshold hides it, without being a safety block');
  assert.ok(Math.abs(Reblend.evaluate(base, 0, 0).p.h - Reblend.evaluate(base, 1, 0).p.h) > 0.01, 'market weight changes the probability');
  const marketOnly = serve.item({ id: 3, status: 'notstarted', xgSource: 'league-avg', home: { name: 'A' }, away: { name: 'B' }, odds: f.odds }, { marketWeight: 0.5, decide: { minBooks: 2 } });
  assert.strictEqual(marketOnly.components, null);
  assert.strictEqual(Reblend.evaluate(marketOnly, 0.5, 0), null);
});

// ── credibility cap: a huge "edge" from a single price is a data error, not a bet ──
test('decision: edge above maxEV is not a BET (server) and Reblend agrees (browser)', () => {
  const { decide } = require('../engine/decision'), Reblend = require('../public/reblend.js'), serve = require('../engine/serve');
  const fx = { id: 'x', status: 'notstarted', home: { name: 'A', xgFor: 1.5, xgAgainst: 1.0 }, away: { name: 'B', xgFor: 1.0, xgAgainst: 1.5 }, xgSource: 'direct',
    odds: [{ book: 'Bzzoiro', home: 6.0, draw: 3.4, away: 1.6 }] };
  const pred = require('../engine/prematch').predict(fx, { marketWeight: 0.2 });
  const d = decide(fx, pred, { minBooks: 1, maxGap: 0.6, maxEV: 0.30, maxOdds: 99 });
  assert.notEqual(d.action, 'BET');
  const it = serve.item(fx, { marketWeight: 0.2, decide: { minBooks: 1, maxGap: 0.6, maxEV: 0.30, maxOdds: 99 }, maxGap: 0.6 });
  const rb = Reblend.evaluate(it, 0.2, 0.045);
  assert.notEqual(rb.tier, 'BET');
});
test('decision: a normal 8% edge on one bookmaker is still a BET when minBooks is 1', () => {
  const { decide } = require('../engine/decision');
  const fx = { status: 'notstarted', odds: [{ book: 'Bzzoiro', home: 2.2, draw: 3.4, away: 3.6 }] };
  const pred = { p: { h: 0.49, d: 0.26, a: 0.25 }, source: 'model+market', marketBooks: 1, sources: { model: { h: 0.5, d: 0.25, a: 0.25 }, market: { h: 0.45, d: 0.28, a: 0.27 } } };
  const d = decide(fx, pred, { minBooks: 1 });
  assert.equal(d.action, 'BET');
  assert.equal(decide(fx, pred, { minBooks: 3 }).action, 'NO BET');
});
