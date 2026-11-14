// League tables, top scorers and team sheets from football-data.org v4, reduced to the small shapes the UI needs.
// Pure functions only (no network), so they are covered by tests/football.test.js.
'use strict';

// Competitions on the football-data.org free plan that run a league table. Order = order shown in the app.
const LEAGUES = [
  { code: 'PL',  name: 'Premier League',        country: 'England' },
  { code: 'PD',  name: 'LaLiga',                country: 'Spain' },
  { code: 'SA',  name: 'Serie A',               country: 'Italy' },
  { code: 'BL1', name: 'Bundesliga',            country: 'Germany' },
  { code: 'FL1', name: 'Ligue 1',               country: 'France' },
  { code: 'CL',  name: 'UEFA Champions League', country: 'Europe' },
  { code: 'DED', name: 'Eredivisie',            country: 'Netherlands' },
  { code: 'PPL', name: 'Primeira Liga',         country: 'Portugal' },
  { code: 'ELC', name: 'Championship',          country: 'England' },
  { code: 'BSA', name: 'Brasileirão Série A',   country: 'Brazil' }
].map(l => ({ ...l, emblem: `https://crests.football-data.org/${l.code}.png` }));
const LEAGUE_CODES = new Set(LEAGUES.map(l => l.code));

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v, max = 120) => (v == null || v === '' ? null : String(v).slice(0, max));
// Only https image URLs from the provider reach the page (the CSP allows https images; anything else is dropped).
const img = v => (typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(v) ? v : null);
const team = t => (t ? { id: num(t.id), name: str(t.name), short: str(t.shortName) || str(t.name), tla: str(t.tla, 5), crest: img(t.crest) } : null);
// "W,D,L,W,W" (oldest -> newest on football-data) -> ['W','D','L','W','W']; anything else is dropped
const form = f => (typeof f === 'string' ? f.split(',').map(x => x.trim().toUpperCase()).filter(x => x === 'W' || x === 'D' || x === 'L').slice(-5) : []);

function meta(d) {
  const c = (d && d.competition) || {}, a = (d && d.area) || {}, s = (d && d.season) || {};
  return {
    code: str(c.code, 8), name: str(c.name), emblem: img(c.emblem),
    area: { name: str(a.name), flag: img(a.flag) },
    season: { start: str(s.startDate, 10), end: str(s.endDate, 10), matchday: num(s.currentMatchday) }
  };
}

// /competitions/{code}/standings -> { ...meta, groups: [{ name, rows: [...] }] }.
// Only the TOTAL tables are kept (HOME/AWAY splits are not shown). A cup league phase or groups give one entry per table.
function parseStandings(d) {
  const groups = [];
  for (const s of (d && d.standings) || []) {
    if (s.type && s.type !== 'TOTAL') continue;
    const rows = (s.table || []).map(r => ({
      pos: num(r.position), team: team(r.team),
      p: num(r.playedGames), w: num(r.won), d: num(r.draw), l: num(r.lost),
      gf: num(r.goalsFor), ga: num(r.goalsAgainst), gd: num(r.goalDifference), pts: num(r.points),
      form: form(r.form)
    })).filter(r => r.team && r.team.name && r.pos != null);
    if (rows.length) groups.push({ name: s.group ? String(s.group).replace(/_/g, ' ').replace(/\bGROUP\b/i, 'Group') : null, stage: str(s.stage, 40), rows });
  }
  return { ...meta(d), groups };
}

// /competitions/{code}/scorers -> top scorers
function parseScorers(d) {
  const list = ((d && d.scorers) || []).map(s => ({
    player: { id: num(s.player && s.player.id), name: str(s.player && s.player.name), nationality: str(s.player && s.player.nationality, 40) },
    team: team(s.team), goals: num(s.goals), assists: num(s.assists), penalties: num(s.penalties), played: num(s.playedMatches)
  })).filter(s => s.player.name && s.goals != null);
  return { ...meta(d), scorers: list };
}

const POS_ORDER = ['Goalkeeper', 'Defence', 'Midfield', 'Offence'];
function posGroup(p) {
  const x = String(p || '').toLowerCase();
  if (/keeper/.test(x)) return 'Goalkeeper';
  if (/midfield/.test(x)) return 'Midfield';          // before defence: "Defensive Midfield" is a midfielder
  if (/back|defen/.test(x)) return 'Defence';
  if (/forward|wing|striker|offen|attack/.test(x)) return 'Offence';
  return 'Other';
}
function ageOn(dob, now) {
  const t = Date.parse(dob); if (!Number.isFinite(t)) return null;
  const b = new Date(t), n = new Date(now);
  let a = n.getUTCFullYear() - b.getUTCFullYear();
  if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) a--;
  return a >= 14 && a <= 50 ? a : null;
}

// /teams/{id} -> club sheet with the squad grouped by position
function parseTeam(d, now = Date.now()) {
  if (!d || d.id == null) return null;
  const squad = {};
  for (const p of d.squad || []) {
    if (!p || !p.name) continue;
    const g = posGroup(p.position);
    (squad[g] = squad[g] || []).push({ id: num(p.id), name: str(p.name), position: str(p.position, 40), nationality: str(p.nationality, 40), age: ageOn(p.dateOfBirth, now) });
  }
  const groups = [...POS_ORDER, 'Other'].filter(g => squad[g]).map(g => ({ name: g, players: squad[g] }));
  const site = typeof d.website === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(d.website) ? d.website : null;
  return {
    ...team(d),
    founded: num(d.founded), venue: str(d.venue), colors: str(d.clubColors, 60), address: str(d.address, 160), website: site,
    area: { name: str(d.area && d.area.name), flag: img(d.area && d.area.flag) },
    coach: d.coach && d.coach.name ? { name: str(d.coach.name), nationality: str(d.coach.nationality, 40) } : null,
    competitions: (d.runningCompetitions || []).map(c => ({ code: str(c.code, 8), name: str(c.name), emblem: img(c.emblem) })).filter(c => c.name),
    squad: groups, squadSize: groups.reduce((n, g) => n + g.players.length, 0)
  };
}

// League card summary from a parsed table (leader + size). null-safe when the table is not loaded yet.
function summary(league, table) {
  const rows = table && table.groups && table.groups.length === 1 ? table.groups[0].rows : null;
  const top = rows && rows[0];
  return {
    code: league.code, name: (table && table.name) || league.name, country: (table && table.area && table.area.name) || league.country,
    emblem: (table && table.emblem) || league.emblem, flag: (table && table.area && table.area.flag) || null,
    season: table ? table.season : null,
    teams: rows ? rows.length : null,
    leader: top ? { name: top.team.short || top.team.name, crest: top.team.crest, pts: top.pts, p: top.p } : null,
    ready: !!table
  };
}

module.exports = { LEAGUES, LEAGUE_CODES, parseStandings, parseScorers, parseTeam, summary, posGroup, ageOn, form };
