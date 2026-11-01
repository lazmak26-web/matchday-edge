'use strict';
// Independent live engine: remaining goals ~ Poisson over the remaining time, added to the current score.
// ASSUMPTIONS (documented, tunable): red card multipliers; scoring rate is flat over the 90 minutes.
const { scoreMatrix, summarize } = require('./poisson');
const { lambdas } = require('./prematch');
const RED_OWN = 0.75, RED_OPP = 1.25, MAX_REDS = 3, MIN_LEFT_MIN = 2; // stoppage time keeps >= 2 min until the feed says finished

function predictLive(fx, live, opts = {}) {
  if (!fx) return null;
  // live = { minute, homeScore, awayScore, homeReds, awayReds }, all from the real feed
  const ok = live && Number.isInteger(live.homeScore) && Number.isInteger(live.awayScore) && Number.isFinite(live.minute);
  if (!ok) return null;
  const lam = lambdas(fx); if (!lam) return null;
  const minute = Math.max(0, Math.min(120, live.minute)), left = (live.finished ? 0 : Math.max(MIN_LEFT_MIN, 90 - minute)) / 90;
  const hr = Math.min(MAX_REDS, Math.max(0, live.homeReds | 0)), ar = Math.min(MAX_REDS, Math.max(0, live.awayReds | 0));
  const fh = Math.pow(RED_OWN, hr) * Math.pow(RED_OPP, ar), fa = Math.pow(RED_OWN, ar) * Math.pow(RED_OPP, hr);
  const cur = { h: live.homeScore, a: live.awayScore };
  if (left === 0) { // full time: deterministic
    const r = cur.h > cur.a ? { h: 1, d: 0, a: 0 } : cur.h === cur.a ? { h: 0, d: 1, a: 0 } : { h: 0, d: 0, a: 1 };
    return { p: r, over: cur.h + cur.a > 2.5 ? 1 : 0, top: cur.h + '-' + cur.a, live: { minute, left }, lam: null, source: 'live' };
  }
  const lh = Math.max(0.001, lam.h * left * fh), la = Math.max(0.001, lam.a * left * fa);
  const s = summarize(scoreMatrix(lh, la, Number.isFinite(opts.rho) ? opts.rho : -0.08), cur);
  return { p: { h: s.h, d: s.d, a: s.a }, over: s.over, top: s.top, live: { minute, left }, lam: { h: lh, a: la }, source: 'live' };
}
module.exports = { predictLive };
