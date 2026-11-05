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

  // Same rule as engine/upset.js (the server): "high upset risk" depends on the probabilities, so it MOVES with the market-weight slider.
  // The signals that do not depend on the probabilities (injuries, recent form) come from the server as it.upsetStatic.
  function highUpset(p, c, stat) {
    const fav = p.h >= p.a ? 'home' : 'away', pf = Math.max(p.h, p.a);
    if (pf < 0.5) return null;
    const sig = [];
    if (p.d >= 0.27) sig.push('high draw probability (' + (p.d * 100).toFixed(0) + '%)');
    const m = c.model, k = c.market;
    if (m && k && k[fav[0]] - m[fav[0]] > 0.08) sig.push('market rates the favourite ' + ((k[fav[0]] - m[fav[0]]) * 100).toFixed(0) + ' pts above the xG model');
    if (stat && Array.isArray(stat[fav])) sig.push.apply(sig, stat[fav]);
    return sig.length >= 3 ? 'high upset risk: ' + sig.join('; ') : null;
  }

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
    // Old payloads (no safetyBase / upsetStatic) keep the server's verdict as is.
    const exact = Array.isArray(it.safetyBase) && it.upsetStatic && !(it.validation && it.validation.ok === false);
    const top = picks[0] || null, safety = Array.isArray(exact ? it.safetyBase : it.safety) ? (exact ? it.safetyBase : it.safety).slice() : [], reasons = safety.slice();
    if (!top) reasons.push('no valid odds');
    else {
      if (top.ev < ev0) reasons.push('edge ' + (top.ev * 100).toFixed(1) + '% below the ' + (ev0 * 100).toFixed(1) + '% threshold');
      if (top.ev > maxEV) reasons.push('edge ' + (top.ev * 100).toFixed(0) + '% is too large to be credible (likely a wrong price or data error)');
      if (top.odds > maxOdds) reasons.push('odds ' + top.odds + ' too high (variance)');
      if (top.p < minProb) reasons.push('probability too low');
    }
    if (exact) { const u = highUpset(p, c, it.upsetStatic); if (u) { reasons.push(u); safety.push(u); } }
    const tier = reasons.length === 0 ? 'BET' : (safety.length ? 'NO BET' : 'WATCH');
    return { p, over, bestEv: top ? top.ev : null, tier, pick: tier === 'BET' ? top : null, reasons, safety };
  }
  return { evaluate };
});
