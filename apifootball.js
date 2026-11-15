'use strict';
/* API-Football (https://www.api-football.com, api-sports.io) as an OPTIONAL third fixtures source.

   Why: Bzzoiro and football-data.org mostly cover the big leagues. When those pause (FIFA international breaks, winter breaks)
   the site fell to 5-9 matches a day. API-Football covers ~1,000 competitions (national teams, second/third divisions,
   cups, leagues in other continents), and ONE request returns every fixture of a day.

   Quota (free plan = 100 requests/day):
     - one call per refresh (/fixtures?date=today), cached APIFOOTBALL_TTL_MIN minutes (default 20 => at most 72 calls/day)
     - hard daily cap APIFOOTBALL_MAX_CALLS_PER_DAY (default 90); the provider's own "requests remaining" header is honoured
     - no key => the module does nothing and the rest of the app is unchanged

   Only senior men's / women's first-team football is kept (youth, reserve and club friendlies are dropped), and at most
   APIFOOTBALL_MAX_MATCHES matches (default 150) are added, international and better-known competitions first. */

const KEY = process.env.APIFOOTBALL_KEY || '';
// Test-only base URL (local mock), never honoured in production.
const BASE = process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.APIFOOTBALL_BASE || '') ? process.env.APIFOOTBALL_BASE : 'https://v3.football.api-sports.io';
const TTL = Math.max(5, parseInt(process.env.APIFOOTBALL_TTL_MIN, 10) || 20) * 60 * 1000;
const MAX_DAY = Math.max(1, parseInt(process.env.APIFOOTBALL_MAX_CALLS_PER_DAY, 10) || 90);
const MAX_MATCHES = Math.max(10, parseInt(process.env.APIFOOTBALL_MAX_MATCHES, 10) || 150);
// Optional allow-list of API-Football league ids ("2,3,39,140"): when set, only those leagues are used.
const ONLY = new Set(String(process.env.APIFOOTBALL_LEAGUES || '').split(/[,\s]+/).filter(Boolean));

const cache = { day: null, ts: 0, list: [], errUntil: 0 };
const usage = { day: null, n: 0, remaining: null, lastError: null };
let inFlight = null;

const today = () => new Date().toISOString().slice(0, 10);
function roll() { const d = today(); if (usage.day !== d) { usage.day = d; usage.n = 0; } }

// API-Football short status -> the site's status vocabulary (status.js normalises the rest)
function mapStatus(short) {
  const s = String(short || '').toUpperCase();
  if (['NS', 'TBD'].includes(s)) return 'notstarted';
  if (['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP'].includes(s)) return 'inprogress';
  if (['FT', 'AET', 'PEN'].includes(s)) return 'finished';
  if (['PST', 'CANC', 'ABD', 'AWD', 'WO'].includes(s)) return 'canceled';
  return '';
}

const SKIP = /\b(u-?1\d|u-?2[0-3]|under[- ]?\d{2}|youth|junior|juniors|primavera|reserves?|res\.|academy|amateur|friendlies clubs|club friendlies|futsal|beach|esoccer|e-soccer)\b/i;
const SKIP_TEAM = /\b(u-?1\d|u-?2[0-3]|ii|b team|reserves?|youth|academy)\b/i;
const WOMEN = /\b(women|womens|w|feminin[ea]?|femenin[ao]|femminile|frauen|ladies)\b/i;

// Lower = shown first when the day has more matches than MAX_MATCHES.
function priority(fx) {
  const lg = fx.league || {};
  if (lg.country === 'World') return 0;                                    // national teams, continental club cups
  if (lg.type === 'Cup') return 2;
  return 1 + (/\b(2|3|4|ii|iii|second|third|segunda|serie [bc]|ligue 2|2\. bundesliga|championship|league one|league two)\b/i.test(lg.name || '') ? 2 : 0);
}

// Raw API rows -> the fixture shape server.js builds for its other sources (pure, unit-tested).
function toFixtures(rows, opts = {}) {
  const max = opts.max || MAX_MATCHES, only = opts.only || ONLY;
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const f = r && r.fixture, lg = r && r.league, t = r && r.teams, g = (r && r.goals) || {};
    if (!f || !lg || !t || !t.home || !t.away || !t.home.name || !t.away.name) continue;
    if (only.size && !only.has(String(lg.id))) continue;
    if (!only.size && (SKIP.test(lg.name || '') || SKIP_TEAM.test(t.home.name) || SKIP_TEAM.test(t.away.name))) continue;
    const ko = new Date(f.date);
    if (isNaN(ko.getTime())) continue;
    const status = mapStatus(f.status && f.status.short);
    if (status === 'canceled') continue;
    const fin = status === 'finished', live = status === 'inprogress';
    const hs = Number.isInteger(g.home) ? g.home : null, as = Number.isInteger(g.away) ? g.away : null;
    const league = (lg.country && lg.country !== 'World' ? lg.country + ' · ' : '') + String(lg.name || 'Football');
    out.push({
      _prio: priority(r),
      id: 'af_' + f.id,
      league: league.slice(0, 80),
      women: WOMEN.test(lg.name || '') || WOMEN.test(t.home.name) || undefined,
      date: ko.toISOString().slice(0, 10),
      kickoff: ko.toISOString().slice(11, 16),
      rawStatus: status || (f.status && f.status.long) || '',
      homeScore: fin || live ? (hs ?? 0) : 0,
      awayScore: fin || live ? (as ?? 0) : 0,
      resultPending: fin && (hs === null || as === null) ? true : undefined,
      home: { id: null, name: String(t.home.name).slice(0, 60), logo: typeof t.home.logo === 'string' && /^https:\/\//.test(t.home.logo) ? t.home.logo : null },
      away: { id: null, name: String(t.away.name).slice(0, 60), logo: typeof t.away.logo === 'string' && /^https:\/\//.test(t.away.logo) ? t.away.logo : null },
      sources: ['af']
    });
  }
  out.sort((a, b) => a._prio - b._prio || (a.date + a.kickoff).localeCompare(b.date + b.kickoff));
  return out.slice(0, max).map(x => { delete x._prio; return x; });
}

// Calls reserved for the match-info panel (lineups, injuries, head-to-head, tables): the fixtures refresh stops this many
// calls before the daily cap so a person opening a match is never starved by the background refresh.
const INFO_RESERVE = Math.max(0, Math.min(MAX_DAY - 1, parseInt(process.env.APIFOOTBALL_INFO_RESERVE, 10) || 30));

// One quota-aware GET for every API-Football call (fixtures refresh and match info share the same daily budget).
// kind 'fixtures' leaves INFO_RESERVE calls for 'info'. Throws 'quota' when the budget is spent.
async function get(pathQs, kind = 'info') {
  if (!KEY) throw new Error('API-Football is not configured');
  roll();
  const cap = kind === 'fixtures' ? MAX_DAY - INFO_RESERVE : MAX_DAY;
  if (usage.n >= cap || (usage.remaining !== null && usage.remaining <= 2)) throw new Error('quota');
  usage.n++;
  const r = await fetch(BASE + pathQs, { headers: { 'x-apisports-key': KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const rem = parseInt(r.headers.get('x-ratelimit-requests-remaining'), 10); if (Number.isFinite(rem)) usage.remaining = rem;
  if (!r.ok) throw new Error('API-Football HTTP ' + r.status);
  const data = await r.json();
  const errs = data && data.errors && (Array.isArray(data.errors) ? data.errors : Object.values(data.errors));
  if (errs && errs.length) throw new Error('API-Football: ' + String(errs[0]).slice(0, 120));
  return data;
}

/* Day index: EVERY fixture of a day (friendlies and lower leagues included, unlike toFixtures) with the ids the
   match-info calls need. Today's index is filled for free by the fixtures refresh; another day costs one call. */
const DAY_TTL = 6 * 60 * 60 * 1000;
const dayIndex = new Map();                      // 'YYYY-MM-DD' -> { ts, rows }
const dayInFlight = new Map();
function compactRows(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const f = r && r.fixture, lg = (r && r.league) || {}, t = r && r.teams;
    if (!f || f.id == null || !t || !t.home || !t.away || !t.home.name || !t.away.name) continue;
    const ts = Date.parse(f.date); if (!Number.isFinite(ts)) continue;
    out.push({
      fid: f.id, ts, short: String((f.status && f.status.short) || ''),
      venue: f.venue && f.venue.name ? String(f.venue.name).slice(0, 80) : null,
      referee: f.referee ? String(f.referee).slice(0, 60) : null,
      league: { id: lg.id ?? null, season: lg.season ?? null, name: String(lg.name || '').slice(0, 80), country: String(lg.country || '').slice(0, 40), round: lg.round ? String(lg.round).slice(0, 60) : null },
      home: { id: t.home.id ?? null, name: String(t.home.name).slice(0, 60), logo: typeof t.home.logo === 'string' && /^https:\/\//.test(t.home.logo) ? t.home.logo : null },
      away: { id: t.away.id ?? null, name: String(t.away.name).slice(0, 60), logo: typeof t.away.logo === 'string' && /^https:\/\//.test(t.away.logo) ? t.away.logo : null }
    });
  }
  return out;
}
function putDay(day, rows) {
  dayIndex.set(day, { ts: Date.now(), rows: compactRows(rows) });
  for (const k of [...dayIndex.keys()].sort().slice(0, Math.max(0, dayIndex.size - 10))) dayIndex.delete(k);   // keep 10 days
}
async function dayRows(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const c = dayIndex.get(day);
  if (c && Date.now() - c.ts < DAY_TTL) return c.rows;
  if (day === today()) { await fetchToday(); const t = dayIndex.get(day); if (t) return t.rows; }
  if (dayInFlight.has(day)) return dayInFlight.get(day);
  const p = (async () => {
    try { const d = await get(`/fixtures?date=${day}`); putDay(day, d.response); return dayIndex.get(day).rows; }
    catch (e) { usage.lastError = e.message; return c ? c.rows : []; }
    finally { dayInFlight.delete(day); }
  })();
  dayInFlight.set(day, p);
  return p;
}
// Find the API-Football fixture of a match known by team names + kick-off. match(a, b) = team-name matcher.
// A row whose kick-off is within 3 h and BOTH names match wins; else one exact name + kick-off within 20 min.
function pickFixture(rows, home, away, koMs, match) {
  const near = (r, ms) => !Number.isFinite(koMs) || Math.abs(r.ts - koMs) <= ms;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  return rows.find(r => near(r, 3 * 3600e3) && match(home, r.home.name) && match(away, r.away.name))
    || rows.find(r => near(r, 20 * 60e3) && (norm(home) === norm(r.home.name) || norm(away) === norm(r.away.name)))
    || null;
}
async function findFixture({ afId, home, away, kickoffIso }, match) {
  const koMs = Date.parse(kickoffIso);
  const day = Number.isFinite(koMs) ? new Date(koMs).toISOString().slice(0, 10) : today();
  const rows = await dayRows(day);
  if (afId != null) { const r = rows.find(x => String(x.fid) === String(afId)); if (r) return r; }
  return pickFixture(rows, home, away, koMs, match);
}

async function fetchToday() {
  if (!KEY) return [];
  const day = today();
  if (cache.day === day && Date.now() - cache.ts < TTL) return cache.list;
  const stale = cache.day === day ? cache.list : [];
  if (Date.now() < cache.errUntil) return stale;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const data = await get(`/fixtures?date=${day}`, 'fixtures');
      putDay(day, data.response);
      cache.list = toFixtures(data.response); cache.day = day; cache.ts = Date.now(); usage.lastError = null;
      console.log(`🌍 API-Football: ${cache.list.length} matches added from ${(data.response || []).length} today (request ${usage.n}/${MAX_DAY}${usage.remaining !== null ? ', ' + usage.remaining + ' left' : ''})`);
      return cache.list;
    } catch (e) {
      if (e.message !== 'quota') { usage.lastError = e.message; console.error('API-Football error:', e.message); }
      cache.errUntil = Date.now() + 10 * 60 * 1000;   // back off: never burn the daily quota retrying a failing call
      return stale;
    } finally { inFlight = null; }
  })();
  return inFlight;
}

const status = () => ({ enabled: !!KEY, requestsToday: usage.n, maxPerDay: MAX_DAY, infoReserve: INFO_RESERVE, remaining: usage.remaining, matches: cache.list.length, lastError: usage.lastError });

module.exports = { fetchToday, toFixtures, mapStatus, status, get, dayRows, findFixture, pickFixture, compactRows, enabled: () => !!KEY };
