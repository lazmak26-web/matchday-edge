'use strict';
/* Match info panel: line-ups, absences (injuries / suspensions), head-to-head and league position of both teams.

   Source: API-Football (APIFOOTBALL_KEY), the only configured provider that has line-ups and injuries for every league.
   Every call goes through apifootball.get(), which shares the daily budget with the fixtures refresh (INFO_RESERVE calls
   are kept for this panel). Everything is cached; the costly parts are only fetched while budget is left:

     part            endpoint                                   when                               cache
     fixture id      /fixtures?date=D  (whole day, shared)      once per day                       6 h (today: free)
     line-ups        /fixtures?id=F                             from 75 min before kick-off        12 h found / 8 min not yet
     absences        /injuries?fixture=F                        always                             6 h
     head-to-head    /fixtures/headtohead?h2h=A-B&last=10       always                             24 h
     table           /standings?league=L&season=S               always (shared by every match)     6 h
     team's league   /leagues?team=T&current=true               only for cups / friendlies         7 d
     changes vs last /fixtures?team=T&last=1 + /fixtures/lineups once the line-up is out, budget > 12   12 h / 7 d

   Without a key, the server passes what it already has (Bzzoiro head-to-head totals, football-data.org tables). */

const af = require('./apifootball');

const H = 3600e3, D = 24 * H;
const TTL = { lineupsFound: 12 * H, lineupsNotYet: 8 * 60e3, injuries: 6 * H, h2h: D, table: 6 * H, teamLeague: 7 * D, lastFx: 12 * H, oldLineup: 7 * D, fail: 5 * 60e3 };
const LINEUP_WINDOW_MIN = 75;      // providers publish line-ups ~60 min before kick-off
const ROTATION_MIN_BUDGET = 12;    // the "changes vs last match" comparison (4 calls) only runs above this many calls left
const MAX_KEYS = 1500;

const s = (v, max = 80) => (v == null || v === '' ? null : String(v).slice(0, max));
const n = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const img = v => (typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(v) ? v : null);
const POS = { G: 'GK', D: 'DF', M: 'MF', F: 'FW' };

/* ── pure parsers (unit-tested) ─────────────────────────────── */

function parsePlayer(x) {
  const p = (x && x.player) || {};
  if (!p.name) return null;
  return { id: n(p.id), name: s(p.name, 60), number: n(p.number), pos: POS[p.pos] || s(p.pos, 3), grid: /^\d{1,2}:\d{1,2}$/.test(p.grid || '') ? p.grid : null };
}
// lineups array (from /fixtures?id= or /fixtures/lineups) -> Map(teamId -> lineup)
function parseLineups(arr) {
  const out = new Map();
  for (const l of Array.isArray(arr) ? arr : []) {
    if (!l || !l.team || l.team.id == null) continue;
    const xi = (l.startXI || []).map(parsePlayer).filter(Boolean);
    if (!xi.length) continue;
    out.set(String(l.team.id), {
      formation: /^\d(-\d){1,4}$/.test(l.formation || '') ? l.formation : null,
      coach: l.coach && l.coach.name ? s(l.coach.name, 60) : null,
      xi, subs: (l.substitutes || []).map(parsePlayer).filter(Boolean)
    });
  }
  return out;
}
// /injuries response -> Map(teamId -> [{ name, type: 'out'|'doubt', reason }])
function parseInjuries(arr) {
  const out = new Map(), seen = new Set();
  for (const r of Array.isArray(arr) ? arr : []) {
    const p = r && r.player, t = r && r.team;
    if (!p || !p.name || !t || t.id == null) continue;
    const k = t.id + ':' + (p.id || p.name); if (seen.has(k)) continue; seen.add(k);
    const type = /question|doubt/i.test(p.type || '') ? 'doubt' : 'out';
    const list = out.get(String(t.id)) || []; out.set(String(t.id), list);
    list.push({ name: s(p.name, 60), type, reason: s(p.reason, 60) });
  }
  for (const l of out.values()) l.sort((a, b) => (a.type === b.type ? 0 : a.type === 'out' ? -1 : 1));
  return out;
}
// /fixtures/headtohead rows -> summary from the point of view of homeId (the CURRENT home team, whatever the venue was)
function parseH2H(rows, homeId, awayId) {
  const games = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const f = r && r.fixture, t = r && r.teams, g = (r && r.goals) || {};
    if (!f || !t || !t.home || !t.away) continue;
    if (!['FT', 'AET', 'PEN'].includes(String(f.status && f.status.short))) continue;
    const hs = n(g.home), as = n(g.away); if (hs == null || as == null) continue;
    games.push({ date: String(f.date || '').slice(0, 10), ts: Date.parse(f.date) || 0, league: s(r.league && r.league.name, 60), homeId: t.home.id, home: s(t.home.name, 60), away: s(t.away.name, 60), hs, as, pen: r.score && r.score.penalty && n(r.score.penalty.home) != null ? { h: n(r.score.penalty.home), a: n(r.score.penalty.away) } : null });
  }
  games.sort((a, b) => b.ts - a.ts);
  let hw = 0, dr = 0, aw = 0, hg = 0, ag = 0;
  for (const m of games) {
    const usHome = String(m.homeId) === String(homeId);
    const our = usHome ? m.hs : m.as, their = usHome ? m.as : m.hs;
    hg += our; ag += their;
    if (our > their) hw++; else if (our < their) aw++; else dr++;
  }
  return { total: games.length, homeWins: hw, draws: dr, awayWins: aw, homeGoals: hg, awayGoals: ag, last: games.slice(0, 8).map(({ ts, homeId: _h, ...m }) => m) };
}
// /standings response -> { league, season, groups: [[row]] }
function parseTable(resp) {
  const lg = resp && resp[0] && resp[0].league;
  if (!lg || !Array.isArray(lg.standings)) return null;
  const groups = lg.standings.map(g => (Array.isArray(g) ? g : []).map(r => ({
    rank: n(r.rank), teamId: n(r.team && r.team.id), team: s(r.team && r.team.name, 60), logo: img(r.team && r.team.logo),
    pts: n(r.points), gd: n(r.goalsDiff), group: s(r.group, 40),
    p: n(r.all && r.all.played), w: n(r.all && r.all.win), d: n(r.all && r.all.draw), l: n(r.all && r.all.lose),
    gf: n(r.all && r.all.goals && r.all.goals.for), ga: n(r.all && r.all.goals && r.all.goals.against),
    form: String(r.form || '').toUpperCase().split('').filter(c => 'WDL'.includes(c)).slice(-5),
    note: s(r.description, 60)
  })).filter(r => r.rank != null && r.teamId != null)).filter(g => g.length);
  return groups.length ? { league: s(lg.name, 60), country: s(lg.country, 40), season: n(lg.season), logo: img(lg.logo), groups } : null;
}
function tableRow(table, teamId) {
  if (!table) return null;
  for (const g of table.groups) {
    const r = g.find(x => String(x.teamId) === String(teamId));
    if (r) return Object.assign({}, r, { size: g.length, league: table.league, country: table.country, season: table.season, leagueLogo: table.logo });
  }
  return null;
}
// /leagues?team=&current=true -> the team's domestic league { id, season } (a 'League', not a cup / friendly)
function pickTeamLeague(resp) {
  const list = (Array.isArray(resp) ? resp : []).filter(x => x && x.league && x.league.type === 'League' && !/friendl/i.test(x.league.name || ''));
  const cur = x => ((x.seasons || []).find(se => se.current) || (x.seasons || []).slice(-1)[0] || {}).year;
  const top = list.sort((a, b) => a.league.id - b.league.id)[0];   // lowest id ~ top division in API-Football's numbering
  return top && cur(top) ? { id: top.league.id, season: cur(top) } : null;
}
// Starting XI now vs last match: how many players changed (null when either is missing)
function changesVs(nowXi, prevXi) {
  if (!nowXi || !prevXi || !nowXi.length || !prevXi.length) return null;
  const key = p => (p.id != null ? 'i' + p.id : 'n' + String(p.name).toLowerCase());
  const prev = new Set(prevXi.map(key));
  const out = nowXi.filter(p => !prev.has(key(p)));
  return { count: out.length, in: out.map(p => p.name).slice(0, 11) };
}
// Verdict for "is the team at full strength?"
function strength(absences, changes, lineupOut) {
  const out = (absences || []).filter(a => a.type === 'out').length, doubt = (absences || []).filter(a => a.type === 'doubt').length;
  if (changes && changes.count >= 4) return { level: 'rotated', out, doubt, changes: changes.count };
  if (out >= 3) return { level: 'weakened', out, doubt, changes: changes ? changes.count : null };
  if (out === 0 && doubt === 0 && (!changes || changes.count <= 1)) return { level: lineupOut || absences ? 'full' : 'unknown', out, doubt, changes: changes ? changes.count : null };
  return { level: 'mostly', out, doubt, changes: changes ? changes.count : null };
}

/* ── cache + fetching ───────────────────────────────────────── */

const cache = new Map();          // key -> { ts, ttl, ok, data }
const inflight = new Map();
function trim() { if (cache.size > MAX_KEYS) for (const k of [...cache.keys()].slice(0, cache.size - MAX_KEYS)) cache.delete(k); }
async function cached(key, ttlOf, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.ts < (c.ok ? c.ttl : TTL.fail)) return c.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try { const data = await fn(); cache.set(key, { ts: Date.now(), ttl: ttlOf(data), ok: true, data }); trim(); return data; }
    catch (e) { cache.set(key, { ts: Date.now(), ttl: 0, ok: false, data: c ? c.data : null }); return c ? c.data : null; }   // quota / network: keep the old answer
    finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}
const budgetLeft = () => { const st = af.status(); const a = st.maxPerDay - st.requestsToday; return st.remaining == null ? a : Math.min(a, st.remaining); };

const fxDetail = (fid, live) => cached('fx:' + fid, d => (d && d.lineups && d.lineups.size ? (live ? 10 * 60e3 : TTL.lineupsFound) : TTL.lineupsNotYet), async () => {
  const d = await af.get(`/fixtures?id=${fid}`);
  const r = d.response && d.response[0];
  return { lineups: parseLineups(r && r.lineups), venue: s(r && r.fixture && r.fixture.venue && r.fixture.venue.name), referee: s(r && r.fixture && r.fixture.referee, 60), round: s(r && r.league && r.league.round, 60) };
});
const injuries = fid => cached('inj:' + fid, () => TTL.injuries, async () => parseInjuries((await af.get(`/injuries?fixture=${fid}`)).response));
const h2hRows = (a, b) => { const [x, y] = [a, b].map(Number).sort((p, q) => p - q); return cached(`h2h:${x}-${y}`, () => TTL.h2h, async () => (await af.get(`/fixtures/headtohead?h2h=${x}-${y}&last=10`)).response || []); };
const table = (lid, season) => cached(`tbl:${lid}:${season}`, () => TTL.table, async () => parseTable((await af.get(`/standings?league=${lid}&season=${season}`)).response));
const teamLeague = tid => cached('tlg:' + tid, () => TTL.teamLeague, async () => pickTeamLeague((await af.get(`/leagues?team=${tid}&current=true`)).response));
const prevLineup = (tid, beforeTs) => cached(`prev:${tid}:${new Date(beforeTs).toISOString().slice(0, 10)}`, () => TTL.lastFx, async () => {
  const last = (await af.get(`/fixtures?team=${tid}&last=2`)).response || [];
  const prev = last.filter(r => r.fixture && Date.parse(r.fixture.date) < beforeTs - 2 * H).sort((a, b) => Date.parse(b.fixture.date) - Date.parse(a.fixture.date))[0];
  if (!prev) return null;
  const lu = await cached('lu:' + prev.fixture.id, () => TTL.oldLineup, async () => parseLineups((await af.get(`/fixtures/lineups?fixture=${prev.fixture.id}`)).response));
  const mine = lu && lu.get(String(tid));
  return mine ? { xi: mine.xi, date: String(prev.fixture.date).slice(0, 10), vs: s(String(prev.teams.home.id) === String(tid) ? prev.teams.away.name : prev.teams.home.name, 60) } : null;
});

async function standingFor(teamId, fxLeague) {
  if (fxLeague && fxLeague.id != null && fxLeague.season != null && !/friendl|cup|copa|coupe|pokal|coppa|taça|trophy|shield|super/i.test(fxLeague.name || '')) {
    const row = tableRow(await table(fxLeague.id, fxLeague.season), teamId);
    if (row) return row;
  }
  const tl = await teamLeague(teamId);
  return tl ? tableRow(await table(tl.id, tl.season), teamId) : null;
}

/* fx: the server's fixture ({ id, home, away, date, kickoff, status, h2h }).
   match(a, b): team-name matcher. fallback: { standings: { home, away } } from football-data.org when the key is missing. */
async function getMatchInfo(fx, { match, fallback = {} } = {}) {
  const koIso = `${fx.date}T${fx.kickoff || '12:00'}:00Z`, koMs = Date.parse(koIso);
  const base = {
    id: fx.id, kickoff: koIso, status: fx.status,
    home: { name: fx.home.name, logo: fx.home.logo || null, form: fx.home.form || null },
    away: { name: fx.away.name, logo: fx.away.logo || null, form: fx.away.form || null },
    source: af.enabled() ? 'api-football' : 'basic'
  };
  const bzz = fx.h2h && n(fx.h2h.total_matches) > 0 ? {
    total: n(fx.h2h.total_matches), homeWins: n(fx.h2h.home_wins), draws: n(fx.h2h.draws), awayWins: n(fx.h2h.away_wins),
    homeGoals: n(fx.h2h.home_goals), awayGoals: n(fx.h2h.away_goals), last: []
  } : null;

  if (!af.enabled()) {
    return Object.assign(base, {
      h2h: bzz, lineups: { status: 'unavailable' }, absences: null,
      home: Object.assign(base.home, { standing: fallback.standings && fallback.standings.home || null, strength: null }),
      away: Object.assign(base.away, { standing: fallback.standings && fallback.standings.away || null, strength: null })
    });
  }

  const afId = /^af_\d+$/.test(fx.id) ? fx.id.slice(3) : null;
  const row = await af.findFixture({ afId, home: fx.home.name, away: fx.away.name, kickoffIso: koIso }, match).catch(() => null);
  if (!row || row.home.id == null || row.away.id == null) {
    return Object.assign(base, {
      found: false, h2h: bzz, lineups: { status: 'unavailable' }, absences: null,
      home: Object.assign(base.home, { standing: fallback.standings && fallback.standings.home || null }),
      away: Object.assign(base.away, { standing: fallback.standings && fallback.standings.away || null })
    });
  }
  const hid = row.home.id, aid = row.away.id, fid = row.fid;
  const minsToKo = (row.ts - Date.now()) / 60e3;
  const started = fx.status === 'started' || fx.status === 'finished' || minsToKo <= 0;
  const live = fx.status === 'started';
  const wantLineups = minsToKo <= LINEUP_WINDOW_MIN;

  // most important first: line-ups and absences, then head-to-head, then the tables
  const [det, inj, h2r] = await Promise.all([
    wantLineups ? fxDetail(fid, live) : Promise.resolve(null),
    injuries(fid),
    h2hRows(hid, aid)
  ]);
  const [sh, sa] = await Promise.all([standingFor(hid, row.league), standingFor(aid, row.league)]);

  const lus = det && det.lineups;
  const luH = lus && lus.get(String(hid)), luA = lus && lus.get(String(aid));
  let prevH = null, prevA = null;
  if (luH && luA && budgetLeft() > ROTATION_MIN_BUDGET) [prevH, prevA] = await Promise.all([prevLineup(hid, row.ts), prevLineup(aid, row.ts)]);
  const chH = changesVs(luH && luH.xi, prevH && prevH.xi), chA = changesVs(luA && luA.xi, prevA && prevA.xi);
  const absH = inj ? inj.get(String(hid)) || [] : null, absA = inj ? inj.get(String(aid)) || [] : null;
  const h2h = h2r ? parseH2H(h2r, hid, aid) : bzz;

  return Object.assign(base, {
    found: true,
    league: { name: row.league.name, country: row.league.country, round: (det && det.round) || row.league.round },
    venue: (det && det.venue) || row.venue, referee: (det && det.referee) || row.referee,
    lineups: luH || luA
      ? { status: 'confirmed', home: luH || null, away: luA || null }
      : { status: started ? 'unavailable' : 'not_yet', expectedFrom: new Date(row.ts - 60 * 60e3).toISOString() },
    absences: inj ? { home: absH, away: absA } : null,
    h2h: h2h && h2h.total ? h2h : bzz,
    home: Object.assign(base.home, { logo: base.home.logo || row.home.logo, standing: sh || (fallback.standings && fallback.standings.home) || null, changes: chH, prev: prevH ? { date: prevH.date, vs: prevH.vs } : null, strength: strength(absH, chH, !!luH) }),
    away: Object.assign(base.away, { logo: base.away.logo || row.away.logo, standing: sa || (fallback.standings && fallback.standings.away) || null, changes: chA, prev: prevA ? { date: prevA.date, vs: prevA.vs } : null, strength: strength(absA, chA, !!luA) }),
    budget: budgetLeft()
  });
}

// Lineups are Maps inside the cache: (de)serialise for the disk copy.
function dump() {
  const enc = v => (v instanceof Map ? { __map: [...v.entries()].map(([k, x]) => [k, enc(x)]) } : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) : v);
  return [...cache.entries()].filter(([, v]) => v.ok).map(([k, v]) => [k, { ts: v.ts, ttl: v.ttl, ok: true, data: enc(v.data) }]);
}
function load(arr) {
  const dec = v => (v && typeof v === 'object' && !Array.isArray(v) ? (Array.isArray(v.__map) ? new Map(v.__map.map(([k, x]) => [k, dec(x)])) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]))) : v);
  let i = 0;
  for (const e of Array.isArray(arr) ? arr : []) if (Array.isArray(e) && typeof e[0] === 'string' && e[1] && typeof e[1].ts === 'number') { cache.set(e[0], Object.assign({}, e[1], { data: dec(e[1].data) })); i++; }
  return i;
}

module.exports = { getMatchInfo, parseLineups, parseInjuries, parseH2H, parseTable, tableRow, pickTeamLeague, changesVs, strength, dump, load, _cache: cache };
