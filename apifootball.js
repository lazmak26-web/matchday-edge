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

async function fetchToday() {
  if (!KEY) return [];
  const day = today();
  if (cache.day === day && Date.now() - cache.ts < TTL) return cache.list;
  const stale = cache.day === day ? cache.list : [];
  if (Date.now() < cache.errUntil) return stale;
  roll();
  if (usage.n >= MAX_DAY || (usage.remaining !== null && usage.remaining <= 2)) return stale;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      usage.n++;
      const r = await fetch(`${BASE}/fixtures?date=${day}`, { headers: { 'x-apisports-key': KEY, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const rem = parseInt(r.headers.get('x-ratelimit-requests-remaining'), 10); if (Number.isFinite(rem)) usage.remaining = rem;
      if (!r.ok) throw new Error('API-Football HTTP ' + r.status);
      const data = await r.json();
      const errs = data && data.errors && (Array.isArray(data.errors) ? data.errors : Object.values(data.errors));
      if (errs && errs.length) throw new Error('API-Football: ' + String(errs[0]).slice(0, 120));
      cache.list = toFixtures(data.response); cache.day = day; cache.ts = Date.now(); usage.lastError = null;
      console.log(`🌍 API-Football: ${cache.list.length} matches added from ${(data.response || []).length} today (request ${usage.n}/${MAX_DAY}${usage.remaining !== null ? ', ' + usage.remaining + ' left' : ''})`);
      return cache.list;
    } catch (e) {
      usage.lastError = e.message;
      console.error('API-Football error:', e.message);
      cache.errUntil = Date.now() + 10 * 60 * 1000;   // back off: never burn the daily quota retrying a failing call
      return stale;
    } finally { inFlight = null; }
  })();
  return inFlight;
}

const status = () => ({ enabled: !!KEY, requestsToday: usage.n, maxPerDay: MAX_DAY, remaining: usage.remaining, matches: cache.list.length, lastError: usage.lastError });

module.exports = { fetchToday, toFixtures, mapStatus, status };
