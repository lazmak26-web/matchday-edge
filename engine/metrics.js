'use strict';
// Evaluation metrics. All functions take plain arrays, so they are easy to test.
const EPS = 1e-12;
const IDX = { home: 0, draw: 1, away: 2 };

// preds: [{p:{h,d,a}, outcome:'home'|'draw'|'away'}]
function brier(preds) {
  if (!preds.length) return null;
  return preds.reduce((s, x) => {
    if (!(x.outcome in IDX)) throw new RangeError('unknown outcome ' + x.outcome);
    const o = [0, 0, 0]; o[IDX[x.outcome]] = 1; const p = [x.p.h, x.p.d, x.p.a];
    return s + p.reduce((q, pi, i) => q + (pi - o[i]) ** 2, 0);
  }, 0) / preds.length;
}
function logLoss(preds) {
  if (!preds.length) return null;
  return preds.reduce((s, x) => s - Math.log(Math.max(EPS, [x.p.h, x.p.d, x.p.a][IDX[x.outcome]])), 0) / preds.length;
}
// Reliability table for the predicted probability of the chosen/any class. bins of 0.1.
function calibration(preds, bins = 10) {
  const b = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, pSum: 0, hit: 0 }));
  for (const x of preds) for (const k of ['home', 'draw', 'away']) {
    const p = [x.p.h, x.p.d, x.p.a][IDX[k]];
    if (!Number.isFinite(p)) continue;
    const i = Math.min(bins - 1, Math.floor(p * bins));
    b[i].n++; b[i].pSum += p; b[i].hit += x.outcome === k ? 1 : 0;
  }
  const rows = b.filter(r => r.n).map(r => ({ lo: r.lo, hi: r.hi, n: r.n, predicted: r.pSum / r.n, observed: r.hit / r.n }));
  const total = rows.reduce((s, r) => s + r.n, 0);
  const ece = total ? rows.reduce((s, r) => s + r.n * Math.abs(r.predicted - r.observed), 0) / total : null;
  return { rows, ece };
}
// bets: [{odds, won:boolean, stake?}] flat stake 1 by default
function roi(bets) {
  if (!bets.length) return null;
  let staked = 0, ret = 0;
  for (const b of bets) { const s = b.stake == null ? 1 : b.stake; if (!(s > 0)) continue; staked += s; if (b.won) ret += s * b.odds; }
  return staked > 0 ? { n: bets.length, staked, profit: ret - staked, roi: (ret - staked) / staked } : null;
}
// Closing Line Value: average of (taken odds / closing fair odds - 1). Needs REAL closing odds; entries without are skipped.
function clv(bets) {
  const ok = bets.filter(b => b.closingFairProb > 0 && b.closingFairProb < 1 && b.odds > 1);
  if (!ok.length) return null;
  const v = ok.map(b => b.odds * b.closingFairProb - 1);
  return { n: ok.length, avg: v.reduce((a, c) => a + c, 0) / ok.length, positiveShare: v.filter(x => x > 0).length / ok.length };
}
module.exports = { brier, logLoss, calibration, roi, clv };
