'use strict';
// Independent pre-match engine. Uses ONLY real inputs on the fixture; missing inputs => null, never a guess.
const { scoreMatrix, summarize } = require('./poisson');
const elo = require('./elo');
const isNum = x => typeof x === 'number' && isFinite(x);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const LEAGUE_AVG = 1.35, HOME_ADV = 1.11; // same constants as the legacy browser model

function market(odds) {
  if (!Array.isArray(odds)) return null;
  const books = odds.filter(b => b && [b.home, b.draw, b.away].every(o => isNum(o) && o > 1));
  if (!books.length) return null;
  let h = 0, d = 0, a = 0, ov = 0, nOu = 0;
  for (const b of books) { const i = [1 / b.home, 1 / b.draw, 1 / b.away], s = i[0] + i[1] + i[2]; h += i[0] / s; d += i[1] / s; a += i[2] / s; }
  for (const b of odds) if (b && isNum(b.over25) && isNum(b.under25) && b.over25 > 1 && b.under25 > 1) { ov += (1 / b.over25) / (1 / b.over25 + 1 / b.under25); nOu++; }
  const n = books.length;
  return { h: h / n, d: d / n, a: a / n, over: nOu ? ov / nOu : null, n };
}

// Raw goals of the last few matches are a very noisy estimate (5 games: one 5-0 turns a normal team into a monster).
// When the rates come from goals per game (xgSource 'forms' = recent matches, 'season' = season average) we shrink them toward the league average with k pseudo-matches:
//   rate = (goals_per_match * n + k * league_avg) / (n + k)
// Real xG ('direct') is never shrunk. No data is invented: the league average only dampens, it never replaces missing inputs.
const SHRINK_K = 6;
function shrinkRate(rate, n, k, lt) { return (rate * n + k * lt) / (n + k); }

function lambdas(fx, opts = {}) {
  const H = fx && fx.home, A = fx && fx.away;
  if (!H || !A) return null;
  // xG that the server filled with league averages or h2h guesses is NOT real data: refuse it.
  if (fx.xgSource === 'league-avg' || fx.xgSource === 'h2h') return null;
  if (![H.xgFor, H.xgAgainst, A.xgFor, A.xgAgainst].every(x => isNum(x) && x > 0)) return null;
  // Per-league goals/team/game when the server knows it from real finished results (Bulgaria is not La Liga); else the fixed constant.
  const lt = isNum(fx.leagueAvg) && fx.leagueAvg > 0.6 && fx.leagueAvg < 2.5 ? fx.leagueAvg : LEAGUE_AVG;
  let hf = H.xgFor, ha = H.xgAgainst, af = A.xgFor, aa = A.xgAgainst;
  if (fx.xgSource === 'forms' || fx.xgSource === 'season') {
    const k = isNum(opts.shrinkK) && opts.shrinkK >= 0 ? opts.shrinkK : SHRINK_K;
    const nH = isNum(H.formN) && H.formN > 0 ? H.formN : 5, nA = isNum(A.formN) && A.formN > 0 ? A.formN : 5;
    hf = shrinkRate(hf, nH, k, lt); ha = shrinkRate(ha, nH, k, lt); af = shrinkRate(af, nA, k, lt); aa = shrinkRate(aa, nA, k, lt);
  }
  let h = lt * HOME_ADV * (hf / lt) * (aa / lt);
  let a = lt / HOME_ADV * (af / lt) * (ha / lt);
  return { h: clamp(h, 0.2, 4.5), a: clamp(a, 0.2, 4.5) };
}

// No real xG? The market itself carries goal expectations: fit Poisson rates so that the 1X2 (and over 2.5) probabilities
// match the de-vigged bookmaker consensus, and read the most likely scoreline from them. Only used for the scoreline display,
// never for p / EV (those stay 'market' only, so decisions are unchanged).
const _mlCache = new Map();   // insertion order = recency (LRU, max 500)
function marketImpliedTop(mk) {
  const key = [mk.h, mk.d, mk.a, mk.over == null ? 'x' : mk.over].map(v => typeof v === 'number' ? v.toFixed(3) : v).join('|');
  if (_mlCache.has(key)) { const v = _mlCache.get(key); _mlCache.delete(key); _mlCache.set(key, v); return v; }   // LRU: a hit moves the key to the newest slot
  let best = null;
  for (let lh = 0.3; lh <= 3.5; lh += 0.1) for (let la = 0.3; la <= 3.5; la += 0.1) {
    const s = summarize(scoreMatrix(lh, la, -0.08));
    let err = (s.h - mk.h) ** 2 + (s.d - mk.d) ** 2 + (s.a - mk.a) ** 2;
    if (mk.over != null) err += (s.over - mk.over) ** 2;
    if (!best || err < best.err) best = { err, top: s.top };
  }
  const top = best ? best.top : null;
  _mlCache.set(key, top);
  while (_mlCache.size > 500) _mlCache.delete(_mlCache.keys().next().value);   // drop only the oldest entries
  return top;
}

function predict(fx, opts = {}) {
  if (!fx || !fx.home || !fx.away) return null;
  const rho = isNum(opts.rho) ? opts.rho : -0.08, w = isNum(opts.marketWeight) ? clamp(opts.marketWeight, 0, 1) : 0.5;
  const lam = lambdas(fx, opts), mk = market(fx.odds);
  let model = null, over = null, top = null;
  if (lam) { const s = summarize(scoreMatrix(lam.h, lam.a, rho)); model = { h: s.h, d: s.d, a: s.a }; over = s.over; top = s.top; }
  let eloP = null;
  if (opts.eloBook) {
    // Elo only counts when BOTH teams have enough real finished games behind their rating (default 8).
    const minG = isNum(opts.eloMinGames) ? opts.eloMinGames : 8, B = opts.eloBook;
    const enough = typeof B.games !== 'function' || (B.games(fx.home.name) >= minG && B.games(fx.away.name) >= minG);
    if (enough) eloP = elo.probs(B.rating(fx.home.name), B.rating(fx.away.name));
  }
  if (!model && !mk) return null; // nothing real to predict from
  let topSource = model ? 'model' : null;
  if (top == null && mk) { top = marketImpliedTop(mk); if (top) topSource = 'market-implied'; }
  let p, source;
  if (model && mk) { p = { h: w * mk.h + (1 - w) * model.h, d: w * mk.d + (1 - w) * model.d, a: w * mk.a + (1 - w) * model.a }; source = 'model+market'; }
  else if (model) { p = model; source = 'model'; } else { p = { h: mk.h, d: mk.d, a: mk.a }; source = 'market'; }
  // Elo is blended only when explicitly asked (opts.eloWeight > 0) AND both teams have real ratings. Default 0 until evaluate proves it helps.
  const we = isNum(opts.eloWeight) ? clamp(opts.eloWeight, 0, 0.5) : 0;
  if (we > 0 && eloP) { p = { h: (1 - we) * p.h + we * eloP.h, d: (1 - we) * p.d + we * eloP.d, a: (1 - we) * p.a + we * eloP.a }; source += '+elo'; }
  const s = p.h + p.d + p.a; p = { h: p.h / s, d: p.d / s, a: p.a / s };
  const overModel = over;
  if (over != null && mk && mk.over != null) over = w * mk.over + (1 - w) * over; else if (over == null && mk) over = mk.over;
  return { p, over, lam, top, topSource, source, sources: { model, market: mk && { h: mk.h, d: mk.d, a: mk.a }, elo: eloP }, marketBooks: mk ? mk.n : 0, rho,
    blend: { w, eloWeight: we > 0 && eloP ? we : 0, overModel, overMarket: mk ? mk.over : null } };
}
module.exports = { predict, lambdas, market, SHRINK_K };
