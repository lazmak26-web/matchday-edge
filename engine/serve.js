'use strict';
// One /api/engine/predictions entry. Besides the final decision it carries the raw ingredients (model, market, elo, best real prices),
// so the browser can re-run the SLIDER-dependent part (market weight, minimum EV) instantly with public/reblend.js, without a server round trip.
const pre = require('./prematch'), decision = require('./decision'), validate = require('./validate'), { staticSignals } = require('./upset');

function item(f, o = {}) {
  const pred = pre.predict(f, { marketWeight: o.marketWeight, eloWeight: o.eloWeight, eloBook: o.eloBook });
  const dec = decision.decide(f, pred, o.decide);
  const s = pred && pred.sources, b = pred && pred.blend;
  const components = s && s.model && s.market
    ? { model: s.model, market: s.market, elo: s.elo || null, eloWeight: b.eloWeight, overModel: b.overModel, overMarket: b.overMarket } : null;
  return {
    id: f.id, bestEv: dec.best ? dec.best.ev : null,
    tier: dec.action === 'BET' ? 'BET' : ((dec.safety || []).length ? 'NO BET' : 'WATCH'),
    safety: dec.safety || [], safetyBase: dec.baseSafety || dec.safety || [],
    upsetStatic: { home: staticSignals(f, 'home'), away: staticSignals(f, 'away') },
    xgSource: f.xgSource || null,
    prediction: pred && { p: pred.p, over: pred.over, over15: pred.over15 == null ? null : pred.over15, over15Source: pred.over15Source || null, top: pred.top, source: pred.source },
    validation: validate.validate(pred, f, { maxGap: o.maxGap }), decision: dec,
    components, prices: decision.bestPrices(f),
    limits: { maxOdds: decision.DEFAULTS.maxOdds, minProb: decision.DEFAULTS.minProb, maxEV: o.decide && o.decide.maxEV != null ? o.decide.maxEV : decision.DEFAULTS.maxEV }
  };
}
module.exports = { item };
