'use strict';
// The browser re-runs the slider-dependent part of every prediction (public/reblend.js). It must give EXACTLY what the server engine
// gives when asked for that slider value directly: same probabilities, same best price, same BET / WATCH / NO BET.
const { test } = require('node:test');
const assert = require('node:assert');
const serve = require('../engine/serve');
const Reblend = require('../public/reblend.js');

let seed = 987654321; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const R = (a, b) => a + (b - a) * rnd();
const form = () => Array.from({ length: 5 }, () => 'WDL'[Math.floor(rnd() * 3)]).join('');
function fixture(i) {
  const base = [R(1.4, 4.5), R(3, 4.2), R(1.5, 6)], books = [];
  for (let b = 0, n = 1 + Math.floor(rnd() * 3); b < n; b++) books.push({ book: 'B' + b, home: +(base[0] * R(.95, 1.05)).toFixed(2), draw: +(base[1] * R(.95, 1.05)).toFixed(2), away: +(base[2] * R(.95, 1.05)).toFixed(2), over25: +R(1.6, 2.2).toFixed(2), under25: +R(1.6, 2.2).toFixed(2) });
  const team = n => ({ name: n, xgFor: R(.7, 2.6), xgAgainst: R(.7, 2.2), formN: 5, form: form(), injuries: rnd() < .2 ? 3 : 0 });
  return { id: 'f' + i, league: 'L', status: 'notstarted', xgSource: rnd() < .5 ? 'forms' : 'direct', home: team('H' + i), away: team('A' + i), odds: books };
}
const eloBook = { rating: n => 1450 + (n.length * 37 % 200), games: () => 20 };
const opts = (w, ev) => ({ marketWeight: w, eloWeight: .15, eloBook, decide: { minBooks: 1, minEV: ev, maxEV: .15 }, maxGap: .2 });
const near = (x, y) => (x == null && y == null) || Math.abs(x - y) < 1e-9;

test('moving the sliders in the browser == asking the server for that slider value (p, over, best EV, pick, tier)', () => {
  const cnt = { checked: 0, BET: 0, 'NO BET': 0, WATCH: 0, upset: 0 };
  for (let i = 0; i < 250; i++) {
    const f = fixture(i);
    for (const w1 of [0, .3, .85]) for (const w2 of [0, .25, .55, .85, 1]) for (const ev of [0, .045, .1]) {
      const sent = serve.item(f, opts(w1, ev)), truth = serve.item(f, opts(w2, ev));
      if (!sent.components) continue;
      const rb = Reblend.evaluate(sent, w2, ev);
      assert.ok(rb, 'reblend must answer when the server sent components');
      cnt.checked++; cnt[rb.tier]++;
      const where = ` (fixture ${i}, sent at ${w1}, moved to ${w2}, minEV ${ev})`;
      for (const k of ['h', 'd', 'a']) assert.ok(near(rb.p[k], truth.prediction.p[k]), 'p.' + k + where);
      assert.ok(near(rb.over, truth.prediction.over), 'over' + where);
      assert.strictEqual(rb.tier, truth.tier, 'tier' + where + ' browser: ' + rb.reasons.join(' | ') + ' / server: ' + truth.decision.reasons.join(' | '));
      if (truth.validation.ok) assert.ok(near(rb.bestEv, truth.bestEv), 'bestEv' + where);
      const key = x => (x ? x.key + ':' + x.odds : null);
      assert.strictEqual(key(rb.pick), key(truth.decision.pick), 'pick' + where);
      if (truth.decision.reasons.some(r => /upset/.test(r))) cnt.upset++;
    }
  }
  // not vacuous: all three tiers and the upset rule were really exercised
  assert.ok(cnt.BET > 50 && cnt['NO BET'] > 50 && cnt.WATCH > 50 && cnt.upset > 50, JSON.stringify(cnt));
});

test('an old payload without safetyBase / upsetStatic still works (server verdict is reused as is)', () => {
  const f = fixture(1), it = serve.item(f, opts(.85, .045));
  delete it.safetyBase; delete it.upsetStatic;
  const rb = Reblend.evaluate(it, .5, .045);
  assert.ok(rb && rb.p && ['BET', 'WATCH', 'NO BET'].includes(rb.tier));
});

test('market-only or model-only predictions are not changed by the sliders (reblend returns null)', () => {
  const f = fixture(2); f.xgSource = 'league-avg';
  assert.strictEqual(Reblend.evaluate(serve.item(f, opts(.85, .045)), .2, .045), null);
});
