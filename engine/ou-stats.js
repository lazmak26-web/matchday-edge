'use strict';
// Over/Under 2.5 record of the bot: the pick the server FROZE before kick-off (row.pick.ou, never touched after kick-off)
// against the real total of goals. Pure functions on plain rows, so they are easy to test.
//   Over  = 3 or more goals in total, Under = 2 or fewer (the 2.5 line cannot be a push).
const LINE = 2.5;

// 'over' | 'under' | null (null = no usable final score)
function actualOu(f) {
  if (!f || !Number.isInteger(f.homeScore) || !Number.isInteger(f.awayScore) || f.homeScore < 0 || f.awayScore < 0) return null;
  return f.homeScore + f.awayScore > LINE ? 'over' : 'under';
}
const pickOu = f => (f && f.pick && (f.pick.ou === 'over' || f.pick.ou === 'under') ? f.pick.ou : null);
const when = f => String(f.date || '') + 'T' + String(f.kickoff || '00:00');

const bucket = () => ({ n: 0, wins: 0, losses: 0, winRate: null });
function finish(b) { b.winRate = b.n ? b.wins / b.n : null; return b; } // winRate is a fraction 0..1, null when there is no pick

// rows: snapshot rows (finished or not). opts.since = 'YYYY-MM-DD' (match date, inclusive); opts.last = only the N most recent counted matches.
function summarize(rows, opts = {}) {
  const since = opts.since ? String(opts.since) : null;
  const last = Number.isInteger(opts.last) && opts.last > 0 ? opts.last : null;
  const finished = (rows || []).filter(f => f && f.status === 'finished' && actualOu(f) && (!since || String(f.date || '') >= since));
  const counted = finished.filter(pickOu).sort((a, b) => (when(b) < when(a) ? -1 : when(b) > when(a) ? 1 : 0));
  const used = last ? counted.slice(0, last) : counted;

  const overall = bucket(), over = bucket(), under = bucket(), days = new Map();
  for (const f of used) {
    const pick = pickOu(f), win = pick === actualOu(f);
    for (const b of [overall, pick === 'over' ? over : under]) { b.n++; if (win) b.wins++; else b.losses++; }
    const d = days.get(f.date) || { date: f.date, wins: 0, losses: 0 };
    if (win) d.wins++; else d.losses++;
    days.set(f.date, d);
  }
  return {
    line: LINE,
    overall: finish(overall), over: finish(over), under: finish(under),
    byDay: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    coverage: { finished: finished.length, counted: used.length } // finished matches in the period vs those that had a frozen O/U pick
  };
}

module.exports = { LINE, actualOu, summarize };
