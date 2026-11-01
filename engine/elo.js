'use strict';
// Elo built only from real finished results we hold. No result history for a team => no rating (null).
const K = 20, HOME = 60;
const expected = (rh, ra) => 1 / (1 + Math.pow(10, -((rh + HOME) - ra) / 400));

function build(results) {
  const r = new Map(), n = new Map();
  const get = t => (r.has(t) ? r.get(t) : 1500);
  const sorted = results.filter(x => x && x.home && x.away && x.home.name && x.away.name && x.status === 'finished' && Number.isInteger(x.homeScore) && Number.isInteger(x.awayScore))
    .sort((a, b) => String(a.date + (a.kickoff || '')).localeCompare(String(b.date + (b.kickoff || ''))));
  for (const g of sorted) {
    const h = g.home.name, a = g.away.name, eh = expected(get(h), get(a));
    const s = g.homeScore > g.awayScore ? 1 : g.homeScore === g.awayScore ? 0.5 : 0;
    const gd = Math.abs(g.homeScore - g.awayScore), mult = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    r.set(h, get(h) + K * mult * (s - eh)); r.set(a, get(a) - K * mult * (s - eh));
    n.set(h, (n.get(h) || 0) + 1); n.set(a, (n.get(a) || 0) + 1);
  }
  return { rating: t => (r.has(t) ? r.get(t) : null), games: t => n.get(t) || 0 };
}

// Win/draw/loss from Elo (draw share shrinks as the rating gap grows).
function probs(rh, ra) {
  if (rh == null || ra == null) return null;
  const e = expected(rh, ra), d = 0.27 * Math.exp(-Math.pow((rh + HOME - ra) / 600, 2));
  const h = Math.max(0.001, e - d / 2), a = Math.max(0.001, 1 - e - d / 2), s = h + a + d;
  return { h: h / s, d: d / s, a: a / s };
}
module.exports = { build, probs, expected };
