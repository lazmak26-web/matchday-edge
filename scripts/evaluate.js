'use strict';
// Evaluates prediction quality on REAL finished matches in the history file. Compares model vs market baseline.
const fs = require('fs'), path = require('path');
const { predict } = require('../engine/prematch'), metrics = require('../engine/metrics'), { decide } = require('../engine/decision');
const file = process.argv[2] || process.env.HISTORY_FILE || path.join(__dirname, '..', 'data', 'history.json');
if (!fs.existsSync(file)) { console.error('No history file at ' + file + ' (nothing to evaluate; nothing is invented).'); process.exit(2); }
const all = JSON.parse(fs.readFileSync(file, 'utf8'));
const fin = all.filter(f => f && f.status === 'finished' && Number.isInteger(f.homeScore) && Number.isInteger(f.awayScore));
// Same sample for every run: only matches with REAL model inputs AND real odds.
const done = fin.filter(f => { const p = predict(f, { marketWeight: 0.5 }); return p && p.sources.model && p.sources.market; });
const outcome = f => (f.homeScore > f.awayScore ? 'home' : f.homeScore === f.awayScore ? 'draw' : 'away');
function run(label, opts, pick) {
  const preds = [], bets = [];
  for (const f of done) {
    const p = predict(f, opts); if (!p || (pick && !pick(p))) continue;
    preds.push({ p: p.p, outcome: outcome(f) });
    const d = decide(f, p, { backtest: true }); if (d.action === 'BET') bets.push({ odds: d.pick.odds, won: d.pick.key === outcome(f) });
  }
  return { label, n: preds.length, brier: metrics.brier(preds), logLoss: metrics.logLoss(preds), ece: metrics.calibration(preds).ece, bets: metrics.roi(bets) };
}
const out = [run('market only (baseline)', { marketWeight: 1 }), run('blend 50/50', { marketWeight: 0.5 }), run('model only (xG)', { marketWeight: 0 })];
console.log('Finished matches in history:', fin.length, '| usable (real xG + real odds):', done.length);
console.table(out.map(r => ({ model: r.label, n: r.n, brier: r.brier && r.brier.toFixed(4), logLoss: r.logLoss && r.logLoss.toFixed(4), ECE: r.ece && r.ece.toFixed(4), bets: r.bets ? r.bets.n : 0, ROI: r.bets ? (r.bets.roi * 100).toFixed(1) + '%' : 'n/a' })));
console.log('CLV: n/a (history does not store closing odds yet)');
if (done.length < 100) console.log('WARNING: fewer than 100 finished matches; metrics are not statistically reliable.');
