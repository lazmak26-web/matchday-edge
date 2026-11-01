'use strict';
// Upset detector: flags matches where the favourite is less safe than the market price suggests.
// Uses only real signals present on the fixture; absent signals are simply not counted.
function upsetRisk(fx, pred) {
  if (!pred) return null;
  const { p } = pred, fav = p.h >= p.a ? 'home' : 'away', pf = Math.max(p.h, p.a);
  const signals = [];
  if (pf >= 0.5) {
    if (p.d >= 0.27) signals.push('high draw probability (' + (p.d * 100).toFixed(0) + '%)');
    const m = pred.sources && pred.sources.model, k = pred.sources && pred.sources.market;
    if (m && k && k[fav[0]] - m[fav[0]] > 0.08) signals.push('market rates the favourite ' + ((k[fav[0]] - m[fav[0]]) * 100).toFixed(0) + ' pts above the xG model');
    const T = fx[fav], U = fx[fav === 'home' ? 'away' : 'home'];
    if (T && typeof T.injuries === 'number' && T.injuries >= 3) signals.push('favourite has ' + T.injuries + ' injuries');
    if (T && typeof T.form === 'string' && /L.?L/i.test(T.form.slice(-3))) signals.push('favourite lost 2 of its last 3');
    if (U && typeof U.form === 'string' && /^W{3,}/i.test(U.form.slice(-3))) signals.push('underdog won its last 3');
  }
  const risk = signals.length >= 3 ? 'High' : signals.length === 2 ? 'Medium' : signals.length === 1 ? 'Low' : 'None';
  return { favourite: pf >= 0.5 ? fav : null, signals, risk };
}
module.exports = { upsetRisk };
