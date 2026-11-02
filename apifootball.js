'use strict';
// API-Football (api-sports.io) pre-match odds from MANY bookmakers.
// Why: Bzzoiro gives ONE bookmaker per match, so the engine could never get a reliable market consensus
// (minBooks=2) nor line-shop the best price. More real books = a market we can trust and real edges (best price vs consensus).
// Nothing is invented: if the key is missing, the budget is spent, or a call fails, we simply return no extra books.
const BASE = 'https://v3.football.api-sports.io';

const num = x => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };
const pad = n => String(n).padStart(2, '0');
const utcDay = (d = new Date()) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Pure: API-Football `bookmakers[]` of one fixture -> [{ book, home, draw, away, over25, under25 }] (only sane prices).
function parseBooks(bookmakers) {
  const out = [];
  for (const bm of Array.isArray(bookmakers) ? bookmakers : []) {
    if (!bm || !Array.isArray(bm.bets)) continue;
    const mw = bm.bets.find(b => b && (b.id === 1 || /^match winner$/i.test(String(b.name || ''))));
    if (!mw || !Array.isArray(mw.values)) continue;
    const pick = v => { const r = mw.values.find(x => x && String(x.value).toLowerCase() === v); return r ? num(r.odd) : null; };
    const home = pick('home'), draw = pick('draw'), away = pick('away');
    if (!(home > 1 && draw > 1 && away > 1)) continue;
    const over = 1 / home + 1 / draw + 1 / away;
    if (over < 1.0 || over > 1.25) continue; // broken / stale / arbitrage-looking line: not a real price, drop it
    let over25 = null, under25 = null;
    const ou = bm.bets.find(b => b && (b.id === 5 || /^goals over\/under$/i.test(String(b.name || ''))));
    if (ou && Array.isArray(ou.values)) {
      const o = ou.values.find(x => x && /^over 2\.5$/i.test(String(x.value))), u = ou.values.find(x => x && /^under 2\.5$/i.test(String(x.value)));
      const oo = o && num(o.odd), uu = u && num(u.odd);
      if (oo > 1 && uu > 1) { over25 = oo; under25 = uu; }
    }
    out.push({ book: String(bm.name || 'bookmaker ' + bm.id), home, draw, away, over25, under25 });
  }
  return out;
}

// Pure: API-Football /teams/statistics `response` -> { gf, ga, n } = real goals scored / conceded PER GAME this season (n = games played).
// Needs >= 6 games, otherwise null (a tiny sample is exactly the noise we are trying to remove).
function parseTeamStats(r) {
  if (!r || Array.isArray(r) || typeof r !== 'object') return null;
  const played = r.fixtures && r.fixtures.played && num(r.fixtures.played.total);
  const gf = r.goals && r.goals.for && r.goals.for.total && num(r.goals.for.total.total);
  const ga = r.goals && r.goals.against && r.goals.against.total && num(r.goals.against.total.total);
  if (!(played >= 6) || gf == null || ga == null || gf < 0 || ga < 0) return null;
  return { gf: gf / played, ga: ga / played, n: played };
}

function create(cfg = {}) {
  const key = cfg.key;
  const fuzzy = cfg.teamsFuzzyMatch || ((a, b) => String(a).toLowerCase() === String(b).toLowerCase());
  const onUpdate = cfg.onUpdate || (() => {});
  const doFetch = cfg.fetchImpl || fetch;
  const log = cfg.log || (m => console.error(m));
  const budget = cfg.dailyBudget > 0 ? cfg.dailyBudget : 90; // free plan = 100 requests/day
  const maxPages = cfg.maxPages > 0 ? cfg.maxPages : 6;
  const statsBudget = cfg.statsBudget > 0 ? cfg.statsBudget : 35; // part of the daily budget reserved for season stats
  const ttl = cfg.ttlMs > 0 ? cfg.ttlMs : 3 * 60 * 60 * 1000;
  const STATS_TTL = 24 * 60 * 60 * 1000, STATS_MISS_TTL = 60 * 60 * 1000;
  const statsCache = new Map();
  const retryMs = 10 * 60 * 1000;
  const st = { day: null, used: 0, statsUsed: 0, statsInProgress: null, ts: 0, entries: [], fixtures: null, fixturesTs: 0, inProgress: null, lastError: null, lastPages: 0 };

  const roll = () => { const d = utcDay(); if (st.day !== d) { st.day = d; st.used = 0; st.statsUsed = 0; st.entries = []; st.fixtures = null; st.ts = 0; } };
  const enabled = () => !!key;

  async function call(path) {
    if (st.used >= budget) throw new Error('API-Football daily budget reached');
    st.used++;
    const r = await doFetch(BASE + path, { headers: { 'x-apisports-key': key, Accept: 'application/json' } });
    if (!r.ok) throw new Error('API-Football HTTP ' + r.status);
    const data = await r.json();
    const e = data && data.errors, hasErr = Array.isArray(e) ? e.length > 0 : e && typeof e === 'object' && Object.keys(e).length > 0;
    if (hasErr) throw new Error('API-Football: ' + JSON.stringify(e).slice(0, 160)); // plan limits / bad key come back as HTTP 200 + errors
    return data;
  }

  async function loadFixtures(day) {
    if (st.fixtures && Date.now() - st.fixturesTs < 6 * 60 * 60 * 1000) return st.fixtures;
    const data = await call('/fixtures?date=' + day);
    const m = new Map();
    for (const it of data.response || []) {
      const id = it && it.fixture && it.fixture.id, s = it && it.fixture && it.fixture.status && it.fixture.status.short;
      if (!id || !it.teams || !it.teams.home || !it.teams.away) continue;
      if (s && s !== 'NS' && s !== 'TBD') continue; // pre-match odds only
      m.set(id, { home: it.teams.home.name, away: it.teams.away.name, t: new Date(it.fixture.date).getTime(),
        homeId: it.teams.home.id, awayId: it.teams.away.id, leagueId: it.league && it.league.id, season: it.league && it.league.season });
    }
    st.fixtures = m; st.fixturesTs = Date.now();
    return m;
  }

  async function doRefresh() {
    roll();
    const day = st.day;
    try {
      const fx = await loadFixtures(day);
      const entries = [];
      let page = 1, total = 1;
      while (page <= total && page <= maxPages) {
        const data = await call('/odds?date=' + day + '&page=' + page);
        total = (data.paging && Number(data.paging.total)) || 1;
        for (const it of data.response || []) {
          const meta = it && it.fixture && fx.get(it.fixture.id);
          if (!meta) continue;
          const books = parseBooks(it.bookmakers);
          if (books.length) entries.push({ home: meta.home, away: meta.away, t: meta.t, books });
        }
        st.lastPages = page; page++;
      }
      if (entries.length) { st.entries = entries; st.ts = Date.now(); st.lastError = null; }
      else st.ts = Date.now() - ttl + retryMs; // nothing usable: retry soon, keep old data
    } catch (e) {
      st.lastError = e.message; st.ts = Date.now() - ttl + retryMs; // keep what we had, retry later
      log(e.message);
    } finally { st.inProgress = null; onUpdate(); }
  }

  // Starts a refresh when due (once at a time). Returns the running promise, or null when nothing to do.
  function ensure() {
    if (!enabled()) return null;
    roll();
    if (st.inProgress) return st.inProgress;
    if (Date.now() - st.ts < ttl || st.used >= budget) return null;
    st.inProgress = doRefresh();
    return st.inProgress;
  }

  // Real extra bookmaker lines for a match (same teams, kickoff within 3h), or [].
  function lookup(home, away, kickoffMs) {
    for (const e of st.entries) {
      if (!fuzzy(home, e.home) || !fuzzy(away, e.away)) continue;
      if (Number.isFinite(kickoffMs) && Number.isFinite(e.t) && Math.abs(kickoffMs - e.t) > 3 * 60 * 60 * 1000) continue;
      return e.books;
    }
    return [];
  }

  function findFixture(home, away, kickoffMs) {
    if (!st.fixtures) return null;
    for (const m of st.fixtures.values()) {
      if (!fuzzy(home, m.home) || !fuzzy(away, m.away)) continue;
      if (Number.isFinite(kickoffMs) && Number.isFinite(m.t) && Math.abs(kickoffMs - m.t) > 3 * 60 * 60 * 1000) continue;
      return m;
    }
    return null;
  }

  // Season goals-per-game for the teams of the given upcoming matches ([{home, away, t}]). Cached 24h per team; stops at its own daily cap.
  function ensureStats(list) {
    if (!enabled()) return null;
    roll();
    if (st.statsInProgress) return st.statsInProgress;
    st.statsInProgress = (async () => {
      let changed = false;
      try {
        await loadFixtures(st.day);
        const need = new Map();
        for (const q of list || []) {
          const m = findFixture(q.home, q.away, q.t);
          if (!m || !m.leagueId || !m.season) continue;
          for (const tid of [m.homeId, m.awayId]) {
            if (!tid) continue;
            const k = m.leagueId + ':' + m.season + ':' + tid, c = statsCache.get(k);
            if (!c || Date.now() - c.ts > (c.data ? STATS_TTL : STATS_MISS_TTL)) need.set(k, { leagueId: m.leagueId, season: m.season, teamId: tid });
          }
        }
        const queue = [...need];
        const worker = async () => {
          while (queue.length) {
            if (st.statsUsed >= statsBudget || st.used >= budget) { queue.length = 0; break; }
            const [k, q] = queue.shift();
            st.statsUsed++;
            try {
              const data = await call('/teams/statistics?league=' + q.leagueId + '&season=' + q.season + '&team=' + q.teamId);
              statsCache.set(k, { data: parseTeamStats(data.response), ts: Date.now() }); changed = true;
            } catch (e) { st.lastError = e.message; statsCache.set(k, { data: null, ts: Date.now() }); log(e.message); }
          }
        };
        await Promise.all([worker(), worker()]);
      } catch (e) { st.lastError = e.message; log(e.message); }
      finally { st.statsInProgress = null; if (changed) onUpdate(); }
    })();
    return st.statsInProgress;
  }

  // { home: {gf, ga, n}, away: {gf, ga, n} } when BOTH teams have real season stats cached, else null.
  function statsFor(home, away, kickoffMs) {
    const m = findFixture(home, away, kickoffMs);
    if (!m) return null;
    const g = tid => { const c = statsCache.get(m.leagueId + ':' + m.season + ':' + tid); return c && c.data ? c.data : null; };
    const h = g(m.homeId), a = g(m.awayId);
    return h && a ? { home: h, away: a } : null;
  }

  return { enabled, ensure, ensureStats, statsFor, lookup, stats: () => ({ enabled: enabled(), used: st.used, budget, statsUsed: st.statsUsed, statsBudget, teamsWithStats: [...statsCache.values()].filter(c => c.data).length, matches: st.entries.length, pages: st.lastPages, lastError: st.lastError, at: st.ts ? new Date(st.ts).toISOString() : null }) };
}

module.exports = { create, parseBooks, parseTeamStats };
