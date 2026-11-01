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

function lambdas(fx) {
  const H = fx && fx.home, A = fx && fx.away;
  if (!H || !A) return null;
  // xG that the server filled with league averages or h2h guesses is NOT real data: refuse it.
  if (fx.xgSource === 'league-avg' || fx.xgSource === 'h2h') return null;
  if (![H.xgFor, H.xgAgainst, A.xgFor, A.xgAgainst].every(x => isNum(x) && x > 0)) return null;
  const lt = LEAGUE_AVG;
  let h = lt * HOME_ADV * (H.xgFor / lt) * (A.xgAgainst / lt);
  let a = lt / HOME_ADV * (A.xgFor / lt) * (H.xgAgainst / lt);
  return { h: clamp(h, 0.2, 4.5), a: clamp(a, 0.2, 4.5) };
}

function predict(fx, opts = {}) {
  if (!fx || !fx.home || !fx.away) return null;
  const rho = isNum(opts.rho) ? opts.rho : -0.08, w = isNum(opts.marketWeight) ? clamp(opts.marketWeight, 0, 1) : 0.5;
  const lam = lambdas(fx), mk = market(fx.odds);
  let model = null, over = null, top = null;
  if (lam) { const s = summarize(scoreMatrix(lam.h, lam.a, rho)); model = { h: s.h, d: s.d, a: s.a }; over = s.over; top = s.top; }
  let eloP = null;
  if (opts.eloBook) { eloP = elo.probs(opts.eloBook.rating(fx.home.name), opts.eloBook.rating(fx.away.name)); }
  if (!model && !mk) return null; // nothing real to predict from
  let p, source;
  if (model && mk) { p = { h: w * mk.h + (1 - w) * model.h, d: w * mk.d + (1 - w) * model.d, a: w * mk.a + (1 - w) * model.a }; source = 'model+market'; }
  else if (model) { p = model; source = 'model'; } else { p = { h: mk.h, d: mk.d, a: mk.a }; source = 'market'; }
  const s = p.h + p.d + p.a; p = { h: p.h / s, d: p.d / s, a: p.a / s };
  if (over != null && mk && mk.over != null) over = w * mk.over + (1 - w) * over; else if (over == null && mk) over = mk.over;
  return { p, over, lam, top, source, sources: { model, market: mk && { h: mk.h, d: mk.d, a: mk.a }, elo: eloP }, marketBooks: mk ? mk.n : 0, rho };
}
module.exports = { predict, lambdas, market };
