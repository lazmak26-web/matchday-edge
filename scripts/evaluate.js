'use strict';
// Evaluates prediction quality on REAL finished matches in the history file. Compares model vs market baseline.
const fs = require('fs'), path = require('path');
const { predict, market } = require('../engine/prematch'), elo = require('../engine/elo'), metrics = require('../engine/metrics'), { decide } = require('../engine/decision');
const file = process.argv[2] || process.env.HISTORY_FILE || path.join(__dirname, '..', 'data', 'history.json');
if (!fs.existsSync(file)) { console.error('No history file at ' + file + ' (nothing to evaluate; nothing is invented).'); process.exit(2); }
const all = JSON.parse(fs.readFileSync(file, 'utf8'));
const fin = all.filter(f => f && f.status === 'finished' && Number.isInteger(f.homeScore) && Number.isInteger(f.awayScore));
// Same sample for every run: only matches with REAL model inputs AND real odds.
const done = fin.filter(f => { const p = predict(f, { marketWeight: 0.5 }); return p && p.sources.model && p.sources.market; });
const outcome = f => (f.homeScore > f.awayScore ? 'home' : f.homeScore === f.awayScore ? 'draw' : 'away');
function run(label, opts, pick) {
  const preds = [], bets = [], clvBets = [];
  const sorted = done.slice().sort((a, b) => String(a.date + (a.kickoff || '')).localeCompare(String(b.date + (b.kickoff || ''))));
  for (const f of sorted) {
    const book = opts.eloWeight ? elo.build(fin.filter(g => String(g.date + (g.kickoff || '')) < String(f.date + (f.kickoff || '')))) : null; // no look-ahead
    const p = predict(f, Object.assign({}, opts, { eloBook: book })); if (!p || (pick && !pick(p))) continue;
    preds.push({ p: p.p, outcome: outcome(f) });
    const d = decide(f, p, { backtest: true });
    if (d.action === 'BET') {
      bets.push({ odds: d.pick.odds, won: d.pick.key === outcome(f) });
      const cm = market(f.odds), key = { home: 'h', draw: 'd', away: 'a' }[d.pick.key];
      if (Array.isArray(f.openOdds) && f.openOdds.length && cm) {
        const o = Math.max(0, ...f.openOdds.map(b => b && b[d.pick.key] > 1 ? b[d.pick.key] : 0));
        if (o > 1) clvBets.push({ odds: o, closingFairProb: cm[key] });
      }
    }
  }
  return { label, n: preds.length, brier: metrics.brier(preds), logLoss: metrics.logLoss(preds), ece: metrics.calibration(preds).ece, bets: metrics.roi(bets), clv: metrics.clv(clvBets) };
}
const out = [run('market only (baseline)', { marketWeight: 1 }), run('blend 50/50', { marketWeight: 0.5 }), run('model only (xG)', { marketWeight: 0 }), run('blend 50/50 + Elo 20%', { marketWeight: 0.5, eloWeight: 0.2 })];
console.log('Finished matches in history:', fin.length, '| usable (real xG + real odds):', done.length);
console.table(out.map(r => ({ model: r.label, n: r.n, brier: r.brier && r.brier.toFixed(4), logLoss: r.logLoss && r.logLoss.toFixed(4), ECE: r.ece && r.ece.toFixed(4), bets: r.bets ? r.bets.n : 0, ROI: r.bets ? (r.bets.roi * 100).toFixed(1) + '%' : 'n/a', CLV: r.clv ? (r.clv.avg * 100).toFixed(1) + '% (n=' + r.clv.n + ')' : 'n/a' })));
console.log('CLV needs openOdds (stored from now on); older history rows have none, so they are skipped.');
console.log('Rule: only switch the Value Board to the engine if blend Brier < market-only Brier on enough matches.');
if (done.length < 100) console.log('WARNING: fewer than 100 finished matches; metrics are not statistically reliable.');
