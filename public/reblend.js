'use strict';
// Re-runs the slider-dependent part of a server prediction in the browser (same maths as engine/prematch.js + engine/decision.js):
//   p = blend(market, model, marketWeight) [+ elo], EV = p * (odds - 1) - (1 - p) on the best REAL bookmaker price, tier from the safety list + EV threshold.
// The server's data-safety verdict (it.safety: source, bookmaker count, model/market gap, already started...) does not depend on the sliders and is reused as is.
// Returns null when there is nothing the sliders can change (market-only prediction, no real xG model).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Reblend = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isNum = x => typeof x === 'number' && isFinite(x);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const mix = (a, b, w) => ({ h: w * a.h + (1 - w) * b.h, d: w * a.d + (1 - w) * b.d, a: w * a.a + (1 - w) * b.a });

  function evaluate(it, marketWeight, minEV) {
    const c = it && it.components, pr = it && it.prediction;
    if (!c || !c.model || !c.market || !pr || !isNum(marketWeight)) return null;
    const w = clamp(marketWeight, 0, 1), ev0 = isNum(minEV) && minEV >= 0 ? minEV : 0;
    let p = mix(c.market, c.model, w);
    if (isNum(c.eloWeight) && c.eloWeight > 0 && c.elo) p = mix(c.elo, p, c.eloWeight);
    const sum = p.h + p.d + p.a; p = { h: p.h / sum, d: p.d / sum, a: p.a / sum };
    const over = isNum(c.overModel) && isNum(c.overMarket) ? w * c.overMarket + (1 - w) * c.overModel : pr.over;
    const lim = it.limits || {}, maxOdds = isNum(lim.maxOdds) ? lim.maxOdds : 6, minProb = isNum(lim.minProb) ? lim.minProb : 0.12, maxEV = isNum(lim.maxEV) ? lim.maxEV : 0.15;
    const picks = [];
    for (const k of ['h', 'd', 'a']) {
      const pz = it.prices && it.prices[k];
      if (pz && pz.odds > 1) picks.push({ key: pz.key, odds: pz.odds, book: pz.book, p: p[k], ev: p[k] * (pz.odds - 1) - (1 - p[k]) });
    }
    picks.sort((x, y) => y.ev - x.ev);
    const top = picks[0] || null, safety = Array.isArray(it.safety) ? it.safety.slice() : [], reasons = safety.slice();
    if (!top) reasons.push('no valid odds');
    else {
      if (top.ev < ev0) reasons.push('edge ' + (top.ev * 100).toFixed(1) + '% below the ' + (ev0 * 100).toFixed(1) + '% threshold');
      if (top.ev > maxEV) reasons.push('edge ' + (top.ev * 100).toFixed(0) + '% is too large to be credible (likely a wrong price or data error)');
      if (top.odds > maxOdds) reasons.push('odds ' + top.odds + ' too high (variance)');
      if (top.p < minProb) reasons.push('probability too low');
    }
    const tier = reasons.length === 0 ? 'BET' : (safety.length ? 'NO BET' : 'WATCH');
    return { p, over, bestEv: top ? top.ev : null, tier, pick: tier === 'BET' ? top : null, reasons, safety };
  }
  return { evaluate };
});
