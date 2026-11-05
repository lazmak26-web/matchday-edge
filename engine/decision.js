'use strict';
// BET / NO BET gate. Defaults to NO BET unless every condition holds. Reasons are always returned.
const { validate } = require('./validate');
const { upsetRisk } = require('./upset');
const oddsCore = require('./odds');
const DEFAULTS = { minEV: 0.045, minBooks: 2, maxOdds: 6, minProb: 0.12, maxGap: 0.2, maxEV: 0.15 };

// Best real bookmaker price per outcome. One stale/wrong price must not create a fake edge: ignore prices > 25% above the median (3+ books) or above the lower of 2 books.
function bestPrices(fx) {
  const out = {}, books = fx && Array.isArray(fx.odds) ? fx.odds : [];
  // 4+ books: statistical outlier filter (odds.js). Fewer books: the median/lower-price caps below.
  if (books.filter(b => b && b.home > 1 && b.draw > 1 && b.away > 1).length >= 4) {
    const c = oddsCore.consensus(books);
    if (c) { for (const [k, key] of [['h', 'home'], ['d', 'draw'], ['a', 'away']]) if (c.best[key]) out[k] = { key, odds: c.best[key].odds, book: c.best[key].book }; return out; }
  }
  for (const [k, key] of [['h', 'home'], ['d', 'draw'], ['a', 'away']]) {
    const vals = books.map(b => b && b[key]).filter(x => x > 1).sort((x, y) => x - y);
    const ref = vals.length >= 3 ? (vals.length % 2 ? vals[vals.length >> 1] : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2) : vals.length === 2 ? vals[0] : null;
    const cap = ref ? ref * 1.25 : Infinity;
    let o = 0, book = null; for (const b of books) if (b && b[key] > o && b[key] <= cap) { o = b[key]; book = b.book; }
    if (o > 1) out[k] = { key, odds: o, book };
  }
  return out;
}

function decide(fx, pred, opts = {}) {
  if (!fx) return { action: 'NO BET', reasons: ['no fixture'], safety: ['no fixture'], upset: null };
  const c = Object.assign({}, DEFAULTS, opts), reasons = [];
  const v = validate(pred, fx, { maxGap: c.maxGap });
  if (!v.ok) return { action: 'NO BET', reasons: v.issues, safety: v.issues, baseSafety: v.issues, upset: null };
  if (!/^model\+market/.test(pred.source)) reasons.push('needs both model and market inputs (source: ' + pred.source + ')');
  if (pred.marketBooks < c.minBooks) reasons.push('only ' + pred.marketBooks + ' bookmaker(s): market consensus not reliable');
  if (!opts.backtest && fx.status && fx.status !== 'notstarted') reasons.push('match already started');
  const nSafety = reasons.length; // everything above is a data-safety block, independent of the user's EV slider
  const pick = [], prices = bestPrices(fx);
  for (const k of ['h', 'd', 'a']) {
    const pr = prices[k];
    if (pr) pick.push({ key: pr.key, odds: pr.odds, book: pr.book, p: pred.p[k], ev: pred.p[k] * (pr.odds - 1) - (1 - pred.p[k]), kelly: oddsCore.kelly(pred.p[k], pr.odds) });
  }
  pick.sort((a, b) => b.ev - a.ev);
  const top = pick[0];
  if (!top) reasons.push('no valid odds');
  else {
    if (top.ev < c.minEV) reasons.push('edge ' + (top.ev * 100).toFixed(1) + '% below the ' + (c.minEV * 100).toFixed(1) + '% threshold');
    if (top.ev > c.maxEV) reasons.push('edge ' + (top.ev * 100).toFixed(0) + '% is too large to be credible (likely a wrong price or data error)');
    if (top.odds > c.maxOdds) reasons.push('odds ' + top.odds + ' too high (variance)');
    if (top.p < c.minProb) reasons.push('probability too low');
  }
  const upset = upsetRisk(fx, pred);
  const safety = reasons.slice(0, nSafety), baseSafety = safety.slice();   // baseSafety: data-safety blocks only (the upset block below moves with the sliders)
  if (upset && upset.risk === 'High') { const m = 'high upset risk: ' + upset.signals.join('; '); reasons.push(m); safety.push(m); }
  return reasons.length ? { action: 'NO BET', reasons, safety, baseSafety, upset, best: top || null } : { action: 'BET', pick: top, reasons: [], safety: [], baseSafety, upset, best: top };
}
module.exports = { decide, bestPrices, DEFAULTS };
