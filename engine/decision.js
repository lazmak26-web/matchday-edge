'use strict';
// BET / NO BET gate. Defaults to NO BET unless every condition holds. Reasons are always returned.
const { validate } = require('./validate');
const { upsetRisk } = require('./upset');
const DEFAULTS = { minEV: 0.045, minBooks: 2, maxOdds: 6, minProb: 0.12 };

function decide(fx, pred, opts = {}) {
  if (!fx) return { action: 'NO BET', reasons: ['no fixture'], upset: null };
  const c = Object.assign({}, DEFAULTS, opts), reasons = [];
  const v = validate(pred, fx);
  if (!v.ok) return { action: 'NO BET', reasons: v.issues, upset: null };
  if (!/^model\+market/.test(pred.source)) reasons.push('needs both model and market inputs (source: ' + pred.source + ')');
  if (pred.marketBooks < c.minBooks) reasons.push('only ' + pred.marketBooks + ' bookmaker(s): market consensus not reliable');
  if (!opts.backtest && fx.status && fx.status !== 'notstarted') reasons.push('match already started');
  const mk = pred.sources.market, best = {}, pick = [];
  for (const [k, key] of [['h', 'home'], ['d', 'draw'], ['a', 'away']]) {
    let o = 0, book = null; for (const b of Array.isArray(fx.odds) ? fx.odds : []) if (b[key] > o) { o = b[key]; book = b.book; }
    if (o > 1) pick.push({ key, odds: o, book, p: pred.p[k], ev: pred.p[k] * (o - 1) - (1 - pred.p[k]) });
  }
  pick.sort((a, b) => b.ev - a.ev);
  const top = pick[0];
  if (!top) reasons.push('no valid odds');
  else {
    if (top.ev < c.minEV) reasons.push('edge ' + (top.ev * 100).toFixed(1) + '% below the ' + (c.minEV * 100).toFixed(1) + '% threshold');
    if (top.odds > c.maxOdds) reasons.push('odds ' + top.odds + ' too high (variance)');
    if (top.p < c.minProb) reasons.push('probability too low');
  }
  const upset = upsetRisk(fx, pred);
  if (upset && upset.risk === 'High') reasons.push('high upset risk: ' + upset.signals.join('; '));
  return reasons.length ? { action: 'NO BET', reasons, upset } : { action: 'BET', pick: top, reasons: [], upset };
}
module.exports = { decide, DEFAULTS };
