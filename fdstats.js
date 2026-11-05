// Season goals-per-game per team, from football-data.org /competitions/{code}/standings.
// Replaces the season stats that used to come from API-Football.
'use strict';

const MIN_PLAYED = 5; // below this the rate is too noisy to use

const teamKey = n => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

// standings JSON -> Map(teamKey -> { gf, ga, n, name })
function parseStandings(d) {
  const out = new Map();
  for (const s of (d && d.standings) || []) {
    if (s.type !== 'TOTAL') continue;
    for (const row of s.table || []) {
      const n = Number(row.playedGames), gf = Number(row.goalsFor), ga = Number(row.goalsAgainst);
      if (!row.team || !Number.isFinite(n) || n < MIN_PLAYED || !Number.isFinite(gf) || !Number.isFinite(ga) || gf < 0 || ga < 0) continue;
      const v = { gf: gf / n, ga: ga / n, n, name: row.team.name };
      for (const nm of [row.team.name, row.team.shortName]) { const k = teamKey(nm); if (k) out.set(k, v); }
    }
  }
  return out;
}

// maps: iterable of Map (one per competition). Exact key first, then the fuzzy matcher.
function findTeam(maps, name, fuzzy) {
  const k = teamKey(name);
  if (!k) return null;
  for (const m of maps) { const v = m.get(k); if (v) return v; }
  if (fuzzy) for (const m of maps) for (const v of m.values()) if (fuzzy(name, v.name)) return v;
  return null;
}

// { home: {gf, ga, n}, away: {...} } or null when either side is unknown
function seasonFor(maps, home, away, fuzzy) {
  const list = [...maps];
  const h = findTeam(list, home, fuzzy), a = findTeam(list, away, fuzzy);
  if (!h || !a) return null;
  return { home: { gf: h.gf, ga: h.ga, n: h.n }, away: { gf: a.gf, ga: a.ga, n: a.n } };
}

module.exports = { parseStandings, findTeam, seasonFor, teamKey, MIN_PLAYED };
