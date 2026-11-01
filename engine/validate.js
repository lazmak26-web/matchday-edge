'use strict';
// Consistency checks on a prediction. Returns { ok, issues[] }. Never "repairs" silently.
const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t;
function validate(pred, fx) {
  const issues = [];
  if (!pred) return { ok: false, issues: ['no prediction'] };
  const { p, over, lam } = pred;
  if (!p || ![p.h, p.d, p.a].every(x => typeof x === 'number' && isFinite(x) && x >= 0 && x <= 1)) issues.push('1X2 probability out of [0,1] or not a number');
  else if (!near(p.h + p.d + p.a, 1, 1e-3)) issues.push('1X2 probabilities do not sum to 1');
  if (over != null && !(over >= 0 && over <= 1)) issues.push('over/under probability out of range');
  if (lam && (!(lam.h > 0) || !(lam.a > 0))) issues.push('expected goals not positive');
  if (pred.sources && pred.sources.model && pred.sources.market) {
    const gap = Math.max(Math.abs(pred.sources.model.h - pred.sources.market.h), Math.abs(pred.sources.model.d - pred.sources.market.d), Math.abs(pred.sources.model.a - pred.sources.market.a));
    if (gap > 0.2) issues.push('model and market disagree by more than 20 points (' + (gap * 100).toFixed(0) + ')');
  }
  if (fx && Array.isArray(fx.odds)) for (const b of fx.odds) for (const k of ['home', 'draw', 'away']) if (b[k] != null && !(b[k] > 1)) { issues.push('invalid bookmaker odds (<=1) from ' + (b.book || 'unknown')); break; }
  if (pred.live && fx && Number.isInteger(fx.homeScore) && pred.live.minute > 90 + 15) issues.push('live minute out of range');
  return { ok: issues.length === 0, issues };
}
module.exports = { validate };
