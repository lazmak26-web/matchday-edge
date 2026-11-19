const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

const BZZOIRO_API_KEY = process.env.BZZOIRO_API_KEY;
// BZZOIRO_API_BASE may point at a local mock ONLY under NODE_ENV=test (browser/UI tests with realistic fixtures).
const BZZOIRO_API_BASE = process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1:\d+\/api$/.test(process.env.BZZOIRO_API_BASE || '') ? process.env.BZZOIRO_API_BASE : 'https://sports.bzzoiro.com/api';
// Pagination links come from the provider's response. Follow them only on the provider's own HTTPS origin: every request carries
// the BZZOIRO_API_KEY in its Authorization header, so a "next" link pointing anywhere else would hand the key to that host.
const BZZ_ORIGIN = new URL(BZZOIRO_API_BASE).origin;
function bzzNextUrl(next) {
  if (typeof next !== 'string' || !next) return null;
  try { const u = new URL(next, BZZ_ORIGIN); return u.origin === BZZ_ORIGIN ? u.toString() : null; } catch (e) { return null; }
}
/* Women's competitions. The provider names the teams without "Women" ("Real Madrid", "Athletic Club") and gives the league only as an id,
   so women's league ids are listed here. Add more with the env var WOMEN_LEAGUE_IDS="36,41,..." (comma separated). */
const WOMEN_LEAGUE_IDS = new Set(String(process.env.WOMEN_LEAGUE_IDS || '36').split(/[,\s]+/).filter(Boolean));
const isWomenFixture = f => !!f && (f.women === true || (/^League #(\d+)$/.exec(String(f.league || '')) ? WOMEN_LEAGUE_IDS.has(RegExp.$1) : false));
const oddsApi = require('./oddsapi');
const fdStats = require('./fdstats');
const football = require('./football');
const apiFootball = require('./apifootball');

/* ═══════════════════════════════════════════════════════════
   KEYAUTH CONFIG
   ═══════════════════════════════════════════════════════════ */
const KEYAUTH_NAME    = process.env.KEYAUTH_NAME;
const KEYAUTH_OWNERID = process.env.KEYAUTH_OWNERID;
const KEYAUTH_SECRET  = process.env.KEYAUTH_SECRET;
const KEYAUTH_VERSION = process.env.KEYAUTH_VERSION || "1.0";
const AUTH_CONFIGURED = !!(KEYAUTH_NAME && KEYAUTH_OWNERID && KEYAUTH_SECRET);
if (!AUTH_CONFIGURED) console.error('❌ KEYAUTH_NAME / KEYAUTH_OWNERID / KEYAUTH_SECRET are not set: login is disabled until they are.');
const MAX_SESSIONS_PER_USER = 2;
const KEYAUTH_BASE    = 'https://keyauth.win/api/1.3/';

/* ═══════════════════════════════════════════════════════════
   SESSIONS
   ═══════════════════════════════════════════════════════════ */
const SESSION_IDLE = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL = SESSION_IDLE;
const sessions = new Map();

const userFails = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of userFails) if (n - v.t > 10 * 60 * 1000) userFails.delete(k); }, 10 * 60 * 1000).unref();

const tokHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const sessionExpired = (v, now) => now - v.createdAt > SESSION_MAX || now - (v.lastSeen || v.createdAt) > SESSION_IDLE;

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function makeSaver(label, writeNow, delay) {
  let timer = null;
  const now = () => { if (timer) { clearTimeout(timer); timer = null; } try { writeNow(); } catch (e) { console.error(label + ' save error:', e.message); } };
  const soon = () => { if (!timer) timer = setTimeout(now, delay); };
  return { soon, now };
}
const SESSIONS_FILE_DEFAULT = () => path.join(path.dirname(HISTORY_FILE), 'sessions.json');
const SESSIONS_FILE = process.env.SESSIONS_FILE || null;
const sessionsPath = () => SESSIONS_FILE || SESSIONS_FILE_DEFAULT();
const sessionSaver = makeSaver('Sessions', () => writeAtomic(sessionsPath(), JSON.stringify([...sessions.entries()])), 1000);
const saveSessionsSoon = sessionSaver.soon;
function loadSessions() {
  try {
    const f = sessionsPath();
    if (!fs.existsSync(f)) return;
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    const now = Date.now();
    if (Array.isArray(arr)) for (const e of arr) {
      if (Array.isArray(e) && /^[0-9a-f]{64}$/.test(e[0]) && e[1] && e[1].username && typeof e[1].createdAt === 'number' && !sessionExpired(e[1], now)) sessions.set(e[0], e[1]);
    }
    console.log(`🔐 Restored ${sessions.size} sessions`);
  } catch (e) { console.error('Sessions load error:', e.message); }
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of sessions) if (sessionExpired(v, now)) { sessions.delete(k); changed = true; }
  if (changed) saveSessionsSoon();
}, 60 * 60 * 1000).unref();

/* ═══════════════════════════════════════════════════════════
   CACHE & CONCURRENCY
   ═══════════════════════════════════════════════════════════ */
// Low Bzzoiro quota (BZZ_DAILY_BUDGET <= 1000, e.g. 200/day): refresh far less often so the quota lasts the whole day.
const BZZ_LOW = (parseInt(process.env.BZZ_DAILY_BUDGET, 10) || 5500) <= 1000;
const FORM_TTL = 60 * 60 * 1000;
const FIXTURES_TTL = 20 * 1000;
const EVENTS_TTL_ACTIVE = BZZ_LOW ? 30 * 60 * 1000 : 60 * 1000;
const EVENTS_TTL_IDLE = BZZ_LOW ? 60 * 60 * 1000 : 10 * 60 * 1000;
const FD_TTL_ACTIVE = 60 * 1000;
const FD_TTL_IDLE = 10 * 60 * 1000;
const ODDS_TTL = 60 * 1000;
const ODDS_EVENT_TTL = BZZ_LOW ? 6 * 60 * 60 * 1000 : 10 * 60 * 1000;
const ODDS_MISS_TTL = BZZ_LOW ? 60 * 60 * 1000 : 3 * 60 * 1000;
const FORM_MISS_TTL = 10 * 60 * 1000;
const HISTORY_TTL = 5 * 60 * 1000;

const CONCURRENCY = 2;
const ODDS_CONCURRENCY = 3;
const API_DELAY = 400;
const ODDS_DELAY = 150;

const formCache = new Map();
const fixturesCache = { data: null, ts: 0 };
const eventsCache = { data: null, ts: 0, retryAt: 0 };   // retryAt: when set, the cached list is only trusted until then (incomplete / failed fetch)
const oddsCache = { data: null, ts: 0 };
const historyCache = { data: null, ts: 0 };
let prefetchInProgress = null;
let oddsFetchInProgress = null;
let fixturesFetchInProgress = null;
let eventsFetchInProgress = null;

const fdCache = { data: null, ts: 0, day: null, errUntil: 0 };
let fdInProgress = null;
let fdBlockedUntil = 0;
const oddsByEvent = new Map();
let lastFixtures = null;

const BZZ_DAILY_BUDGET = parseInt(process.env.BZZ_DAILY_BUDGET, 10) || 5500;
if (BZZ_LOW) console.log(`🐢 Low Bzzoiro quota mode (${BZZ_DAILY_BUDGET}/day): slower refresh of events, odds, forms and results.`);
const bzzUsage = { day: null, n: 0 };
function bzzRoll() { const d = new Date().toISOString().slice(0, 10); if (bzzUsage.day !== d) { bzzUsage.day = d; bzzUsage.n = 0; } }
function bzzCount() { bzzRoll(); bzzUsage.n++; if (bzzUsage.n % 100 === 0) console.log(`📈 Bzzoiro requests today: ${bzzUsage.n}/${BZZ_DAILY_BUDGET}`); }
// The last 25% of the daily quota is reserved for the live events list (statuses + scores). Forms, odds and result back-fills stop before it:
// they used to eat the whole quota by the evening, after which every match froze on its last status ("LIVE 0-0" for hours).
const BZZ_RESERVE = Math.floor(BZZ_DAILY_BUDGET * 0.25);
function bzzBudgetOk(essential) { bzzRoll(); return bzzUsage.n < (essential ? BZZ_DAILY_BUDGET : BZZ_DAILY_BUDGET - BZZ_RESERVE); }

function isActive() {
  if (!lastFixtures) return true;
  const now = Date.now();
  return lastFixtures.some(f => {
    if (f.status === 'started') return true;
    if (f.status !== 'notstarted') return false;
    const t = new Date(f.date + 'T' + f.kickoff + ':00Z').getTime();
    return !isNaN(t) && t - now < 15 * 60 * 1000;
  });
}

/* ═══════════════════════════════════════════════════════════
   TEAM ALIASES & MATCHING  (matching.js, covered by tests/matching.test.js)
   Same match = same kick-off (+-15 min) AND (one team named exactly the same OR both teams loosely match).
   "One similar team" alone is NOT enough: Manchester City v Everton and Manchester United v Fulham at 15:00 used to become one match.
   ═══════════════════════════════════════════════════════════ */
const { normalizeTeamKey, normalizeName, squadKey, teamsFuzzyMatch, teamsMatchAny, samePairing, dedupeFixtures } = require('./matching');

/* ═══════════════════════════════════════════════════════════
   STATUS NORMALIZATION
   ═══════════════════════════════════════════════════════════ */
// Pure helpers live in status.js (tested in tests/status.test.js). A feed that still says "live" 3.5 h after kick-off is stuck: the match is over.
const { normalizeStatus, pickBetterStatus, expireStaleLive, mergeEvents } = require('./status');

/* ═══════════════════════════════════════════════════════════
   APIs & DATA FETCHING
   ═══════════════════════════════════════════════════════════ */
const fdCalls = [];                           // timestamps of football-data calls in the last minute (free plan: 10/min)
function fdRecentCalls() { const t = Date.now() - 60 * 1000; while (fdCalls.length && fdCalls[0] < t) fdCalls.shift(); return fdCalls.length; }
async function apiGet(endpoint) {
  if (Date.now() < fdBlockedUntil) throw new Error('football-data cooling down after 429');
  fdCalls.push(Date.now());
  const r = await fetch(`${API_BASE}${endpoint}`, { headers: { 'X-Auth-Token': API_KEY || '' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) fdBlockedUntil = Date.now() + 65 * 1000;
  if (!r.ok) throw new Error(`API ${endpoint} → ${r.status}`);
  return r.json();
}

async function fetchFdMatches() {
  const day = todayStr();
  const ttl = isActive() ? FD_TTL_ACTIVE : FD_TTL_IDLE;
  const have = fdCache.data && fdCache.day === day;
  if (have && Date.now() - fdCache.ts < ttl) return fdCache.data;
  if (Date.now() < fdCache.errUntil) return have ? fdCache.data : [];
  if (fdInProgress) return fdInProgress;
  fdInProgress = (async () => {
    try {
      const d = await apiGet(`/matches?date=${day}`);
      fdCache.data = d.matches || []; fdCache.ts = Date.now(); fdCache.day = day;
    } catch (e) {
      fdCache.errUntil = Date.now() + 60 * 1000;
    } finally { fdInProgress = null; }
    return fdCache.day === day && fdCache.data ? fdCache.data : [];
  })();
  return fdInProgress;
}

async function fetchTeamForm(teamId) {
  try {
    const data = await apiGet(`/teams/${teamId}/matches?status=FINISHED&limit=5`);
    const matches = (data.matches || []).slice(-5);
    if (!matches.length) return { form: null, gf5: null, ga5: null, n: 0 };
    let form = '', gf = 0, ga = 0, n = 0;
    for (const m of matches) {
      const isHome = m.homeTeam.id === teamId;
      const scored = isHome ? m.score.fullTime.home : m.score.fullTime.away;
      const conceded = isHome ? m.score.fullTime.away : m.score.fullTime.home;
      if (!Number.isInteger(scored) || !Number.isInteger(conceded)) continue;
      gf += scored; ga += conceded; n++;
      if (scored > conceded) form += 'W'; else if (scored === conceded) form += 'D'; else form += 'L';
    }
    if (n < 3) return { form: null, gf5: null, ga5: null, n };
    return { form, gf5: gf / n * 5, ga5: ga / n * 5, n };
  } catch (e) { return null; }
}

async function prefetchForms(teams) {
  const queue = [...teams];
  const worker = async () => {
    while (queue.length) {
      const team = queue.shift();
      if (!team || !team.id) continue;
      if (Date.now() < fdBlockedUntil) { queue.length = 0; break; }
      const existing = formCache.get(team.id);
      if (existing && Date.now() - existing.ts < FORM_TTL) continue;
      const form = await fetchTeamForm(team.id);
      if (form) formCache.set(team.id, { data: form, ts: Date.now() });
      else formCache.set(team.id, { data: null, ts: Date.now() - FORM_TTL + FORM_MISS_TTL });
      await new Promise(r => setTimeout(r, API_DELAY));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(queue.length, 1)) }, worker));
}

async function ensureForms(teams) {
  const now = Date.now();
  const needed = teams.filter(t => t && t.id && (!formCache.has(t.id) || now - formCache.get(t.id).ts > FORM_TTL));
  if (!needed.length || prefetchInProgress) return prefetchInProgress;
  prefetchInProgress = (async () => {
    try { await prefetchForms(needed); }
    catch (e) { console.error(e.message); }
    finally { fixturesCache.data = null; prefetchInProgress = null; }
  })();
  return prefetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   SEASON GOALS PER GAME FROM FOOTBALL-DATA.ORG (standings)
   ═══════════════════════════════════════════════════════════ */
const FD_SEASON_TTL = 24 * 60 * 60 * 1000;
const FD_SEASON_MISS_TTL = 60 * 60 * 1000;
const FD_SEASON_MAX_PER_RUN = 3, FD_SEASON_GAP = 7000;   // 3 calls, 7 s apart per run   // plan without access to that competition / error: retry later
const fdSeasonCache = new Map();             // competition code -> { ts, ok, teams: Map }
let fdSeasonInProgress = null;
const fdSeasonMaps = () => [...fdSeasonCache.values()].filter(e => e.ok).map(e => e.teams);

function ensureFdSeasonStats() {
  if (!API_KEY) return null;
  const codes = [...new Set((fdCache.data || []).map(m => m.competition && m.competition.code).filter(Boolean))];
  const now = Date.now();
  const need = codes.filter(c => { const e = fdSeasonCache.get(c); return !e || now - e.ts > (e.ok ? FD_SEASON_TTL : FD_SEASON_MISS_TTL); });
  if (!need.length) return fdSeasonInProgress;
  if (fdSeasonInProgress) return fdSeasonInProgress;
  if (prefetchInProgress || Date.now() < fdBlockedUntil) return null;   // team forms go first: free tier allows only 10 requests/min
  need.length = Math.min(need.length, FD_SEASON_MAX_PER_RUN);
  fdSeasonInProgress = (async () => {
    try {
      for (const code of need) {
        if (Date.now() < fdBlockedUntil) break;
        try {
          const d = await apiGet(`/competitions/${code}/standings`);
          fdSeasonCache.set(code, { ts: Date.now(), ok: true, teams: fdStats.parseStandings(d) });
          if (football.LEAGUE_CODES.has(code)) { infoCache.set('table:' + code, { ts: Date.now(), ok: true, data: football.parseStandings(d) }); footballSaver.soon(); }
        } catch (e) { fdSeasonCache.set(code, { ts: Date.now(), ok: false, teams: new Map() }); }
        await new Promise(r => setTimeout(r, FD_SEASON_GAP));
      }
    } finally { fixturesCache.data = null; fdSeasonInProgress = null; }
  })();
  return fdSeasonInProgress;
}

/* ═══════════════════════════════════════════════════════════
   LEAGUE TABLES, TOP SCORERS, TEAM SHEETS (football-data.org)
   On-demand calls run one at a time and only while the last minute used fewer than FD_INFO_BUDGET calls, so the
   fixtures / forms / crests jobs keep their share of the free plan. Answers are cached; stale data is served while a
   refresh runs, and a failed refresh is not retried for 5 minutes.
   ═══════════════════════════════════════════════════════════ */
const FD_INFO_BUDGET = { hi: 7, lo: 4 };      // calls in the last minute under which a user (hi) / background (lo) info call may go out
const INFO_TTL = { table: 60 * 60 * 1000, scorers: 6 * 60 * 60 * 1000, team: 24 * 60 * 60 * 1000 };
const INFO_FAIL_TTL = 5 * 60 * 1000, INFO_MAX_TEAMS = 600;
const infoCache = new Map();                 // key -> { ts, ok, data }
// Kept on the data volume so a restart / deploy serves tables, scorers and team sheets at once instead of re-downloading.
const footballCacheFile = () => path.join(path.dirname(HISTORY_FILE), 'football-cache.json');   // HISTORY_FILE is defined further down
const footballSaver = makeSaver('Football cache', () => writeAtomic(footballCacheFile(), JSON.stringify([...infoCache.entries()].filter(([, v]) => v.ok))), 60 * 1000);
function loadFootballCache() {
  try {
    const f = footballCacheFile();
    if (!fs.existsSync(f)) return;
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(arr)) for (const e of arr) if (Array.isArray(e) && typeof e[0] === 'string' && e[1] && e[1].ok && e[1].data && typeof e[1].ts === 'number') infoCache.set(e[0], e[1]);
    console.log(`⚽ Loaded football cache: ${infoCache.size} entries`);
  } catch (e) { console.error('Football cache load error:', e.message); }
}
const infoJobs = new Map();                  // key -> { endpoint, parse, prio, promise, resolve }
const infoQ = { hi: [], lo: [] };            // keys waiting, user requests first
let infoWorking = false;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
async function infoWorker() {
  if (infoWorking) return;
  infoWorking = true;
  try {
    while (infoQ.hi.length || infoQ.lo.length) {
      const hi = infoQ.hi.length > 0;
      if (Date.now() < fdBlockedUntil || fdRecentCalls() >= (hi ? FD_INFO_BUDGET.hi : FD_INFO_BUDGET.lo)) { await sleepMs(700); continue; }
      const key = (hi ? infoQ.hi : infoQ.lo).shift();
      const job = infoJobs.get(key); if (!job) continue;
      let data = null;
      try {
        data = job.parse(await apiGet(job.endpoint));
        if (!data) throw new Error('empty');
        infoCache.set(key, { ts: Date.now(), ok: true, data });
        footballSaver.soon();
        if (key.startsWith('team:')) {           // bounded: drop the oldest team sheets
          const teams = [...infoCache.keys()].filter(k => k.startsWith('team:'));
          for (const k of teams.slice(0, Math.max(0, teams.length - INFO_MAX_TEAMS))) infoCache.delete(k);
        }
      } catch (e) {
        const prev = infoCache.get(key);
        data = (prev && prev.data) || null;
        infoCache.set(key, { ts: Date.now(), ok: false, data });
      }
      infoJobs.delete(key); job.resolve(data);
    }
  } finally { infoWorking = false; }
}
// prio 'hi' = a person is waiting for it; 'lo' = background warm-up. A later 'hi' request promotes a queued 'lo' job.
function infoGet(key, endpoint, parse, ttl, prio = 'hi', maxWaitMs = 8000) {
  const c = infoCache.get(key), age = c ? Date.now() - c.ts : Infinity;
  if (c && c.ok && age < ttl) return Promise.resolve(c.data);
  if (c && !c.ok && age < INFO_FAIL_TTL) return Promise.resolve(c.data || null);
  let job = infoJobs.get(key);
  if (!job) {
    let resolve; const promise = new Promise(r => { resolve = r; });
    job = { endpoint, parse, prio, promise, resolve };
    infoJobs.set(key, job); infoQ[prio].push(key);
  } else if (prio === 'hi' && job.prio === 'lo') {
    job.prio = 'hi'; infoQ.lo = infoQ.lo.filter(k => k !== key); infoQ.hi.push(key);
  }
  infoWorker();
  if (c && c.data) return Promise.resolve(c.data);               // stale while revalidating
  if (prio === 'lo') return job.promise;
  return Promise.race([job.promise, sleepMs(maxWaitMs).then(() => undefined)]);   // undefined = still queued, client retries
}
const fbTable = (code, prio) => infoGet('table:' + code, `/competitions/${code}/standings`, football.parseStandings, INFO_TTL.table, prio);
const fbScorers = (code, prio) => infoGet('scorers:' + code, `/competitions/${code}/scorers?limit=15`, football.parseScorers, INFO_TTL.scorers, prio);
const fbTeam = (id, prio) => infoGet('team:' + id, `/teams/${id}`, d => football.parseTeam(d), INFO_TTL.team, prio);
// Background warm-up, lowest priority: every league table, then top scorers, then every team sheet in those tables,
// so clicks are answered from cache. ~230 calls spread over the free plan's spare capacity, refreshed every few hours.
let warmRunning = false;
async function warmFootball() {
  if (!API_KEY || warmRunning) return;
  warmRunning = true;
  try {
    await Promise.all(football.LEAGUES.map(l => fbTable(l.code, 'lo')));
    await Promise.all(football.LEAGUES.map(l => fbScorers(l.code, 'lo')));
    const ids = new Set();
    for (const l of football.LEAGUES) {
      const t = infoCache.get('table:' + l.code);
      for (const g of (t && t.data && t.data.groups) || []) for (const r of g.rows) if (r.team && r.team.id) ids.add(r.team.id);
    }
    for (const id of ids) await fbTeam(id, 'lo');
    const n = k => [...infoCache.entries()].filter(([x, v]) => x.startsWith(k) && v.ok).length;
    console.log(`Football cache warm: tables ${n('table:')}/${football.LEAGUES.length}, scorers ${n('scorers:')}/${football.LEAGUES.length}, teams ${n('team:')}/${ids.size}`);
  } catch (e) { console.error('Football warm-up failed:', e.message); }
  finally { warmRunning = false; }
}
setTimeout(warmFootball, 60 * 1000).unref();
setInterval(warmFootball, 3 * 60 * 60 * 1000).unref();

/* ═══════════════════════════════════════════════════════════
   TEAM FORMS FROM BZZOIRO RESULTS
   ═══════════════════════════════════════════════════════════ */
const BZZ_FORM_TTL = BZZ_LOW ? 24 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
const BZZ_FORM_RETRY = 10 * 60 * 1000;
const BZZ_FORM_DAYS = Math.max(7, parseInt(process.env.BZZ_FORM_DAYS, 10) || 30);
const BZZ_FORM_GAMES = Math.min(15, Math.max(5, parseInt(process.env.BZZ_FORM_GAMES, 10) || 8));
const BZZ_FORM_MAX_PAGES = Math.max(1, parseInt(process.env.BZZ_FORM_MAX_PAGES, 10) || (BZZ_LOW ? 25 : 80));
const bzzFormCache = { map: new Map(), ts: 0 };
let bzzFormInProgress = null;

function teamNameKey(n) { return String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, ''); }

function buildBzzFormMap(events, finishedFn) {
  const games = new Map();
  const push = (name, t, gf, ga) => { const k = teamNameKey(name); if (!k) return; if (!games.has(k)) games.set(k, []); games.get(k).push({ t, gf, ga }); };
  for (const ev of events || []) {
    if (!ev || !ev.home_team || !ev.away_team || ev.home_score == null || ev.away_score == null) continue;
    const hs = Number(ev.home_score), as = Number(ev.away_score), t = new Date(ev.event_date).getTime();
    if (!Number.isInteger(hs) || !Number.isInteger(as) || hs < 0 || as < 0 || isNaN(t)) continue;
    if (!finishedFn(ev)) continue;
    push(ev.home_team, t, hs, as); push(ev.away_team, t, as, hs);
  }
  const out = new Map();
  for (const [k, arr] of games) {
    const last = arr.sort((a, b) => b.t - a.t).slice(0, BZZ_FORM_GAMES);
    if (last.length < 3) continue;
    let gf = 0, ga = 0, form = '';
    for (const g of last) { gf += g.gf; ga += g.ga; }
    for (const g of last.slice(0, 5).reverse()) form += g.gf > g.ga ? 'W' : g.gf === g.ga ? 'D' : 'L';
    out.set(k, { form, gf5: gf / last.length * 5, ga5: ga / last.length * 5, n: last.length });
  }
  return out;
}

async function ensureBzzForms() {
  if (!BZZOIRO_API_KEY) return null;
  if (Date.now() - bzzFormCache.ts < BZZ_FORM_TTL) return null;
  if (!bzzBudgetOk()) return null;
  if (bzzFormInProgress) return bzzFormInProgress;
  const need = new Set();
  for (const ev of eventsCache.data || []) { if (ev && ev.home_team) need.add(teamNameKey(ev.home_team)); if (ev && ev.away_team) need.add(teamNameKey(ev.away_team)); }
  bzzFormInProgress = (async () => {
    const stats = { need: need.size, teams: 0, covered: 0, events: 0, pages: 0, days: 0, error: null, at: new Date().toISOString() };
    try {
      const events = [];
      const finished = ev => normalizeStatus(ev.status, ev.event_date) === 'finished';
      outer: for (let d = 0; d <= BZZ_FORM_DAYS; d++) {
        const day = dateDaysAgo(d);
        let url = `${BZZOIRO_API_BASE}/v2/events/?date_from=${day}&date_to=${day}`;
        stats.days++;
        while (url) {
          if (stats.pages >= BZZ_FORM_MAX_PAGES || !bzzBudgetOk()) break outer;
          stats.pages++; bzzCount();
          const r = await fetch(url, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error(`Bzz forms HTTP ${r.status}`);
          const data = await r.json();
          events.push(...(data.results || data.data || []));
          url = bzzNextUrl(data.next);
        }
        if (need.size && d >= 1) {
          const m = buildBzzFormMap(events, finished);
          if ([...need].every(k => m.get(k) && m.get(k).n >= BZZ_FORM_GAMES)) break;
        }
      }
      const map = buildBzzFormMap(events, finished);
      stats.events = events.length; stats.teams = map.size; stats.covered = [...need].filter(k => map.has(k)).length;
      if (map.size) { bzzFormCache.map = map; bzzFormCache.ts = Date.now(); }
      else bzzFormCache.ts = Date.now() - BZZ_FORM_TTL + BZZ_FORM_RETRY;
    } catch (e) {
      stats.error = e.message;
      console.error(e.message);
      bzzFormCache.ts = Date.now() - BZZ_FORM_TTL + BZZ_FORM_RETRY;
    } finally {
      bzzFormCache.stats = stats;
      console.log(`📈 Bzzoiro forms: ${stats.covered}/${stats.need} needed teams, ${stats.events} events, ${stats.pages} pages, ${stats.days} days${stats.error ? ' (error: ' + stats.error + ')' : ''}`);
      fixturesCache.data = null; bzzFormInProgress = null;
    }
  })();
  return bzzFormInProgress;
}

/* ═══════════════════════════════════════════════════════════
   TEAM LOGOS (TheSportsDB - Optimized)
   ═══════════════════════════════════════════════════════════ */
const LOGO_TTL_OK = 7 * 24 * 60 * 60 * 1000;
const LOGO_TTL_MISS = 6 * 60 * 60 * 1000;
const LOGO_RETRY = 60 * 1000;
const LOGO_DELAY = 2200;
const logoCache = new Map();
let logoFetchInProgress = null;

const logoKey = name => String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
// Local club logos (FCLOGO, MIT) are tried FIRST: they never fail, never rate-limit and load from our own domain.
let FC_INDEX = {};
try { FC_INDEX = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'logos', 'fc', 'index.json'), 'utf8')); } catch (e) { console.log('FCLOGO index not loaded:', e.message); }
const fcKey = n => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/-/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
function fcLocalLogo(name) {
  if (!name) return null;
  const k = fcKey(name), k2 = fcKey(cleanNameForSearch(name));
  const f = FC_INDEX[k] || FC_INDEX[k2] || FC_INDEX[k.replace(/^(fc|afc|cf|ac|sc|cd|ca|club|as|ss|us)\s+/, '').replace(/\s+(fc|afc|cf|ac|sc|cd|ca)$/, '')];
  return f ? '/logos/fc/' + f : null;
}
// Layer 2 (club logos from JoseArroyave/football-logos, 96px webp) and country flags for national teams.
let X_INDEX = {}, FLAG_INDEX = {};
try { X_INDEX = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'logos', 'x', 'index.json'), 'utf8')); } catch (e) { console.log('extra logo index not loaded:', e.message); }
try { FLAG_INDEX = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'logos', 'flags', 'index.json'), 'utf8')); } catch (e) { console.log('flag index not loaded:', e.message); }
const stripClubWords = k => k.replace(/^(fc|afc|cf|ac|sc|cd|ca|club|as|ss|us|cs|fk|sk|nk|bk|if)\s+/, '').replace(/\s+(fc|afc|cf|ac|sc|cd|ca|fk|sk|nk|bk|if)$/, '');
function flagLogo(name) { const c = FLAG_INDEX[fcKey(name).replace(/\s+(u ?\d{2}|w|women|olympic|olympics)$/, '')]; return c ? '/logos/flags/' + c + '.svg' : null; }   // exact country name only ("Brazil"), never "Brazil U20"
function extraLogo(name) { if (!name) return null; const k = fcKey(name), f = X_INDEX[k] || X_INDEX[fcKey(cleanNameForSearch(name))] || X_INDEX[stripClubWords(k)]; return f ? '/logos/x/' + f : null; }
// order: FCLOGO vectors, national flag, JoseArroyave club logo
const localLogo = name => fcLocalLogo(name) || flagLogo(name) || extraLogo(name);
const cachedLogo = name => { const c = logoCache.get(logoKey(name)); return localLogo(name) || (c && c.url) || fdCrest(name) || null; };

/* Crests from football-data.org (1 call per competition, cached 7 days): fast and reliable for the big leagues + Champions League.
   TheSportsDB below stays as the fallback for every team football-data does not cover. */
const FD_CREST_CODES = ['CL', 'PL', 'PD', 'SA', 'BL1', 'FL1', 'DED', 'PPL', 'ELC'];
const FD_CREST_TTL = 7 * 24 * 60 * 60 * 1000, FD_CREST_MISS = 60 * 60 * 1000, FD_CREST_MAX_PER_RUN = 3, FD_CREST_GAP = 7000;
const fdCrestCache = new Map();   // competition code -> { ts, ok, teams: [{ toks: [Set], sq, crest }] }
let fdCrestInProgress = null;
const CREST_STOP = new Set(['fc', 'ac', 'as', 'us', 'ss', 'cf', 'sc', 'afc', 'cd', 'ud', 'sd', 'rc', 'ca', 'cp', 'club', 'de', 'del', 'la', 'le', 'el', 'the', 'calcio', 'bc', 'sv', 'vfl', 'vfb', 'tsg']);
const crestToks = n => new Set(String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !/^\d+$/.test(w) && !CREST_STOP.has(w)));
// Same team = same word set, or (>= 2 words) one set inside the other. A single word must match exactly, so "Inter Club d'Escaldes" never gets Inter Milan's crest.
function crestSame(a, b) {
  if (!a.size || !b.size) return false;
  const [x, y] = a.size <= b.size ? [a, b] : [b, a];
  if (![...x].every(t => y.has(t))) return false;
  return x.size === y.size || x.size >= 2;
}
function fdCrest(name) {
  const t = crestToks(name); if (!t.size) return null;
  const sq = squadKey(name), nn = normalizeName(name);
  for (const e of fdCrestCache.values()) {
    if (!e.ok) continue;
    for (const x of e.teams) {
      if (x.sq !== sq) continue;
      if (x.nn === nn || x.toks.some(k => crestSame(t, k))) return x.crest;
    }
  }
  return null;
}
function ensureFdCrests() {
  if (!API_KEY) return null;
  if (fdCrestInProgress) return fdCrestInProgress;
  const now = Date.now();
  const need = FD_CREST_CODES.filter(c => { const e = fdCrestCache.get(c); return !e || now - e.ts > (e.ok ? FD_CREST_TTL : FD_CREST_MISS); });
  if (!need.length || Date.now() < fdBlockedUntil) return null;
  need.length = Math.min(need.length, FD_CREST_MAX_PER_RUN);
  fdCrestInProgress = (async () => {
    let got = false;
    try {
      for (const code of need) {
        if (Date.now() < fdBlockedUntil) break;
        try {
          const d = await apiGet(`/competitions/${code}/teams`);
          const teams = (d.teams || []).filter(t => t && t.crest && /^https?:\/\//i.test(t.crest)).map(t => ({
            toks: [crestToks(t.name), crestToks(t.shortName)].filter(k => k.size), sq: squadKey(t.name), nn: normalizeName(t.name), crest: t.crest
          }));
          fdCrestCache.set(code, { ts: Date.now(), ok: true, teams });
          got = true;
        } catch (e) { fdCrestCache.set(code, { ts: Date.now(), ok: false, teams: [] }); }
        await new Promise(r => setTimeout(r, FD_CREST_GAP));
      }
    } finally { if (got) fixturesCache.data = null; fdCrestInProgress = null; }
  })();
  return fdCrestInProgress;
}

function cleanNameForSearch(name) {
  return String(name || '')
    .replace(/\b(fc|afc|sc|ac|cf|club|calcio|as|ss|us|cd)\b/gi, '')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// SportsAPI Pro (optional): used ONLY to find team logos. Needs SPORTSAPIPRO_KEY in the environment (never committed).
// 1) search the team name -> competitor id (key sent as x-api-key), 2) logo = the free V1 image URL (no key, no quota, usable directly in <img>).
const SAP_KEY = process.env.SPORTSAPIPRO_KEY || '';
function pickSapCompetitor(list, name) {
  const want = logoKey(name), want2 = logoKey(cleanNameForSearch(name));
  const NOT_FIRST_TEAM = /\b(women|woman|ladies|feminin|femenino|femminile|youth|reserves?|u ?\d{2}|ii|iii|b)\b/i;   // never pick a women's/youth/reserve side for a first-team fixture
  const c = (Array.isArray(list) ? list : []).filter(x => x && x.id != null && x.name && (x.sportId == null || x.sportId === 1) && (NOT_FIRST_TEAM.test(name) || !NOT_FIRST_TEAM.test(x.name)));
  return c.find(x => logoKey(x.name) === want || logoKey(x.name) === want2)
    || c.find(x => { const k = logoKey(x.name); return want2.length >= 4 && (k.startsWith(want2 + ' ') || want2.startsWith(k + ' ')) && Math.abs(k.length - want2.length) <= 4; })
    || null;
}
async function fetchLogoSportsApiPro(name) {
  if (!SAP_KEY) return undefined;
  try {
    const r = await fetch(`https://api.sportsapipro.com/v1/search?q=${encodeURIComponent(cleanNameForSearch(name))}&filter=competitors&sportId=1`, { headers: { 'x-api-key': SAP_KEY }, signal: AbortSignal.timeout(12000) });
    if (r.status === 429) return 'rate_limited';
    if (!r.ok) return undefined;
    const d = await r.json();
    const best = pickSapCompetitor(d && d.data && d.data.competitors, name);
    if (!best) return null;
    const url = `https://api.sportsapipro.com/v1/football/images/competitors/${encodeURIComponent(best.id)}`;
    // a missing crest comes back as HTTP 200 with a tiny grey placeholder: check it is a real image
    const img = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!img.ok || !/^image\//.test(img.headers.get('content-type') || '')) return null;
    const buf = await img.arrayBuffer();
    return buf.byteLength >= 1500 ? url : null;
  } catch (e) { return undefined; }
}

async function fetchLogoByName(name) {
  const sap = await fetchLogoSportsApiPro(name);
  if (typeof sap === 'string' && sap !== 'rate_limited') return sap;
  try {
    const searchName = cleanNameForSearch(name);
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(searchName)}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      if (r.status === 429) return 'rate_limited';
      return undefined;
    }
    const data = await r.json();
    const teams = (data.teams || []).filter(t => t.strSport === 'Soccer');
    const best = teams.find(t => logoKey(t.strTeam) === logoKey(name) || logoKey(t.strTeam) === logoKey(searchName)) || teams[0];
    return (best && (best.strBadge || best.strTeamBadge)) || null;
  } catch (e) { return undefined; }
}

function ensureLogos(teams) {
  if (logoFetchInProgress) return logoFetchInProgress;
  const now = Date.now();
  const names = [...new Set(teams.filter(t => t && t.name && !t.logo).map(t => t.name))].filter(n => {
    const c = logoCache.get(logoKey(n));
    return !c || now - c.ts > (c.url ? LOGO_TTL_OK : LOGO_TTL_MISS);
  });
  if (!names.length) return null;
  logoFetchInProgress = (async () => {
    try {
      for (const n of names) {
        const url = await fetchLogoByName(n);
        if (url === 'rate_limited') {
          console.log('⚠️ TheSportsDB rate limited. Pausing logo fetch for 1 min.');
          await new Promise(r => setTimeout(r, 60000));
          continue;
        }
        if (url === undefined) {
          logoCache.set(logoKey(n), { url: null, ts: Date.now() - LOGO_TTL_MISS + LOGO_RETRY });
        } else {
          logoCache.set(logoKey(n), { url, ts: Date.now() });
          if (url) fixturesCache.data = null;
        }
        await new Promise(r => setTimeout(r, LOGO_DELAY));
      }
    } catch (e) {
      console.error('Logo fetch error:', e.message);
    } finally {
      logoFetchInProgress = null;
    }
  })();
  return logoFetchInProgress;
}

function todayStr() {
  const d = new Date(); const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const BZZ_EVENT_PAGES = Math.max(2, Math.min(10, parseInt(process.env.BZZ_EVENT_PAGES, 10) || 6));   // the provider paginates (~10 per page): a busy day needs more than 2 pages
let bzzLastPages = 1;
const BZZ_RETRY_MS = 15 * 1000;   // how soon an incomplete / failed events fetch is retried
let bzzTruncated = false;   // true when today has more event pages than BZZ_EVENT_PAGES: the rest is NOT shown
let bzzIncomplete = false;   // true while the events list may be missing matches (a page failed, budget used up, provider down)
// True while our copy of today's events was fetched completely and recently (so its scores are current, not left over from an hour ago).
function eventsFresh() {
  const ttl = (isActive() ? EVENTS_TTL_ACTIVE : EVENTS_TTL_IDLE) * 2 + 60 * 1000;
  return !bzzIncomplete && !!eventsCache.ts && Date.now() - eventsCache.ts < ttl;
}
async function fetchBzzoiroEvents() {
  if (!BZZOIRO_API_KEY) return [];
  const eventsTtl = (isActive() ? EVENTS_TTL_ACTIVE : EVENTS_TTL_IDLE) * (bzzLastPages > 2 ? 2 : 1);   // more pages cost more of the daily budget: refresh less often
  if (eventsCache.data && (eventsCache.retryAt ? Date.now() < eventsCache.retryAt : Date.now() - eventsCache.ts < eventsTtl)) return eventsCache.data;
  if (!bzzBudgetOk(true)) { bzzIncomplete = true; return eventsCache.data || []; }
  if (eventsFetchInProgress) return eventsFetchInProgress;
  eventsFetchInProgress = (async () => {
    try {
      // Fetch 2 pages of events (follows `next`); each page costs 1 request of the Bzzoiro budget.
      let url = `${BZZOIRO_API_BASE}/v2/events/?date_from=${todayStr()}&date_to=${todayStr()}`;
      const events = [];
      let complete = true, pages = 0;
      for (let page = 0; url && page < BZZ_EVENT_PAGES; page++) {
        bzzCount();
        // A hung request must not freeze every /api/fixtures call behind eventsFetchInProgress: give up after 15 s.
        const r = await fetch(url, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) { if (page === 0) throw new Error(`Events HTTP ${r.status}`); complete = false; break; }
        const data = await r.json();
        const part = data.results || data.data || [];
        if (Array.isArray(part)) events.push(...part);
        pages++;
        url = bzzNextUrl(data.next);
      }
      bzzLastPages = pages;
      if (url && complete) console.log(`⚠️ Bzzoiro events: more than ${BZZ_EVENT_PAGES} pages today, the rest is NOT shown (raise BZZ_EVENT_PAGES)`);
      const day = todayStr(), known = eventsCache.day === day ? (eventsCache.data || []) : [];   // never keep yesterday's list as the fuller one
      bzzIncomplete = !complete;
      bzzTruncated = !!(url && complete);
      // retryAt (not a shortened ts): the TTL differs between active (60 s) and idle (10 min) mode and can change before the retry is due.
      if (!complete && known.length > events.length) {
        // A later page failed: keep the fuller list we already know, but lay what we DID just fetch over it (by event id), so those matches
        // get their fresh status and score. Throwing the new pages away froze every match on its old status ("LIVE 0-0") while a page kept failing.
        console.log(`⚠️ Bzzoiro events: a page failed (${events.length} < ${known.length} known). Keeping the known list, updated with the ${events.length} fresh events.`);
        eventsCache.data = mergeEvents(known, events); eventsCache.ts = Date.now(); eventsCache.day = day;
        eventsCache.retryAt = Date.now() + BZZ_RETRY_MS;
      } else if (events.length > 0 || !known.length) {
        eventsCache.data = events; eventsCache.ts = Date.now(); eventsCache.day = day;
        // A partial list (a later page failed, nothing fuller known, e.g. right after a restart) must not live for the whole TTL
        // (10 min when idle): that is what made the match count jump around (10 / 18 / 26) between refreshes. Retry shortly.
        if (!complete) { console.log(`⚠️ Bzzoiro events: a page failed, showing ${events.length} for now, retrying in ${BZZ_RETRY_MS / 1000}s.`); eventsCache.retryAt = Date.now() + BZZ_RETRY_MS; }
        else eventsCache.retryAt = 0;
      } else {
        eventsCache.retryAt = Date.now() + 10 * 1000;   // empty answer while we know matches: keep them, ask again in a moment
      }
      return eventsCache.data || [];
    } catch (e) {
      // First page failed (HTTP error / timeout): keep the last good list, and back off a little instead of retrying on every request.
      bzzIncomplete = true;
      console.log(`⚠️ Bzzoiro events failed: ${e.message}. Keeping ${(eventsCache.data || []).length} known, retrying in ${BZZ_RETRY_MS / 1000}s.`);
      if (eventsCache.data && eventsCache.data.length) eventsCache.retryAt = Date.now() + BZZ_RETRY_MS;
      return eventsCache.data || [];
    }
    finally { eventsFetchInProgress = null; }
  })();
  return eventsFetchInProgress;
}

function parseBzzoiroOdds(oddsObj) {
  if (!oddsObj) return null;
  const h = parseFloat(oddsObj.home_win), d = parseFloat(oddsObj.draw), a = parseFloat(oddsObj.away_win);
  if (!(h > 1 && d > 1 && a > 1)) return null;
  const over = parseFloat(oddsObj.over_25_goals), under = parseFloat(oddsObj.under_25_goals);
  return { book: 'Bzzoiro', home: h, draw: d, away: a, over25: over > 1 ? over : null, under25: under > 1 ? under : null };
}

async function fetchEventOdds(eventId) {
  try {
    bzzCount();
    const r = await fetch(`${BZZOIRO_API_BASE}/v2/events/${eventId}/odds/`, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}` }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const data = await r.json();
    return data.odds || data;
  } catch (e) { return null; }
}

async function fetchOdds() {
  if (!BZZOIRO_API_KEY) return new Map();
  if (oddsCache.data && Date.now() - oddsCache.ts < ODDS_TTL) return oddsCache.data;
  if (oddsFetchInProgress) return oddsFetchInProgress;
  oddsFetchInProgress = (async () => {
    const oddsMap = new Map();
    try {
      const events = await fetchBzzoiroEvents();
      const valid = events.filter(ev => ev.home_team && ev.away_team);
      const now = Date.now();
      const queue = valid.filter(ev => {
        const c = oddsByEvent.get(ev.id);
        if (!bzzBudgetOk(false)) return false;
        const st = normalizeStatus(ev.status, ev.event_date);
        if (st === 'finished' || st === 'canceled') return false;   // only pre-match prices are used: never spend budget on these
        if (c && st === 'started') return false;
        if (!c) return true;
        return now - c.ts > (c.parsed ? ODDS_EVENT_TTL : ODDS_MISS_TTL);
      });
      const workers = Array.from({ length: ODDS_CONCURRENCY }, async () => {
        while (queue.length) {
          if (!bzzBudgetOk(false)) { queue.length = 0; break; }
          const ev = queue.shift();
          const raw = await fetchEventOdds(ev.id);
          const parsed = parseBzzoiroOdds(raw);
          const prev = oddsByEvent.get(ev.id);
          oddsByEvent.set(ev.id, { parsed: parsed || (raw === null && prev ? prev.parsed : null), ts: Date.now() });
          await new Promise(r => setTimeout(r, ODDS_DELAY));
        }
      });
      await Promise.all(workers);
      for (const ev of valid) {
        const c = oddsByEvent.get(ev.id);
        if (c && c.parsed) oddsMap.set(normalizeTeamKey(ev.home_team, ev.away_team), c.parsed);
      }
      const liveIds = new Set(valid.map(ev => ev.id));
      for (const id of oddsByEvent.keys()) if (!liveIds.has(id)) oddsByEvent.delete(id);
    } catch (e) {
      console.error(e.message);
    } finally {
      oddsCache.data = oddsMap;
      oddsCache.ts = Date.now();
      fixturesCache.data = null;
      oddsFetchInProgress = null;
    }
    return oddsMap;
  })();
  return oddsFetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   ESTIMATE XG & MERGE
   ═══════════════════════════════════════════════════════════ */
function estimateXGForFixture(fixture) {
  const H = fixture.home, A = fixture.away;
  if (H.xgFor != null && A.xgFor != null) { fixture.xgSource = 'direct'; fixture.dataQuality = 'high'; return; }
  const ss = fdStats.seasonFor(fdSeasonMaps(), H.name, A.name, teamsFuzzyMatch);
  if (ss) {
    H.xgFor = ss.home.gf; H.xgAgainst = ss.home.ga; H.formN = ss.home.n;
    A.xgFor = ss.away.gf; A.xgAgainst = ss.away.ga; A.formN = ss.away.n;
    fixture.xgSource = 'season'; fixture.dataQuality = fixture.odds?.length ? 'high' : 'medium'; return;
  }
  if (H.gf5 != null && A.gf5 != null) {
    H.xgFor = H.gf5 / 5; H.xgAgainst = H.ga5 / 5; A.xgFor = A.gf5 / 5; A.xgAgainst = A.ga5 / 5;
    fixture.xgSource = 'forms'; fixture.dataQuality = fixture.odds?.length ? 'medium' : 'low'; return;
  }
  if (fixture.h2h && fixture.h2h.total_matches > 0) {
    const n = fixture.h2h.total_matches, hg = (fixture.h2h.home_goals ?? 0) / n, ag = (fixture.h2h.away_goals ?? 0) / n;
    H.xgFor = hg; H.xgAgainst = ag; A.xgFor = ag; A.xgAgainst = hg;
    fixture.xgSource = 'h2h'; fixture.dataQuality = fixture.odds?.length ? 'low' : 'very-low'; return;
  }
  H.xgFor = 1.4; H.xgAgainst = 1.2; A.xgFor = 1.2; A.xgAgainst = 1.4;
  fixture.xgSource = 'league-avg'; fixture.dataQuality = 'very-low';
}

// Bzzoiro price (if any) + extra real books from The Odds API (cache only, no request here). Both teams must match.
function mergeOdds(base, home, away) {
  const extra = home && away ? oddsApi.booksFor(home, away, teamsMatchAny) : [];
  return (base ? [base] : []).concat(extra);
}

// Well-known clubs / national teams: their matches are shown first (fixture.big = 0, 1 or 2 famous teams).
const BIG_TEAMS = /\b(real madrid|barcelona|atl[eé]tico madrid|sevilla|valencia|villarreal|real sociedad|athletic club|manchester (united|city)|liverpool|chelsea|arsenal|tottenham|newcastle|aston villa|west ham|bayern|dortmund|leverkusen|rb leipzig|juventus|inter(?! miami)|milan|napoli|roma|lazio|atalanta|fiorentina|paris saint|psg|marseille|lyon|monaco|lille|benfica|porto|sporting cp|sporting lisbon|ajax|psv|feyenoord|celtic|rangers|galatasaray|fenerbah[cç]e|be[sş]ikta[sş]|olympiacos|shakhtar|dynamo kyiv|al[ -]hilal|al[ -]nassr|al[ -]ittihad|al[ -]ahli|inter miami|boca juniors|river plate|flamengo|palmeiras|wydad|raja casablanca|al ahly|zamalek|brazil|argentina|france|england|spain|germany|portugal|italy|netherlands|belgium|croatia|morocco|usa|mexico|japan)\b/i;
const YOUTH_OR_WOMEN = /\b(u-?\d{2}|women|w|ii|b|reserves?|youth)\b/i;
const isBigTeam = n => { n = String(n || ''); return BIG_TEAMS.test(n) && !YOUTH_OR_WOMEN.test(n); };

// fixtureQuality / dedupeFixtures: see matching.js

// The site shows TODAY's matches only, and the list must not wobble between refreshes. A feed that is momentarily incomplete
// (a Bzzoiro page failed, football-data is cooling down after a 429) must not make matches vanish or a finished one go back to
// "live": while the feed is degraded we keep what we already knew about today, once it is healthy again the list follows it exactly.
const INSTANCE_ID = crypto.randomBytes(3).toString('hex'), STARTED_AT = Date.now();   // tells apart restarts and several server copies answering the same site
function feedHealth() {
  const day = todayStr();
  return {
    instance: INSTANCE_ID, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), shown: stableToday.count,
    bzzEvents: (eventsCache.data || []).length, bzzPages: bzzLastPages, bzzIncomplete, bzzTruncated, bzzBudgetLeft: Math.max(0, BZZ_DAILY_BUDGET - bzzUsage.n),
    fdDegraded: !!API_KEY && (Date.now() < fdCache.errUntil || Date.now() < fdBlockedUntil || fdCache.day !== day)
  };
}
let stableToday = { day: null, map: new Map(), count: -1 };
function stabilizeToday(fresh) {
  const day = todayStr();
  if (stableToday.day !== day) stableToday = { day, map: new Map(), count: -1 };
  const fdDegraded = !!API_KEY && (Date.now() < fdCache.errUntil || Date.now() < fdBlockedUntil || fdCache.day !== day);
  const degraded = bzzIncomplete || fdDegraded;
  let list = fresh.filter(f => f.date === day || f.status === 'started');
  // The provider is asked for "today" only, so at 00:00 UTC a match that kicked off at 23:30 vanishes from the feed while it is still being played.
  // Keep it (from the saved snapshot) until it is really finished, so it is neither dropped nor settled early. Cap: 8 hours after kickoff.
  {
    const have = new Set(list.map(f => f.id));
    for (const sn of snapshotStore.values()) {
      if (!sn || have.has(sn.id) || sn.date >= day || sn.status === 'finished' || sn.status === 'canceled') continue;
      const t = new Date(sn.date + 'T' + sn.kickoff + ':00Z').getTime();
      if (isNaN(t) || Date.now() - t > 8 * 60 * 60 * 1000 || Date.now() < t) continue;
      list.push(Object.assign(JSON.parse(JSON.stringify(sn)), { status: 'started' }));
    }
  }
  if (degraded) {
    const seen = new Set(list.map(f => f.id));
    // Only keep matches that are still going to be played / are live. Finished and canceled ones must not come back from the cache.
    for (const [id, pf] of stableToday.map) if (!seen.has(id) && pf.status !== 'finished' && pf.status !== 'canceled') list.push(pf);
    list = dedupeFixtures(list);
  }
  for (const f of list) {
    const pf = stableToday.map.get(f.id);
    if (pf && pf.status === 'finished' && Number.isInteger(pf.homeScore) && Number.isInteger(pf.awayScore)
        && (f.status !== 'finished' || !Number.isInteger(f.homeScore) || !Number.isInteger(f.awayScore))) {
      f.status = 'finished'; f.homeScore = pf.homeScore; f.awayScore = pf.awayScore; delete f.resultPending;
    }
  }
  // Whatever is still "live" long after kick-off (a stale copy kept while the feed is degraded, a stuck provider) is over: never LIVE for ever.
  for (const f of list) if (expireStaleLive(f)) console.log(`⏱️ ${f.home.name} v ${f.away.name}: still "live" more than 3.5 h after kick-off, now shown as finished (score pending)`);
  if (!degraded) stableToday.map = new Map();
  for (const f of list) stableToday.map.set(f.id, f);
  if (list.length !== stableToday.count) {
    console.log(`📋 Fixtures today: ${list.length} (feed ${fresh.length}${degraded ? ', feed degraded: kept known matches' : ''})`);
    stableToday.count = list.length;
  }
  return list;
}


/* ═══════════════════════════════════════════════════════════
   LEAGUE NAMES (Bzzoiro events only carry league_id)
   1) use any name the event itself carries; 2) else look the id up once on the provider
   (cached; failures are cached for 6h so a missing endpoint costs one call per id, not one per refresh).
   ═══════════════════════════════════════════════════════════ */
const leagueNames = new Map();          // id -> { name, country } | { miss: ts }
const LEAGUE_MISS_TTL = 6 * 3600 * 1000;
let leagueShapeLogged = false;
function leagueFromEvent(ev) {
  const l = ev && (ev.league || ev.tournament || ev.competition);
  const name = (l && typeof l === 'object' ? l.name : typeof l === 'string' ? l : null) || ev.league_name || ev.tournament_name || ev.competition_name;
  const c = l && typeof l === 'object' ? (l.country && typeof l.country === 'object' ? l.country.name : l.country) : (ev.country_name || ev.country);
  return name ? { name: String(name).slice(0, 80), country: c ? String(c).slice(0, 40) : null } : null;
}
async function lookupLeague(id) {
  for (const path of [`/v2/leagues/${id}/`, `/leagues/${id}/`]) {
    try {
      const r = await fetch(`${BZZOIRO_API_BASE}${path}`, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const d = await r.json();
      const o = d && (d.data || d.result || d);
      if (!leagueShapeLogged) { leagueShapeLogged = true; console.log('League lookup shape:', path, Object.keys(o || {}).slice(0, 15).join(',')); }
      const hit = leagueFromEvent({ league: o });
      if (hit) return hit;
    } catch (e) { /* try the next path */ }
  }
  return null;
}
async function resolveLeagueNames(events) {
  if (!BZZOIRO_API_KEY || !Array.isArray(events)) return;
  const todo = new Set();
  for (const ev of events) {
    const id = ev && ev.league_id != null ? String(ev.league_id) : null;
    if (!id) continue;
    const inEv = leagueFromEvent(ev);
    if (inEv) { leagueNames.set(id, inEv); continue; }
    const c = leagueNames.get(id);
    if (!c || (c.miss && Date.now() - c.miss > LEAGUE_MISS_TTL)) todo.add(id);
  }
  const ids = [...todo].slice(0, 40);        // bounded per refresh; the rest resolve on later refreshes
  for (let i = 0; i < ids.length; i += 6) {
    await Promise.all(ids.slice(i, i + 6).map(async id => {
      const hit = await lookupLeague(id);
      leagueNames.set(id, hit || { miss: Date.now() });
    }));
  }
}
function leagueLabel(ev, fdMatch) {
  if (fdMatch && fdMatch.competition && fdMatch.competition.name) return fdMatch.competition.name;
  const c = ev.league_id != null ? leagueNames.get(String(ev.league_id)) : null;
  if (c && c.name) return c.country && !c.name.toLowerCase().includes(String(c.country).toLowerCase()) ? `${c.country} · ${c.name}` : c.name;
  return ev.league_id ? `League #${ev.league_id}` : 'Football';
}

async function getFixtures() {
  if (fixturesCache.data && Date.now() - fixturesCache.ts < FIXTURES_TTL) return fixturesCache.data;
  if (fixturesFetchInProgress) return fixturesFetchInProgress;

  fixturesFetchInProgress = (async () => {
    try {
      const eventsP = fetchBzzoiroEvents().catch(() => []);
      const fdP = API_KEY ? fetchFdMatches() : Promise.resolve([]);
      const afP = apiFootball.fetchToday().catch(() => []);   // optional 3rd source (APIFOOTBALL_KEY): many more leagues

      let oddsMap = oddsCache.data;
      if (!oddsMap || Date.now() - oddsCache.ts > ODDS_TTL) {
        oddsMap = await fetchOdds().catch(() => oddsMap || new Map());
      }
      if (!oddsMap) oddsMap = new Map();

      const [bzzEvents, fdMatches] = await Promise.all([eventsP, fdP]);
      await resolveLeagueNames(bzzEvents).catch(() => {});
      const fixtures = [], usedFdIds = new Set();

      for (const ev of bzzEvents) {
        if (!ev.home_team || !ev.away_team) continue;

        const raw = String(ev.status || '').toLowerCase();
        if (raw.includes('cancel') || raw.includes('abandon') || raw.includes('postponed')) continue;
        const kickoff = new Date(ev.event_date);
        if (isNaN(kickoff.getTime())) continue;

        let fdMatch = null;
        for (const m of fdMatches) {
          if (usedFdIds.has(m.id)) continue;
          if (teamsMatchAny(ev.home_team, m.homeTeam.name) && teamsMatchAny(ev.away_team, m.awayTeam.name)) {
            fdMatch = m; usedFdIds.add(m.id); break;
          }
        }
        if (!fdMatch) {   // different spellings: same kick-off + same pairing (one team named exactly the same, or both similar)
          for (const m of fdMatches) {
            if (usedFdIds.has(m.id)) continue;
            if (Math.abs(Date.parse(m.utcDate) - kickoff.getTime()) > 15 * 60 * 1000) continue;
            if (samePairing(ev.home_team, ev.away_team, m.homeTeam.name, m.awayTeam.name)) { fdMatch = m; usedFdIds.add(m.id); break; }
          }
        }

        const hf = (fdMatch ? formCache.get(fdMatch.homeTeam.id)?.data : null) || bzzFormCache.map.get(teamNameKey(ev.home_team)) || null;
        const af = (fdMatch ? formCache.get(fdMatch.awayTeam.id)?.data : null) || bzzFormCache.map.get(teamNameKey(ev.away_team)) || null;

        const bzzS = normalizeStatus(ev.status, ev.event_date);
        const fdS = fdMatch ? normalizeStatus(fdMatch.status, fdMatch.utcDate) : null;
        let status = fdS ? pickBetterStatus(bzzS, fdS) : bzzS;

        let homeScore, awayScore;
        const fdHasScore = fdMatch
          && (fdS === 'started' || fdS === 'finished')
          && fdMatch.score?.fullTime?.home != null
          && fdMatch.score?.fullTime?.away != null;

        if (fdHasScore) {
          homeScore = fdMatch.score.fullTime.home;
          awayScore = fdMatch.score.fullTime.away;
        } else {
          homeScore = ev.home_score ?? 0;
          awayScore = ev.away_score ?? 0;
        }

        // Finished but the feed has no score (yet): it is FINISHED with an unknown score, never "LIVE 0-0" for ever.
        // The real score is filled in as soon as the provider sends it; until then nothing is graded on it.
        // Same when only the CLOCK made it finished (the feed still says "live" hours after kick-off) and our copy of the feed is old:
        // the score in it may be the 0-0 of minute one, so it is not a verified final result.
        const clockOnly = status === 'finished' && normalizeStatus(ev.status, null) !== 'finished' && fdS !== 'finished';
        let resultPending;
        if (status === 'finished' && !fdHasScore && (ev.home_score == null || ev.away_score == null || (clockOnly && !eventsFresh()))) { homeScore = null; awayScore = null; resultPending = true; }
        const fixture = {
          id: `bzz_${ev.id}`,
          league: leagueLabel(ev, fdMatch),
          women: WOMEN_LEAGUE_IDS.has(String(ev.league_id)) || undefined,
          date: kickoff.toISOString().slice(0, 10),
          kickoff: kickoff.toISOString().slice(11, 16),
          status, homeScore, awayScore, resultPending,
          home: {
            id: fdMatch?.homeTeam.id || null,
            name: ev.home_team,
            logo: localLogo(ev.home_team) || fdMatch?.homeTeam?.crest || ev.home_team_logo || ev.home_logo || cachedLogo(ev.home_team) || null,
            form: hf?.form || null,
            gf5: hf?.gf5 ?? null,
            ga5: hf?.ga5 ?? null,
            formN: hf?.n ?? null
          },
          away: {
            id: fdMatch?.awayTeam.id || null,
            name: ev.away_team,
            logo: localLogo(ev.away_team) || fdMatch?.awayTeam?.crest || ev.away_team_logo || ev.away_logo || cachedLogo(ev.away_team) || null,
            form: af?.form || null,
            gf5: af?.gf5 ?? null,
            ga5: af?.ga5 ?? null,
            formN: af?.n ?? null
          },
          odds: mergeOdds(oddsMap.get(normalizeTeamKey(ev.home_team, ev.away_team)), ev.home_team, ev.away_team),
          h2h: ev.head_to_head || null,
          sources: fdMatch ? ['bzz', 'fd'] : ['bzz']
        };
        estimateXGForFixture(fixture);
        fixtures.push(fixture);
      }

      for (const m of fdMatches) {
        if (usedFdIds.has(m.id)) continue;
        const kickoff = new Date(m.utcDate);
        if (isNaN(kickoff.getTime())) continue;
        const hf = formCache.get(m.homeTeam.id)?.data, af = formCache.get(m.awayTeam.id)?.data;
        const odds = oddsMap.get(normalizeTeamKey(m.homeTeam.name, m.awayTeam.name));

        const fixture = {
          id: String(m.id),
          league: m.competition?.name || 'N/A',
          date: kickoff.toISOString().slice(0, 10),
          kickoff: kickoff.toISOString().slice(11, 16),
          status: normalizeStatus(m.status, m.utcDate),
          homeScore: m.score?.fullTime?.home ?? 0,
          awayScore: m.score?.fullTime?.away ?? 0,
          home: { id: m.homeTeam.id, name: m.homeTeam.name, logo: localLogo(m.homeTeam.name) || m.homeTeam.crest || cachedLogo(m.homeTeam.name) || null, form: hf?.form || null, gf5: hf?.gf5 ?? null, ga5: hf?.ga5 ?? null, formN: hf?.n ?? null },
          away: { id: m.awayTeam.id, name: m.awayTeam.name, logo: localLogo(m.awayTeam.name) || m.awayTeam.crest || cachedLogo(m.awayTeam.name) || null, form: af?.form || null, gf5: af?.gf5 ?? null, ga5: af?.ga5 ?? null, formN: af?.n ?? null },
          odds: mergeOdds(odds, m.homeTeam.name, m.awayTeam.name),
          sources: odds ? ['fd', 'bzz'] : ['fd']
        };
        if (fixture.status === 'finished' && (m.score?.fullTime?.home == null || m.score?.fullTime?.away == null)) { fixture.homeScore = null; fixture.awayScore = null; fixture.resultPending = true; }
        estimateXGForFixture(fixture);
        fixtures.push(fixture);
      }

      // API-Football: added last, so a match the other sources already have is merged into theirs by dedupeFixtures (same
      // kick-off +-15 min and same pairing) and keeps the Bzzoiro id, odds and forms.
      for (const a of await afP) {
        const hf = bzzFormCache.map.get(teamNameKey(a.home.name)) || null, af = bzzFormCache.map.get(teamNameKey(a.away.name)) || null;
        const iso = a.date + 'T' + a.kickoff + ':00Z';
        const fixture = Object.assign({}, a, {
          status: normalizeStatus(a.rawStatus, iso),
          home: Object.assign({}, a.home, { logo: localLogo(a.home.name) || a.home.logo || cachedLogo(a.home.name) || null, form: hf?.form || null, gf5: hf?.gf5 ?? null, ga5: hf?.ga5 ?? null, formN: hf?.n ?? null }),
          away: Object.assign({}, a.away, { logo: localLogo(a.away.name) || a.away.logo || cachedLogo(a.away.name) || null, form: af?.form || null, gf5: af?.gf5 ?? null, ga5: af?.ga5 ?? null, formN: af?.n ?? null }),
          odds: mergeOdds(oddsMap.get(normalizeTeamKey(a.home.name, a.away.name)), a.home.name, a.away.name)
        });
        delete fixture.rawStatus;
        if (fixture.status === 'canceled') continue;
        if (fixture.status === 'finished' && fixture.resultPending) { fixture.homeScore = null; fixture.awayScore = null; }
        estimateXGForFixture(fixture);
        fixtures.push(fixture);
      }

      const deduped = dedupeFixtures(fixtures);
      deduped.forEach(f => { f.big = (isBigTeam(f.home.name) ? 1 : 0) + (isBigTeam(f.away.name) ? 1 : 0); });
      try { recordSnapshots(deduped); } catch (e) { console.error('Snapshot error:', e.message); }
      const list = stabilizeToday(deduped);
      fixturesCache.data = list; fixturesCache.ts = Date.now(); lastFixtures = list;
      return list;
    } finally { fixturesFetchInProgress = null; }
  })();
  return fixturesFetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   PERSISTENT SNAPSHOT STORE
   ═══════════════════════════════════════════════════════════ */
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, 'data', 'history.json');
const HISTORY_KEEP_DAYS = 60;
const RESULTS_REFRESH_TTL = BZZ_LOW ? 60 * 60 * 1000 : 5 * 60 * 1000;
const snapshotStore = new Map();
let resultsRefreshInProgress = null;
const enginePre = require('./engine/prematch');

// Frozen pre-match pick: computed server-side from REAL inputs only (engine returns null when xG is a league-avg/h2h guess
// and there is no market). It is refreshed while the match is 'notstarted' and never touched again after kickoff,
// so Performance / Weekly / Chart no longer change when the user moves a slider or the model is retuned.
function freezePick(f, prevPick) {
  try {
    const lg = getLeagueAvgs();
    const fx = lg.has(f.league) ? Object.assign({}, f, { leagueAvg: lg.get(f.league) }) : f;
    const pred = enginePre.predict(fx, { marketWeight: ENGINE_MARKET_WEIGHT, eloWeight: ENGINE_ELO_WEIGHT, eloBook: getEloBook() });
    if (!pred || !pred.p) return null;
    const best = [['home', pred.p.h], ['draw', pred.p.d], ['away', pred.p.a]].sort((x, y) => y[1] - x[1])[0];
    // The REAL value-bet decision (same gate as the site) is frozen too, so tracking measures the bets users were actually shown.
    // firstOdds/firstAt = the price when this bet was first flagged (what a user could have taken); CLV compares it with the closing price.
    let bet = null;
    const dec = require('./engine/decision').decide(fx, pred, { minBooks: ENGINE_MIN_BOOKS, maxGap: ENGINE_MAX_GAP, maxEV: ENGINE_MAX_EV });
    if (dec.action === 'BET' && dec.pick) {
      const pb = prevPick && prevPick.bet && prevPick.bet.key === dec.pick.key ? prevPick.bet : null;
      bet = { key: dec.pick.key, odds: dec.pick.odds, book: dec.pick.book, p: +dec.pick.p.toFixed(4), ev: +dec.pick.ev.toFixed(4),
        firstOdds: pb ? (pb.firstOdds || pb.odds) : dec.pick.odds, firstAt: pb ? (pb.firstAt || pb.at || Date.now()) : Date.now(), at: Date.now() };
    }
    return { key: best[0], p: +best[1].toFixed(4), ou: pred.over == null ? null : (pred.over >= 0.5 ? 'over' : 'under'), ouP: pred.over == null ? null : +Math.max(pred.over, 1 - pred.over).toFixed(4), ou15: pred.over15 == null ? null : (pred.over15 >= 0.5 ? 'over' : 'under'), ou15P: pred.over15 == null ? null : +Math.max(pred.over15, 1 - pred.over15).toFixed(4), ou15Est: pred.over15Source === 'market-implied' ? true : undefined, source: pred.source, bet, at: Date.now() };
  } catch (e) { console.error('freezePick error:', e.message); return null; }
}

function dateDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function loadSnapshots() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (!Array.isArray(arr)) return;
    const cutoff = dateDaysAgo(HISTORY_KEEP_DAYS);
    for (const f of arr) if (f && f.id && f.date >= cutoff) snapshotStore.set(f.id, f);
    console.log(`📚 Loaded ${snapshotStore.size} saved matches from ${HISTORY_FILE}`);
  } catch (e) { console.error('History load error:', e.message); }
}

const snapshotSaver = makeSaver('History', () => {
  const cutoff = dateDaysAgo(HISTORY_KEEP_DAYS);
  for (const [id, f] of snapshotStore) if (f.date < cutoff) snapshotStore.delete(id);
  writeAtomic(HISTORY_FILE, JSON.stringify([...snapshotStore.values()]));
}, 2000);
// snapshotVersion changes with every saved change to the history: /api/history reuses its JSON until then.
let snapshotVersion = 0;
const saveSnapshotsSoon = () => { snapshotVersion++; snapshotSaver.soon(); };

function recordSnapshots(fixtures) {
  let changed = false;
  for (const f of fixtures) {
    if (!f || !f.id || !f.home || !f.away) continue;
    const prev = snapshotStore.get(f.id);

    if (!prev) {
      if (f.status !== 'notstarted') continue;
      snapshotStore.set(f.id, Object.assign(JSON.parse(JSON.stringify(f)), { openOdds: JSON.parse(JSON.stringify(f.odds || [])), pick: freezePick(f, null) }));
      changed = true;
      continue;
    }

    if (prev.status === 'notstarted' && f.status === 'notstarted') {
      const open = prev.openOdds || JSON.parse(JSON.stringify(prev.odds || []));
      snapshotStore.set(f.id, Object.assign(JSON.parse(JSON.stringify(f)), { openOdds: open, pick: freezePick(f, prev.pick) || prev.pick || null }));
      changed = true;
      continue;
    }

    if (f.status !== 'canceled' && (prev.status !== f.status || prev.homeScore !== f.homeScore || prev.awayScore !== f.awayScore)) {
      const prevFinal = prev.status === 'finished' && Number.isInteger(prev.homeScore) && Number.isInteger(prev.awayScore);
      const fHasScore = Number.isInteger(f.homeScore) && Number.isInteger(f.awayScore);
      // A settled result is never overwritten by a feed that has no score (or went back to "live").
      if ((prev.status !== 'finished' || f.status === 'finished') && !(prevFinal && !fHasScore)) {
        prev.status = f.status; prev.homeScore = f.homeScore; prev.awayScore = f.awayScore;
        changed = true;
      }
    }
    if (!prev.home.logo && f.home.logo) { prev.home.logo = f.home.logo; changed = true; }
    if (!prev.away.logo && f.away.logo) { prev.away.logo = f.away.logo; changed = true; }
  }
  if (changed) saveSnapshotsSoon();
}

// A snapshot that is still not settled this many days after kick-off is given up on: the provider will not settle it, and asking for it
// every few minutes for ever (postponed / dropped matches) is what used to burn the whole daily request quota.
const RESULTS_LOOKBACK_DAYS = 4;
const toScore = v => { if (v == null || v === '') return null; const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : null; };
const settledSnap = f => f.status === 'canceled' || (f.status === 'finished' && Number.isInteger(f.homeScore) && Number.isInteger(f.awayScore));

async function refreshHistoryResults() {
  if (!BZZOIRO_API_KEY) return;
  if (Date.now() - historyCache.ts < RESULTS_REFRESH_TTL) return;
  if (!bzzBudgetOk(false)) return;
  if (resultsRefreshInProgress) return resultsRefreshInProgress;

  const now = Date.now(), oldestT = now - RESULTS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const pending = new Map();   // snapshot id -> snapshot: played (kick-off passed), recent, and without a final score yet
  for (const f of snapshotStore.values()) {
    if (!f || !String(f.id).startsWith('bzz_') || settledSnap(f) || (f.notFound | 0) >= 3) continue;   // notFound: the provider no longer lists it (3 full scans): stop asking
    const t = new Date(f.date + 'T' + f.kickoff + ':00Z').getTime();
    if (isNaN(t) || t > now || t < oldestT) continue;
    pending.set(f.id, f);
  }
  if (!pending.size) { historyCache.ts = Date.now(); return; }

  resultsRefreshInProgress = (async () => {
    try {
      const oldest = [...pending.values()].reduce((m, f) => (f.date < m ? f.date : m), todayStr());
      const dateFrom = oldest < dateDaysAgo(RESULTS_LOOKBACK_DAYS) ? dateDaysAgo(RESULTS_LOOKBACK_DAYS) : oldest;
      let url = `${BZZOIRO_API_BASE}/v2/events/?date_from=${dateFrom}&date_to=${todayStr()}`;
      let changed = false;
      const seen = new Set();

      for (let page = 0; url && pending.size && page < (BZZ_LOW ? 3 : 10); page++) {
        if (!bzzBudgetOk(false)) break;
        bzzCount();
        const r = await fetch(url, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`Results refresh HTTP ${r.status}`);
        const data = await r.json();
        for (const ev of (data.results || data.data || [])) {
          const id = `bzz_${ev.id}`, snap = pending.get(id);
          if (!snap) continue;
          seen.add(id);
          const ns = normalizeStatus(ev.status, ev.event_date);
          if (ns === 'canceled') { snap.status = 'canceled'; pending.delete(id); changed = true; continue; }   // postponed / abandoned: nothing will ever settle it
          const hs = toScore(ev.home_score), as = toScore(ev.away_score);
          if (hs == null || as == null) continue;
          if (ns === 'started') {   // still being played: follow the live score, never settle it
            if (snap.status !== 'started' || snap.homeScore !== hs || snap.awayScore !== as) {
              snap.status = 'started'; snap.homeScore = hs; snap.awayScore = as; changed = true;
            }
            continue;
          }
          if (ns !== 'finished') continue;
          snap.status = 'finished';
          snap.homeScore = hs;
          snap.awayScore = as;
          delete snap.resultPending;
          pending.delete(id);
          changed = true;
        }
        url = bzzNextUrl(data.next);
      }
      // The whole date range was read and a match is still not in it: count it, and give up after 3 such scans (instead of asking for ever).
      if (!url) for (const [id, snap] of pending) if (!seen.has(id)) { snap.notFound = (snap.notFound | 0) + 1; changed = true; }
      if (changed) { saveSnapshotsSoon(); fixturesCache.data = null; }
      historyCache.ts = Date.now();
    } catch (e) {
      console.error(e.message);
      historyCache.ts = Date.now() - RESULTS_REFRESH_TTL + 60 * 1000;   // failed: try again in a minute, not on every request
    } finally { resultsRefreshInProgress = null; }
  })();
  return resultsRefreshInProgress;
}

loadSnapshots();

/* ═══════════════════════════════════════════════════════════
   KEYAUTH HELPERS
   ═══════════════════════════════════════════════════════════ */
async function keyauthRequest(params) {
  // Send as POST form-encoded so the app secret and user password never appear
  // in the URL, query string, or proxy/CDN access logs (O-07).
  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => body.append(k, v));
  const r = await fetch(KEYAUTH_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`KeyAuth HTTP ${r.status}`);
  return r.json();
}

async function keyauthInit() {
  return keyauthRequest({ type: 'init', ver: KEYAUTH_VERSION, name: KEYAUTH_NAME, ownerid: KEYAUTH_OWNERID, secret: KEYAUTH_SECRET });
}

async function keyauthLogin(username, password, sessionid, hwid) {
  return keyauthRequest({
    type: 'login',
    username,
    pass: password,
    hwid: hwid || '',
    sessionid,
    name: KEYAUTH_NAME,
    ownerid: KEYAUTH_OWNERID,
    secret: KEYAUTH_SECRET
  });
}

/* ═══════════════════════════════════════════════════════════
   GOOGLE SIGN-IN  (ID-token verification, zero external deps)
   The browser gets a JWT from Google Identity Services and POSTs it
   to /api/auth/google. We verify the RS256 signature locally against
   Google's published JWKS (cached), so there is no per-login round-trip.
   ═══════════════════════════════════════════════════════════ */
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
if (!GOOGLE_CLIENT_ID) console.error('❌ GOOGLE_CLIENT_ID is not set: Sign in with Google is disabled until it is.');
const APPLE_CLIENT_ID = String(process.env.APPLE_CLIENT_ID || '').trim();   // the Services ID, e.g. com.lucibet.web
if (!APPLE_CLIENT_ID) console.error('❌ APPLE_CLIENT_ID is not set: Sign in with Apple is disabled until it is.');

const b64urlBuf = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlJson = s => JSON.parse(b64urlBuf(s).toString('utf8'));

// Generic OIDC ID-token verifier. Caches the provider's JWKS and verifies the RS256 signature locally,
// then checks iss / aud / exp / email_verified. Returns the claims or throws. Never trust a field before this returns.
function makeOidcVerifier({ name, jwksUrl, issuers }) {
  let cache = { keys: new Map(), exp: 0 };
  async function keys(force) {
    const now = Date.now();
    if (!force && cache.exp > now && cache.keys.size) return cache.keys;
    const r = await fetch(jwksUrl, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(name + ' certs HTTP ' + r.status);
    const jwks = await r.json();
    const m = new Map();
    for (const jwk of (jwks.keys || [])) {
      if (jwk.kid && jwk.kty === 'RSA') { try { m.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch (e) {} }
    }
    if (!m.size) throw new Error('no ' + name + ' keys');
    const cc = /max-age=(\d+)/i.exec(r.headers.get('cache-control') || '');   // honour the provider's rotation window, cap 6h, floor 5min
    cache = { keys: m, exp: now + Math.max(300, Math.min(cc ? +cc[1] : 3600, 21600)) * 1000 };
    return m;
  }
  return async function verify(idToken, aud) {
    if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 8192) throw new Error('bad token');
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const [h, p, s] = parts;
    const header = b64urlJson(h);
    if (header.alg !== 'RS256' || !header.kid) throw new Error('bad alg');
    let key = (await keys()).get(header.kid);
    if (!key) key = (await keys(true)).get(header.kid);     // key rotated: refresh once and retry
    if (!key) throw new Error('unknown key');
    const v = crypto.createVerify('RSA-SHA256');
    v.update(h + '.' + p); v.end();
    if (!v.verify(key, b64urlBuf(s))) throw new Error('bad signature');
    const c = b64urlJson(p);
    const now = Math.floor(Date.now() / 1000);
    if (!issuers.has(c.iss)) throw new Error('bad iss');
    if (c.aud !== aud) throw new Error('aud mismatch');
    if (!(Number(c.exp) > now - 60)) throw new Error('expired');
    if (c.nbf && Number(c.nbf) > now + 60) throw new Error('not yet valid');
    if (c.email_verified !== true && c.email_verified !== 'true') throw new Error('email not verified');
    if (!c.email) throw new Error('no email');
    return c;
  };
}

const verifyGoogleIdToken = makeOidcVerifier({ name: 'google', jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', issuers: new Set(['https://accounts.google.com', 'accounts.google.com']) });
const verifyAppleIdToken  = makeOidcVerifier({ name: 'apple',  jwksUrl: 'https://appleid.apple.com/auth/keys',        issuers: new Set(['https://appleid.apple.com']) });

/* ═══════════════════════════════════════════════════════════
   AUTH MIDDLEWARE & ENDPOINTS
   ═══════════════════════════════════════════════════════════ */
// Cookie-based sessions (HttpOnly) + double-submit CSRF.
// The session token lives in an HttpOnly cookie so no page script — and therefore no XSS — can read it. A second,
// JS-readable cookie carries a CSRF token; a cookie-authenticated state-changing call must echo it in X-CSRF-Token.
// The Authorization: Bearer header still works for API clients and tests (header auth is not sent cross-site, so it
// is not CSRF-prone and is exempt from the CSRF check).
const COOKIE_SESS = 'mde_sess', COOKIE_CSRF = 'mde_csrf';
function parseCookies(req) {
  const out = {}, h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const k = part.slice(0, i).trim(); if (!k || out[k] !== undefined) continue;
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  }
  return out;
}
const isHttps = req => req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function setSessionCookies(req, res, token) {
  const base = `Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}; SameSite=Lax` + (isHttps(req) ? '; Secure' : '');
  const csrf = crypto.randomBytes(18).toString('hex');
  res.append('Set-Cookie', `${COOKIE_SESS}=${token}; HttpOnly; ${base}`);
  res.append('Set-Cookie', `${COOKIE_CSRF}=${csrf}; ${base}`);
  return csrf;
}
function clearSessionCookies(req, res) {
  const base = `Path=/; Max-Age=0; SameSite=Lax` + (isHttps(req) ? '; Secure' : '');
  res.append('Set-Cookie', `${COOKIE_SESS}=; HttpOnly; ${base}`);
  res.append('Set-Cookie', `${COOKIE_CSRF}=; ${base}`);
}
function authMiddleware(req, res, next) {
  const cookies = req.headers.cookie ? parseCookies(req) : {};
  let token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''), viaCookie = false;
  if (!token && cookies[COOKIE_SESS]) { token = cookies[COOKIE_SESS]; viaCookie = true; }
  if (!token || token.length > 200) return res.status(401).json({ error: 'Authentication required' });
  const key = tokHash(token), now = Date.now();
  const sess = sessions.get(key);
  if (!sess || sessionExpired(sess, now)) {
    if (sess) { sessions.delete(key); saveSessionsSoon(); }
    return res.status(401).json({ error: 'Session expired' });
  }
  // CSRF: a cookie-authenticated write must present the matching double-submit token. Header-auth clients are exempt.
  if (viaCookie && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    if (!cookies[COOKIE_CSRF] || (req.headers['x-csrf-token'] || '') !== cookies[COOKIE_CSRF]) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
    }
  }
  if (now - (sess.lastSeen || 0) > 10 * 60 * 1000) { sess.lastSeen = now; saveSessionsSoon(); }
  req.authToken = key;
  next();
}

app.disable('x-powered-by');
// Social sign-in origins: Google Identity Services (gsi/client + accounts.google.com iframe) and
// Sign in with Apple (appleid.cdn-apple.com SDK + appleid.apple.com popup/iframe).
const GSI_ORIGIN = 'https://accounts.google.com';
const APPLE_SDK = 'https://appleid.cdn-apple.com';
const APPLE_ORIGIN = 'https://appleid.apple.com';
// script-src no longer allows 'unsafe-inline': the HTML page carries a per-request nonce on its inline <script> blocks
// (see sendIndex) and every inline on* handler was moved to delegated listeners. An injected <script> without the nonce
// cannot execute. style-src keeps 'unsafe-inline' (inline styles are pervasive and far lower risk). A nonce is only
// meaningful on the HTML document; other responses (JSON/assets) use the no-nonce form, which also forbids inline scripts.
function cspHeader(nonce) {
  const script = nonce
    ? `script-src 'self' 'nonce-${nonce}' ${GSI_ORIGIN} ${APPLE_SDK}`
    : `script-src 'self' ${GSI_ORIGIN} ${APPLE_SDK}`;
  return [
    "default-src 'self'",
    script,
    `style-src 'self' 'unsafe-inline' ${GSI_ORIGIN}`,
    "font-src 'self'",
    "img-src 'self' data: https:",
    `connect-src 'self' ${GSI_ORIGIN} ${APPLE_ORIGIN}`,
    `frame-src 'self' ${GSI_ORIGIN} ${APPLE_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action 'self' ${APPLE_ORIGIN}`,
    "frame-ancestors 'none'"
  ].join('; ');
}
const CSP = cspHeader(null);
// ── Load shedding: bound the number of requests in flight at once so a burst flood (or a slow upstream data feed)
// cannot pile up, exhaust the event loop and memory, and take the whole process down. The ceiling sits well above
// real traffic; past it we shed with a cheap 503 + Retry-After instead of degrading for everyone. ──
const MAX_INFLIGHT = Math.max(50, parseInt(process.env.MAX_INFLIGHT, 10) || 300);
let inFlight = 0;
app.use((req, res, next) => {
  if (inFlight >= MAX_INFLIGHT) {
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ error: 'Server is busy. Please try again in a moment.' });
  }
  inFlight++;
  let released = false;
  const release = () => { if (!released) { released = true; inFlight--; } };
  res.on('finish', release); res.on('close', release);
  next();
});
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');   // Sign in with Apple opens a popup that posts the result back
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Origin-Agent-Cluster', '?1');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'POST', 'OPTIONS'].includes(req.method)) return next();
  res.setHeader('Allow', 'GET, HEAD, POST, OPTIONS');
  res.status(405).json({ error: 'Method not allowed' });
});

// PROXY_COUNT: number of trusted reverse-proxy hops in front of this server.
// Railway alone = 1. Cloudflare → Railway = 2. Direct (no proxy) = 0.
// Wrong value lets clients forge X-Forwarded-For and bypass every per-IP rate limit.
const PROXY_COUNT = parseInt(process.env.PROXY_COUNT, 10);
app.set('trust proxy', Number.isInteger(PROXY_COUNT) && PROXY_COUNT >= 0 ? PROXY_COUNT : 1);
if (!Number.isInteger(PROXY_COUNT) || PROXY_COUNT < 0) console.warn('⚠️  PROXY_COUNT not set — defaulting to 1. Set PROXY_COUNT=2 if behind Cloudflare + Railway, or PROXY_COUNT=0 if exposed directly.');

function makeLimiter({ windowMs, max, message, maxKeys = 50000 }) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n - v.t > windowMs) hits.delete(k); }, Math.min(windowMs, 60 * 1000)).unref();
  return function limiter(req, res, next) {
    const ip = req.ip || 'unknown', now = Date.now();
    let e = hits.get(ip);
    if (!e || now - e.t > windowMs) {
      if (!e && hits.size >= maxKeys) return res.status(429).json({ error: message || 'Too many requests.' });
      e = { n: 0, t: now };
    }
    if (e.n >= max) {
      res.setHeader('Retry-After', String(Math.ceil((e.t + windowMs - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests. Slow down.' });
    }
    e.n++; hits.set(ip, e);
    next();
  };
}
const loginLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });
const otpLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });
const licenseLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });
const adminLimiter = makeLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: 'Too many attempts. Try again in a few minutes.' });
const registerLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 8, message: 'Too many sign-ups from this network. Try again later.' });
const apiLimiter = makeLimiter({ windowMs: 60 * 1000, max: 240, message: 'Too many requests. Slow down.' });
const dataLimiter = makeLimiter({ windowMs: 60 * 1000, max: 60, message: 'Too many requests. Slow down.' });
const pageLimiter = makeLimiter({ windowMs: 60 * 1000, max: 600, message: 'Too many requests. Slow down.' });
app.use('/api/', apiLimiter);

const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
app.use('/api/', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  let host = '';
  try { host = new URL(origin).host; } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
  const ok = host === req.headers.host || host === req.headers['x-forwarded-host'] || EXTRA_ORIGINS.includes(origin);
  if (!ok) return res.status(403).json({ error: 'Forbidden' });
  next();
});

// gzip/brotli-less compression for text responses (/api/history alone was ~7 MB of JSON uncompressed).
// Auth responses are excluded: they carry session tokens next to user input (no compression = no BREACH-style size oracle).
app.use(compression({ threshold: 1024, filter: (req, res) => !req.path.startsWith('/api/auth/') && compression.filter(req, res) }));
app.use(express.json({ limit: '10kb' }));
app.use(pageLimiter);
// Visit counter / live users: BEFORE express.static, which answers '/' and '/index.html' itself and never calls next() (the counter used to stay at 0).
app.use((req, res, next) => {
  if (req.method === 'GET') {
    const ip = req.ip || 'unknown';
    if (req.path === '/' || req.path.startsWith('/api/')) {
      activeUsers.set(ip, Date.now());
    }
    if (req.path === '/' || req.path === '/index.html') {
      totalVisits++;
      saveStatsSoon();
    }
  }
  next();
});
// Serve index.html ourselves (before express.static) so each load gets a fresh CSP nonce on its inline <script> blocks.
// The file is read once at startup (the container ships a fixed build); the nonce makes the response uncacheable.
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
let INDEX_HTML = '';
let CSS_BUNDLE = '';
try {
  INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');
  // one minified stylesheet + content-hashed asset URLs (see asset-pipeline.js); falls back to the raw page on any error
  try { const built = require('./asset-pipeline').build(INDEX_HTML, path.join(__dirname, 'public'), { '/odds-core.js': path.join(__dirname, 'engine', 'odds.js') }); INDEX_HTML = built.html; CSS_BUNDLE = built.bundle; }
  catch (e) { console.error('asset pipeline skipped:', e.message); }
} catch (e) { console.error('index.html read error:', e.message); }
function sendIndex(req, res) {
  if (!INDEX_HTML) return res.status(500).send('index unavailable');
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('Content-Security-Policy', cspHeader(nonce));
  // no-cache (revalidate every time) instead of no-store, so the back/forward cache can restore the page instantly
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML.split('<script>').join(`<script nonce="${nonce}">`));
}
app.get('/', sendIndex);
app.get('/index.html', sendIndex);
// The same pure odds core runs in the browser (sharp weighting, outlier filter, best price), so the Value Board matches the server engine.
const IMMUTABLE = 'public, max-age=31536000, immutable';
app.get('/odds-core.js', (req, res) => { res.type('application/javascript').set('Cache-Control', req.query.v ? IMMUTABLE : 'public, max-age=300').sendFile(path.join(__dirname, 'engine', 'odds.js')); });
app.get('/bundle.css', (req, res) => {
  if (!CSS_BUNDLE) return res.status(404).end();
  res.type('text/css').set('Cache-Control', req.query.v ? IMMUTABLE : 'no-cache').send(CSS_BUNDLE);
});
// a URL carrying ?v=<content hash> (added by asset-pipeline.js) never changes content, so it can be cached for a year
app.use((req, res, next) => { if (req.query && req.query.v) res.locals.immutable = true; next(); });
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'], dotfiles: 'deny', index: 'index.html',
  // fingerprinted URLs: one year. Fonts and vendor libraries: one year (their names change with their version).
  // Other images: 30 days. Anything else (unversioned scripts/styles) revalidates with its ETag so updates show up at once.
  setHeaders(res, file) {
    if (res.locals && res.locals.immutable) res.setHeader('Cache-Control', IMMUTABLE);
    else if (/\.woff2$/i.test(file) || /[\\/]vendor[\\/]/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000');
    else if (/\.(png|jpe?g|webp|avif|svg|ico)$/i.test(file)) res.setHeader('Cache-Control', 'public, max-age=2592000');
    else res.setHeader('Cache-Control', 'no-cache');
  }
}));

/* ═══════════════════════════════════════════════════════════
   ✅ TRACKING (Visits & Live Users)
   ═══════════════════════════════════════════════════════════ */
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'data', 'stats.json');
let totalVisits = 0;
try {
  if (fs.existsSync(STATS_FILE)) {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    totalVisits = data.totalVisits || 0;
  }
} catch (e) { console.error('Stats load error:', e.message); }

let statsSaveTimer = null;
function saveStatsSoon() {
  if (statsSaveTimer) return;
  statsSaveTimer = setTimeout(() => {
    statsSaveTimer = null;
    try { writeAtomic(STATS_FILE, JSON.stringify({ totalVisits })); } catch (e) {}
  }, 5000);
}

const activeUsers = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, time] of activeUsers) if (now - time > 5 * 60 * 1000) activeUsers.delete(ip);
}, 60 * 1000).unref();

/* ═══════════════════════════════════════════════════════════
   EMAIL ACCOUNTS
   ═══════════════════════════════════════════════════════════ */
const USERS_FILE = process.env.USERS_FILE || path.join(path.dirname(HISTORY_FILE), 'users.json');
const users = new Map();
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const u of arr) if (u && u.email && ((u.salt && u.hash) || u.kind === 'google' || u.kind === 'apple' || u.kind === 'email')) users.set(u.email, u);
    console.log(`👤 Loaded ${users.size} accounts`);
  } catch (e) { console.error('Users load error:', e.message); }
}
const userSaver = makeSaver('Users', () => writeAtomic(USERS_FILE, JSON.stringify([...users.values()])), 1000);
const saveUsersSoon = userSaver.soon;
loadUsers();
loadSessions();
loadFootballCache();
const TERMS_VERSION = '2026-11-01';
const SCRYPT_MAX = 3, SCRYPT_QUEUE = 40;
let scryptActive = 0;
const scryptWait = [];
// Password KDF cost: N = 2^SCRYPT_COST. Default 15 (32 MiB/hash) — above Node's 2^14 default and stronger against
// offline cracking if the user store ever leaks, while staying safe at SCRYPT_MAX concurrency on a small container.
// Every hash now stores the N it was made with (u.n); hashes written before this change have no u.n and are treated
// as the legacy 2^14, then transparently re-hashed to the current cost on the owner's next successful login.
const SCRYPT_COST = Math.max(14, Math.min(20, parseInt(process.env.SCRYPT_COST, 10) || 15));
const CUR_N = 2 ** SCRYPT_COST, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64, LEGACY_N = 16384;
const scryptMaxmem = N => 256 * N * SCRYPT_R;   // headroom over scrypt's 128*N*r need, so raising the cost never throws
const scryptAsync = (pw, salt, N = CUR_N) => new Promise((ok, no) => {
  const run = () => {
    scryptActive++;
    crypto.scrypt(pw, salt, SCRYPT_KEYLEN, { N, r: SCRYPT_R, p: SCRYPT_P, maxmem: scryptMaxmem(N) }, (e, k) => {
      scryptActive--;
      const next = scryptWait.shift(); if (next) next();
      e ? no(e) : ok(k);
    });
  };
  if (scryptActive < SCRYPT_MAX) run();
  else if (scryptWait.length < SCRYPT_QUEUE) scryptWait.push(run);
  else no(Object.assign(new Error('busy'), { busy: true }));
});
const DUMMY_SALT = crypto.randomBytes(16);
// Verify a plaintext password against a stored user record, at that record's own cost. Returns { ok, stale };
// stale = the stored hash is below the current cost and should be upgraded while we still hold the plaintext.
async function verifyPassword(u, password) {
  const N = u && Number.isInteger(u.n) ? u.n : LEGACY_N;
  const dk = await scryptAsync(password, Buffer.from(u.salt, 'hex'), N);
  const ok = crypto.timingSafeEqual(dk, Buffer.from(u.hash, 'hex'));
  return { ok, stale: ok && N < CUR_N };
}
// Re-hash an already-authenticated user's password at the current cost. Fire-and-forget: a failure keeps the old hash.
async function upgradeHash(u, password) {
  try {
    const salt = crypto.randomBytes(16);
    const hash = await scryptAsync(password, salt, CUR_N);
    u.salt = salt.toString('hex'); u.hash = hash.toString('hex'); u.n = CUR_N;
    saveUsersSoon();
  } catch (e) { /* non-fatal */ }
}

/* ═══════════════════════════════════════════════════════════
   EMAIL OTP
   ═══════════════════════════════════════════════════════════ */
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'LuciBet <onboarding@resend.dev>';
const OTP_ENABLED = !!RESEND_API_KEY;
const REQUIRE_OTP = process.env.REQUIRE_OTP === '1';
if (!OTP_ENABLED) console.error(REQUIRE_OTP
  ? '❌ REQUIRE_OTP=1 but RESEND_API_KEY is not set: email sign-up and login are DISABLED until it is.'
  : '⚠️ RESEND_API_KEY is not set: email OTP is OFF, so email logins skip the code check. Set REQUIRE_OTP=1 to refuse email logins instead.');
const otpUnavailable = res => (REQUIRE_OTP && !OTP_ENABLED)
  ? (res.status(503).json({ error: 'Email login is temporarily unavailable.' }), true)
  : false;
const OTP_TTL = 10 * 60 * 1000, OTP_RESEND_GAP = 45 * 1000, OTP_MAX_TRIES = 5, OTP_MAX_SENDS_PER_HOUR = 6;
const OTP_SECRET = crypto.randomBytes(32);
const otps = new Map();
const otpSends = new Map();
setInterval(() => {
  const n = Date.now();
  for (const [k, v] of otps) if (n > v.exp + 3600000) otps.delete(k);
  for (const [k, v] of otpSends) if (n - v.t > 3600000) otpSends.delete(k);
}, 10 * 60 * 1000).unref();
const otpHash = (email, code) => crypto.createHmac('sha256', OTP_SECRET).update(email + ':' + code).digest('hex');

// MAIL_API_URL is honoured ONLY under NODE_ENV=test (a local fake mail server for the OTP tests); production always uses Resend.
const MAIL_API_URL = process.env.NODE_ENV === 'test' && /^http:\/\/127\.0\.0\.1:\d+\//.test(process.env.MAIL_API_URL || '') ? process.env.MAIL_API_URL : 'https://api.resend.com/emails';
async function sendMail(to, subject, text, html) {
  const r = await fetch(MAIL_API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(`Mail API HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
}

// Branded OTP email (dark LuciBet identity). Absolute logo URL so it loads in email clients.
const MAIL_BASE = (process.env.PUBLIC_BASE_URL || 'https://1uciferxyz.com').replace(/\/+$/, '');
const MAIL_SUPPORT = process.env.SUPPORT_EMAIL || 'lucibetsupport@gmail.com';
function otpEmailText(code) {
  return `Your LuciBet login code is ${code}.\n\nUse it to sign in to your dashboard. It is valid for 10 minutes.\nDid not request it? You can safely ignore this email. Never share this code with anyone.\n\n${MAIL_BASE} · Need help? ${MAIL_SUPPORT}\n18+ only. Predictions are statistical estimates, not guaranteed outcomes. Bet responsibly.`;
}
function otpEmailHtml(code) {
  const C = String(code);
  return `<!DOCTYPE html><html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light"><title>Your LuciBet login code</title><style>body{margin:0;padding:0;width:100%!important;background:#060608}a{text-decoration:none}@media (max-width:520px){.card{width:100%!important;border-radius:0!important;border-left:0!important;border-right:0!important}.px{padding-left:24px!important;padding-right:24px!important}.code{font-size:34px!important;letter-spacing:10px!important}}</style></head>
<body style="margin:0;padding:0;background:#060608;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#060608;font-size:1px;line-height:1px;">Your LuciBet login code — valid for 10 minutes. Never share it with anyone.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#060608;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" class="card" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:480px;background:#111113;border:1px solid #232327;border-radius:20px;overflow:hidden;">
<tr><td class="px" style="padding:26px 32px 20px;border-bottom:1px solid #1d1d21;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="44" style="padding-right:12px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="44" height="44" align="center" valign="middle" style="width:44px;height:44px;background:#17171a;border:1px solid #2a2a2f;border-radius:12px;"><img src="${MAIL_BASE}/logo.png" width="26" height="30" alt="LuciBet" style="display:block;border:0;width:26px;height:auto;"></td></tr></table></td>
<td valign="middle"><div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:17px;font-weight:700;color:#F5F5F7;letter-spacing:-.02em;line-height:1;">LuciBet</div><div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#8E8E99;line-height:1.3;margin-top:3px;">Football value intelligence</div></td>
</tr></table></td></tr>
<tr><td class="px" style="padding:30px 32px 8px;"><h1 style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:21px;font-weight:700;color:#F5F5F7;letter-spacing:-.02em;">Your login code</h1><p style="margin:12px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:15px;line-height:1.6;color:#B0B0B8;">Use the code below to sign in to your LuciBet dashboard. It's valid for the next 10 minutes.</p></td></tr>
<tr><td class="px" style="padding:22px 32px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="background:#0c0c0e;border:1px solid #2997FF;border-radius:14px;padding:22px 16px;"><div class="code" style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:38px;font-weight:700;letter-spacing:12px;color:#ffffff;line-height:1;padding-left:12px;">${C}</div><div style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;color:#2997FF;font-weight:600;margin-top:12px;letter-spacing:.02em;">&#9679; Expires in 10 minutes</div></td></tr></table></td></tr>
<tr><td class="px" style="padding:18px 32px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#1C1C1F;border-radius:12px;padding:14px 16px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;line-height:1.55;color:#8E8E99;">Didn't try to sign in? You can safely ignore this email — no one can access your account without this code. <span style="color:#B0B0B8;">For your security, never share it with anyone, including LuciBet staff.</span></td></tr></table></td></tr>
<tr><td class="px" style="padding:24px 32px 28px;"><div style="height:1px;background:#1d1d21;line-height:1px;font-size:1px;">&nbsp;</div><p style="margin:18px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;line-height:1.6;color:#6c6c76;"><a href="${MAIL_BASE}" style="color:#B0B0B8;font-weight:600;">${MAIL_BASE.replace(/^https?:\/\//, '')}</a> &#183; Need help? <a href="mailto:${MAIL_SUPPORT}" style="color:#2997FF;">${MAIL_SUPPORT}</a></p><p style="margin:10px 0 0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;line-height:1.6;color:#54545c;">18+ only. Predictions are statistical estimates, not guaranteed outcomes. Bet responsibly.<br>&#169; 2026 LuciBet &#183; This is a transactional security email.</p></td></tr>
</table></td></tr></table></body></html>`;
}

async function sendOtp(email, extra) {
  const now = Date.now();
  const prev = otps.get(email);
  if (prev && now < prev.exp && now - prev.sentAt < OTP_RESEND_GAP) {
    return { ok: true, reused: true, resendIn: Math.ceil((OTP_RESEND_GAP - (now - prev.sentAt)) / 1000) };
  }
  const cap = otpSends.get(email) || { n: 0, t: now };
  if (now - cap.t > 3600000) { cap.n = 0; cap.t = now; }
  if (cap.n >= OTP_MAX_SENDS_PER_HOUR) return { error: 'Too many codes requested. Try again later.', status: 429 };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  // Reserve the slot BEFORE awaiting the mail: two quick requests (double click, login + resend) used to both pass the resend-gap check,
  // send two different codes, and the user then typed the one that had been overwritten.
  otps.set(email, { hash: otpHash(email, code), exp: now + OTP_TTL, tries: 0, sentAt: now, ...(extra || {}) });
  cap.n++; otpSends.set(email, cap);
  try {
    await sendMail(email, 'Your LuciBet login code', otpEmailText(code), otpEmailHtml(code));
  } catch (e) {
    console.error('OTP mail error:', e.message);
    if (prev) otps.set(email, prev); else otps.delete(email);   // nothing was delivered: give the slot (and the send allowance) back
    cap.n = Math.max(0, cap.n - 1);
    return { error: 'Could not send the code. Please try again.', status: 502 };
  }
  return { ok: true, resendIn: OTP_RESEND_GAP / 1000 };
}

// Security audit trail for privileged actions. One JSON line per event on stdout (collected by the host's log service).
// Never pass secrets (tokens, passwords, license keys) in `detail`.
function auditLog(action, req, detail) {
  try { console.log('AUDIT ' + JSON.stringify({ at: new Date().toISOString(), action, ip: (req && req.ip) || null, ...(detail || {}) })); } catch (e) { /* logging must never break a request */ }
}

function planOf(sess) {
  if (!sess) return 'free';
  if (sess.kind === 'keyauth') return sess.lifetime === true || !sess.expiry || sess.expiry > Date.now() ? 'pro' : 'free';
  const u = users.get(sess.username);
  return u && u.plan === 'pro' && (!u.planUntil || u.planUntil > Date.now()) ? 'pro' : 'free';
}

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (!ADMIN_EMAIL) console.error('❌ ADMIN_EMAIL is not set: the admin dashboard is DISABLED until it is configured in the environment.');
function isAdminSession(sess) {
  if (!sess || sess.username !== ADMIN_EMAIL) return false;
  const u = users.get(sess.username);
  if (!u || u.verified === false) return false;
  // A Google/Apple session already proves ownership of the admin address (the provider verified the email), so no OTP gate is needed.
  if (sess.kind === 'google' || sess.kind === 'apple') return true;
  if (sess.kind !== 'local') return false;
  // Email/password admin needs real email OTP. Without RESEND_API_KEY anyone could sign up with the admin e-mail first, so admin is refused.
  // The only bypass is for the automated tests (NODE_ENV=test), never in production.
  return OTP_ENABLED || (process.env.NODE_ENV === 'test' && process.env.ADMIN_ALLOW_NO_OTP === '1');
}
function requireAdmin(req, res, next) {
  if (isAdminSession(sessions.get(req.authToken))) return next();
  res.status(404).json({ error: 'Not found' });
}
function profileOf(sess) {
  const u = sess.kind === 'keyauth' ? null : users.get(sess.username);
  return {
    isAdmin: isAdminSession(sess),
    username: sess.username,
    name: String(sess.username).split('@')[0],
    uid: u ? 'USR' + String(u.seq).padStart(6, '0') : 'KEY-' + String(sess.username).slice(0, 8).toUpperCase(),
    plan: planOf(sess),
    planUntil: u ? u.planUntil || null : (sess.expiry || null),
    lifetime: u ? (u.plan === 'pro' && !u.planUntil) : sess.lifetime === true,
    since: u ? u.createdAt : sess.createdAt,
    kind: sess.kind || 'keyauth'
  };
}
function requirePro(req, res, next) {
  if (planOf(sessions.get(req.authToken)) === 'pro') return next();
  res.status(403).json({ error: 'Pro plan required', fixtures: [] });
}
function startSession(req, res, sess) {
  const token = crypto.randomBytes(32).toString('hex');
  const key = tokHash(token), now = Date.now();
  sessions.set(key, { ...sess, createdAt: now, lastSeen: now });
  const mine = [...sessions.entries()].filter(([, v]) => v.username === sess.username).sort((a, b) => b[1].createdAt - a[1].createdAt);
  for (const [k] of mine.slice(MAX_SESSIONS_PER_USER)) sessions.delete(k);
  saveSessionsSoon();
  const csrf = setSessionCookies(req, res, token);
  // token is still returned for API clients / tests; the web app ignores it and authenticates via the HttpOnly cookie.
  res.json({ token, csrf, username: sess.username, expiresIn: SESSION_TTL, profile: profileOf(sessions.get(key)) });
}
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

async function localLogin(req, res, email, password, uKey) {
  if (otpUnavailable(res)) return;
  const u = users.get(email);
  let ok = false;
  try {
    if (u) {
      const r = await verifyPassword(u, password);
      ok = r.ok;
      if (r.ok && r.stale) upgradeHash(u, password);   // transparently raise this account to the current KDF cost
    } else {
      await scryptAsync(password, DUMMY_SALT);          // dummy work for unknown users: no timing oracle
      ok = false;
    }
  } catch (e) {
    if (e && e.busy) return res.status(503).json({ error: 'Server is busy. Please try again in a moment.' });
    ok = false;
  }
  if (!ok) {
    const f = userFails.get(uKey) || { n: 0, t: Date.now() };
    f.n++; f.t = Date.now(); userFails.set(uKey, f);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  userFails.delete(uKey);
  if (!OTP_ENABLED) return startSession(req, res, { kind: 'local', username: email });
  const o = await sendOtp(email);
  if (!o.ok) return res.status(o.status).json({ error: o.error });
  res.json({ otpRequired: true, email, resendIn: o.resendIn });
}

app.post('/api/auth/register', registerLimiter, loginLimiter, async (req, res) => {
  if (otpUnavailable(res)) return;
  const body = req.body || {};
  const email = String(body.email || body.username || '').trim().toLowerCase();
  const password = body.password;
  if (body.consent !== true || body.ageConfirmed !== true) return res.status(400).json({ error: 'You must confirm you are 18 or older and accept the Terms and Privacy Policy.' });
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8 to 128 characters.' });
  if (users.size >= 50000) return res.status(503).json({ error: 'Registration is temporarily closed.' });
  const taken = u => u && u.verified !== false;
  if (taken(users.get(email))) return res.status(409).json({ error: 'This email is already registered. Please log in.' });
  // A sign-up still waiting for its emailed code must not have its password replaced by a second sign-up: otherwise someone else
  // could re-register the address with THEIR password and the real owner, typing the code from their inbox, would verify an
  // account whose password the other person chose. Same password = the same person retrying -> just (re)send the code.
  const pendingSignup = () => { const u = users.get(email), o = otps.get(email); return OTP_ENABLED && u && u.verified === false && o && Date.now() < o.exp ? u : null; };
  const samePassword = async u => (await verifyPassword(u, password)).ok;
  const PENDING_MSG = 'A sign-up for this email is already waiting for its verification code. Check your inbox, or try again in 10 minutes.';
  try {
    const pend = pendingSignup();
    if (pend) {
      if (!(await samePassword(pend))) return res.status(409).json({ error: PENDING_MSG, code: 'signup_pending' });
      const o = await sendOtp(email);
      if (!o.ok) return res.status(o.status).json({ error: o.error });
      return res.json({ otpRequired: true, email, resendIn: o.resendIn });
    }
    const salt = crypto.randomBytes(16);
    const hash = await scryptAsync(password, salt);
    const cur = users.get(email);
    if (taken(cur)) return res.status(409).json({ error: 'This email is already registered. Please log in.' });
    if (pendingSignup()) return res.status(409).json({ error: PENDING_MSG, code: 'signup_pending' });   // a parallel sign-up won the race
    if (cur) { cur.salt = salt.toString('hex'); cur.hash = hash.toString('hex'); cur.n = CUR_N; otps.delete(email); }
    else {
      const seq = [...users.values()].reduce((m, u) => Math.max(m, u.seq || 0), 0) + 1;
      users.set(email, { email, salt: salt.toString('hex'), hash: hash.toString('hex'), n: CUR_N, plan: 'free', planUntil: null, createdAt: Date.now(), seq, verified: !OTP_ENABLED, consentAt: Date.now(), termsVersion: TERMS_VERSION });
    }
    saveUsersSoon();
    if (!OTP_ENABLED) return startSession(req, res, { kind: 'local', username: email });
    const o = await sendOtp(email);
    if (!o.ok) return res.status(o.status).json({ error: o.error });
    res.json({ otpRequired: true, email, resendIn: o.resendIn });
  } catch (e) {
    if (e && e.busy) return res.status(503).json({ error: 'Server is busy. Please try again in a moment.' });
    res.status(500).json({ error: 'Server error' });
  }
});

// Passwordless e-mail login / sign-up: type an e-mail, get a 6-digit code, done. Existing password accounts use it too.
app.post('/api/auth/email-start', loginLimiter, otpLimiter, async (req, res) => {
  if (!OTP_ENABLED) return res.status(503).json({ error: 'Email login is temporarily unavailable.' });
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Please enter a valid email address.' });
  const u = users.get(email);
  let extra = null;
  if (!u) {
    if (body.consent !== true || body.ageConfirmed !== true) return res.status(403).json({ consentRequired: true, error: 'You must confirm you are 18 or older and accept the Terms and Privacy Policy.' });
    extra = { newUser: { consentAt: Date.now() } };
  }
  const o = await sendOtp(email, extra);
  if (!o.ok) return res.status(o.status).json({ error: o.error });
  res.json({ otpRequired: true, email, resendIn: o.resendIn });
});

app.post('/api/auth/verify-otp', otpLimiter, (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').replace(/\D/g, '');
  let u = users.get(email);
  const rec = otps.get(email);
  if (!rec || Date.now() > rec.exp || (!u && !rec.newUser)) return res.status(400).json({ error: 'Code expired. Please request a new one.' });
  if (rec.tries >= OTP_MAX_TRIES) { otps.delete(email); return res.status(429).json({ error: 'Too many wrong attempts. Please request a new code.' }); }
  rec.tries++;
  const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(otpHash(email, code), 'hex'), Buffer.from(rec.hash, 'hex'));
  if (!ok) return res.status(400).json({ error: 'Wrong code.', triesLeft: OTP_MAX_TRIES - rec.tries });
  otps.delete(email);
  if (!u) {
    // Passwordless sign-up: the account only exists once the emailed code proves the address (no junk rows from unverified e-mails).
    if (users.size >= 50000) return res.status(503).json({ error: 'Registration is temporarily closed.' });
    const seq = [...users.values()].reduce((m, x) => Math.max(m, x.seq || 0), 0) + 1;
    u = { email, kind: 'email', plan: 'free', planUntil: null, createdAt: Date.now(), seq, verified: true, consentAt: rec.newUser.consentAt, termsVersion: TERMS_VERSION };
    users.set(email, u);
    saveUsersSoon();
  } else if (u.verified === false) { u.verified = true; saveUsersSoon(); }
  startSession(req, res, { kind: 'local', username: email });
});

app.post('/api/auth/resend-otp', otpLimiter, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const rec = otps.get(email);
  if (!OTP_ENABLED || !rec || (!users.has(email) && !rec.newUser)) return res.status(400).json({ error: 'Please log in again to get a new code.' });
  const o = await sendOtp(email, rec.newUser ? { newUser: rec.newUser } : null);
  if (!o.ok) return res.status(o.status).json({ error: o.error });
  if (o.reused) return res.status(429).json({ error: `Please wait ${o.resendIn}s before requesting a new code.`, resendIn: o.resendIn });
  res.json({ ok: true, resendIn: o.resendIn });
});

app.get('/api/admin/users', dataLimiter, authMiddleware, requireAdmin, (req, res) => {
  const now = Date.now();
  const list = [...users.values()].map(u => {
    const pro = u.plan === 'pro' && (!u.planUntil || u.planUntil > now);
    return {
      email: u.email,
      plan: pro ? 'pro' : 'free',
      planUntil: pro ? (u.planUntil || null) : null,
      lifetime: pro && !u.planUntil,
      expired: u.plan === 'pro' && !pro,
      verified: u.verified !== false,
      createdAt: u.createdAt || null
    };
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const pro = list.filter(u => u.plan === 'pro').length;
  res.json({ total: list.length, pro, free: list.length - pro, users: list });
});

// ✅ New Admin Endpoint for Live Visitors & Total Visits
app.get('/api/admin/stats', dataLimiter, authMiddleware, requireAdmin, (req, res) => {
  res.json({
    liveUsers: activeUsers.size,
    totalVisits: totalVisits
  });
});

app.post('/api/admin/plan', adminLimiter, (req, res) => {
  const tok = process.env.ADMIN_TOKEN;
  if (!tok) return res.status(404).end();
  const a = Buffer.from(String(req.headers['x-admin-token'] || '')), b = Buffer.from(tok);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { auditLog('admin_token_rejected', req, { route: 'plan' }); return res.status(403).json({ error: 'Forbidden' }); }
  const { email, plan, days } = req.body || {};
  const u = users.get(String(email || '').trim().toLowerCase());
  if (!u) return res.status(404).json({ error: 'No such account' });
  if (plan === 'pro') { u.plan = 'pro'; u.planUntil = Number(days) > 0 ? Date.now() + Math.min(Number(days), 3650) * 86400000 : null; }
  else { u.plan = 'free'; u.planUntil = null; }
  saveUsersSoon();
  auditLog('admin_plan', req, { email: u.email, plan: u.plan, planUntil: u.planUntil });
  res.json({ ok: true, email: u.email, plan: u.plan, planUntil: u.planUntil });
});

/* ═══════════════════════════════════════════════════════════
   LICENSE KEYS
   ═══════════════════════════════════════════════════════════ */
if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.length < 32) console.error('⚠️ ADMIN_TOKEN is shorter than 32 characters: use a long random value (e.g. `openssl rand -hex 32`). It grants Pro plans and creates license keys.');
const LICENSES_FILE = process.env.LICENSES_FILE || path.join(path.dirname(HISTORY_FILE), 'licenses.json');
const licenses = new Map();
try {
  if (fs.existsSync(LICENSES_FILE)) {
    const arr = JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const l of arr) if (l && l.hash) licenses.set(l.hash, l);
    console.log(`🔑 Loaded ${licenses.size} licenses`);
  }
} catch (e) { console.error('Licenses load error:', e.message); }
const licenseSaver = makeSaver('Licenses', () => writeAtomic(LICENSES_FILE, JSON.stringify([...licenses.values()])), 500);
const saveLicensesSoon = licenseSaver.soon;
const licHash = key => crypto.createHash('sha256').update(String(key).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newLicenseKey() {
  const b = crypto.randomBytes(16);
  let raw = ''; for (let i = 0; i < 16; i++) raw += B32[b[i] % 32];
  return 'LB-' + raw.match(/.{4}/g).join('-');
}
function adminOk(req) {
  const tok = process.env.ADMIN_TOKEN;
  if (!tok) return null;
  const a = Buffer.from(String(req.headers['x-admin-token'] || '')), b = Buffer.from(tok);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/admin/license', adminLimiter, (req, res) => {
  const ok = adminOk(req);
  if (ok === null) return res.status(404).end();
  if (!ok) { auditLog('admin_token_rejected', req, { route: 'license' }); return res.status(403).json({ error: 'Forbidden' }); }
  const days = Math.max(0, Math.min(3650, Math.floor(Number((req.body || {}).days) || 30)));
  const count = Math.max(1, Math.min(50, Math.floor(Number((req.body || {}).count) || 1)));
  const note = String((req.body || {}).note || '').slice(0, 80);
  const keys = [];
  for (let i = 0; i < count; i++) {
    const key = newLicenseKey(), hash = licHash(key);
    licenses.set(hash, { hash, days, createdAt: Date.now(), note, usedBy: null, usedAt: null });
    keys.push(key);
  }
  saveLicensesSoon();
  auditLog('admin_license_create', req, { count, days, note });
  res.json({ ok: true, days, keys });
});

async function keyauthLicense(key, sessionid, hwid) {
  return keyauthRequest({ type: 'license', key, hwid, sessionid, name: KEYAUTH_NAME, ownerid: KEYAUTH_OWNERID, secret: KEYAUTH_SECRET });
}
app.post('/api/license/activate', licenseLimiter, authMiddleware, async (req, res) => {
  const sess = sessions.get(req.authToken);
  if (!sess || sess.kind !== 'local') return res.status(400).json({ error: 'This login is already Premium.' });
  const u = users.get(sess.username);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  if (u.plan === 'pro' && !u.planUntil) return res.status(400).json({ error: 'Your account already has lifetime access. Your key was not used.' });
  const fKey = 'lic:' + sess.username;
  const f = userFails.get(fKey);
  if (f && f.n >= 8 && Date.now() - f.t < 10 * 60 * 1000) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const rawKey = (req.body || {}).key;
  if (typeof rawKey !== 'string' || rawKey.trim().length < 6 || rawKey.length > 64) return res.status(400).json({ error: 'Invalid license key.' });
  const key = rawKey.trim();
  const h = licHash(key);
  const fail = msg => {
    const e = userFails.get(fKey) || { n: 0, t: Date.now() };
    e.n++; e.t = Date.now(); userFails.set(fKey, e);
    return res.status(400).json({ error: msg });
  };
  const now = Date.now();
  let until = null;
  let extendDays = null;
  const own = licenses.get(h);

  if (own && own.source !== 'keyauth') {
    if (own.usedBy) return fail('This license key was already used.');
    own.usedBy = u.email; own.usedAt = now;
    extendDays = own.days;
  } else {
    if (own && own.usedBy && own.usedBy !== u.email) return fail('This license key was already used by another account.');
    if (!AUTH_CONFIGURED) return res.status(503).json({ error: 'Activation is temporarily unavailable.' });
    let r;
    try {
      const init = await keyauthInit();
      if (!init.success) throw new Error(init.message || 'Init failed');
      r = await keyauthLicense(key, init.sessionid, 'web-' + h.slice(0, 24));
    } catch (e) { return res.status(502).json({ error: 'Could not reach the license server. Try again.' }); }
    if (!r || !r.success) return fail((r && r.message) || 'Invalid license key.');
    const subs = (r.info && r.info.subscriptions) || [];
    const exp = Math.max(0, ...subs.map(x => Number(x.expiry) || 0));
    if (exp <= 0) return fail('This license has no active subscription.');
    if (exp * 1000 <= now) return fail('This license has expired.');
    const cur = licenses.get(h);
    if (cur && cur.usedBy && cur.usedBy !== u.email) return fail('This license key was already used by another account.');
    until = exp * 1000 > Date.UTC(2090, 0, 1) ? null : exp * 1000;
    licenses.set(h, { hash: h, source: 'keyauth', usedBy: u.email, usedAt: now, expiry: until });
  }

  userFails.delete(fKey);
  const active = u.plan === 'pro' && (!u.planUntil || u.planUntil > now);
  if (active && !u.planUntil) { /* already lifetime: keep it */ }
  else if (extendDays !== null) {
    u.plan = 'pro';
    u.planUntil = extendDays === 0 ? null : (active ? u.planUntil : now) + extendDays * 86400000;
  } else {
    u.plan = 'pro';
    u.planUntil = until === null ? null : Math.max(until, active ? u.planUntil : 0);
  }
  saveUsersSoon(); saveLicensesSoon();
  auditLog('license_activate', req, { email: u.email, source: extendDays !== null ? 'local' : 'keyauth', planUntil: u.planUntil });
  res.json({ ok: true, profile: profileOf(sess) });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password, hwid } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 200 || (hwid != null && (typeof hwid !== 'string' || hwid.length > 200))) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  // trimmed (emails are trimmed by localLogin, so " a@b.c" must share a@b.c's counter) and prefixed (so it cannot collide with the 'lic:' license counters)
  const uKey = 'login:' + (username.includes('@') ? username.trim() : username).toLowerCase();
  const uf = userFails.get(uKey);
  if (uf && uf.n >= 8 && Date.now() - uf.t < 10 * 60 * 1000) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  if (username.includes('@')) return localLogin(req, res, username.trim().toLowerCase(), password, uKey);
  if (!AUTH_CONFIGURED) return res.status(503).json({ error: 'Login is temporarily unavailable.' });
  const unavailable = () => res.status(503).json({ error: 'Login service is temporarily unavailable. Please try again.' });
  let init, login;
  try { init = await keyauthInit(); } catch (e) { return unavailable(); }
  if (!init || !init.success) return unavailable();
  const sessionid = init.sessionid;
  try { login = await keyauthLogin(username, password, sessionid, hwid); } catch (e) { return unavailable(); }
  if (!login || !login.success) {
    const f = userFails.get(uKey) || { n: 0, t: Date.now() };
    f.n++; f.t = Date.now(); userFails.set(uKey, f);
    return res.status(401).json({ error: String((login && login.message) || 'Invalid username or password').slice(0, 200) });
  }
  userFails.delete(uKey);
  const subs = (login.info && login.info.subscriptions) || [];
  const exp = Math.max(0, ...subs.map(x => Number(x.expiry) || 0));
  const sx = { kind: 'keyauth', keyauthSessionId: sessionid, username };
  if (exp > 0) { if (exp * 1000 > Date.UTC(2090, 0, 1)) sx.lifetime = true; else sx.expiry = exp * 1000; }
  startSession(req, res, sx);
});

app.post('/api/auth/google', loginLimiter, async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in is not configured.' });
  const body = req.body || {};
  const credential = body.credential;
  if (!credential || typeof credential !== 'string') return res.status(400).json({ error: 'Missing Google credential.' });
  let c;
  try { c = await verifyGoogleIdToken(credential, GOOGLE_CLIENT_ID); }
  catch (e) {
    auditLog('google_login_reject', req, { reason: String(e && e.message).slice(0, 80) });
    return res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
  const email = String(c.email).trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Invalid Google account email.' });
  let u = users.get(email);
  if (!u) {
    // New account: a gambling service is 18+, so creation needs the same consent the email sign-up requires.
    if (body.consent !== true || body.ageConfirmed !== true) return res.status(403).json({ consentRequired: true, error: 'You must confirm you are 18 or older and accept the Terms and Privacy Policy.' });
    if (users.size >= 50000) return res.status(503).json({ error: 'Registration is temporarily closed.' });
    const seq = [...users.values()].reduce((m, x) => Math.max(m, x.seq || 0), 0) + 1;
    u = { email, kind: 'google', googleSub: c.sub || null, plan: 'free', planUntil: null, createdAt: Date.now(), seq, verified: true, consentAt: Date.now(), termsVersion: TERMS_VERSION };
    users.set(email, u);
    saveUsersSoon();
    auditLog('google_signup', req, { seq });
  } else {
    // Existing account (email/password or an earlier Google login): link the Google identity, keep the plan untouched.
    let changed = false;
    if (!u.googleSub && c.sub) { u.googleSub = c.sub; changed = true; }
    if (u.verified === false) { u.verified = true; changed = true; }
    if (changed) saveUsersSoon();
  }
  startSession(req, res, { kind: 'google', username: email });
});

app.post('/api/auth/apple', loginLimiter, async (req, res) => {
  if (!APPLE_CLIENT_ID) return res.status(503).json({ error: 'Apple sign-in is not configured.' });
  const body = req.body || {};
  const idToken = body.id_token || body.credential;
  if (!idToken || typeof idToken !== 'string') return res.status(400).json({ error: 'Missing Apple credential.' });
  let c;
  try { c = await verifyAppleIdToken(idToken, APPLE_CLIENT_ID); }
  catch (e) {
    auditLog('apple_login_reject', req, { reason: String(e && e.message).slice(0, 80) });
    return res.status(401).json({ error: 'Apple sign-in failed. Please try again.' });
  }
  const email = String(c.email).trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Invalid Apple account email.' });
  let u = users.get(email);
  if (!u) {
    if (body.consent !== true || body.ageConfirmed !== true) return res.status(403).json({ consentRequired: true, error: 'You must confirm you are 18 or older and accept the Terms and Privacy Policy.' });
    if (users.size >= 50000) return res.status(503).json({ error: 'Registration is temporarily closed.' });
    const seq = [...users.values()].reduce((m, x) => Math.max(m, x.seq || 0), 0) + 1;
    u = { email, kind: 'apple', appleSub: c.sub || null, plan: 'free', planUntil: null, createdAt: Date.now(), seq, verified: true, consentAt: Date.now(), termsVersion: TERMS_VERSION };
    users.set(email, u);
    saveUsersSoon();
    auditLog('apple_signup', req, { seq });
  } else {
    let changed = false;
    if (!u.appleSub && c.sub) { u.appleSub = c.sub; changed = true; }
    if (u.verified === false) { u.verified = true; changed = true; }
    if (changed) saveUsersSoon();
  }
  startSession(req, res, { kind: 'apple', username: email });
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ ok: true, ...profileOf(sessions.get(req.authToken)) });
});

// League tables / top scorers / team sheets. Public read-only data, no account needed.
const fbCode = c => { const x = String(c || '').toUpperCase(); return football.LEAGUE_CODES.has(x) ? x : null; };
function fbSend(res, data, what) {
  if (data === undefined) return res.status(202).json({ pending: true });     // queued behind the free-plan budget: retry shortly
  if (!data) return res.status(503).json({ error: `${what} is unavailable right now. Please try again in a minute.` });
  res.json(data);
}
app.get('/api/football/leagues', apiLimiter, (req, res) => {
  res.json({ leagues: football.LEAGUES.map(l => { const c = infoCache.get('table:' + l.code); return football.summary(l, c && c.data); }) });
});
app.get('/api/football/standings/:code', apiLimiter, async (req, res) => {
  const code = fbCode(req.params.code); if (!code) return res.status(404).json({ error: 'Unknown league.' });
  if (!API_KEY) return res.status(503).json({ error: 'League data is not configured.' });
  fbSend(res, await fbTable(code), 'The league table');
});
app.get('/api/football/scorers/:code', apiLimiter, async (req, res) => {
  const code = fbCode(req.params.code); if (!code) return res.status(404).json({ error: 'Unknown league.' });
  if (!API_KEY) return res.status(503).json({ error: 'League data is not configured.' });
  fbSend(res, await fbScorers(code), 'Top scorers');
});
app.get('/api/football/team/:id', apiLimiter, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^\d{1,7}$/.test(id)) return res.status(400).json({ error: 'Invalid team.' });
  if (!API_KEY) return res.status(503).json({ error: 'Team data is not configured.' });
  fbSend(res, await fbTeam(id), 'Team information');
});

/* Match info (line-ups, absences, head-to-head, league position) for one fixture of the current feed. The fixture is looked
   up server-side by id, so a caller can only spend the API-Football budget on matches the site really lists. */
const matchInfo = require('./matchinfo');
const matchInfoFile = () => path.join(path.dirname(HISTORY_FILE), 'matchinfo-cache.json');
const matchInfoSaver = makeSaver('Match info cache', () => writeAtomic(matchInfoFile(), JSON.stringify(matchInfo.dump())), 60 * 1000);
try { if (fs.existsSync(matchInfoFile())) console.log(`📋 Loaded match info cache: ${matchInfo.load(JSON.parse(fs.readFileSync(matchInfoFile(), 'utf8')))} entries`); }
catch (e) { console.error('Match info cache load error:', e.message); }
// football-data.org table row (already cached for the Standings tab) in the panel's shape: used when API-Football has none.
function fdStanding(team) {
  if (!team || !team.name) return null;
  for (const [k, v] of infoCache) {
    if (!k.startsWith('table:') || !v.data) continue;
    for (const g of v.data.groups || []) {
      const r = g.rows.find(x => x.team && ((team.id && x.team.id === team.id) || teamsMatchAny(team.name, x.team.name)));
      if (r) return { rank: r.pos, pts: r.pts, p: r.p, w: r.w, d: r.d, l: r.l, gf: r.gf, ga: r.ga, gd: r.gd, form: r.form || [], size: g.rows.length, league: v.data.name, group: g.name || null };
    }
  }
  return null;
}
const matchInfoLimiter = makeLimiter({ windowMs: 60 * 1000, max: 30, message: 'Too many requests. Slow down.' });
app.get('/api/match/:id/info', matchInfoLimiter, authMiddleware, requirePro, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[a-z0-9_]{1,40}$/i.test(id)) return res.status(400).json({ error: 'Invalid match.' });
  try {
    const list = fixturesCache.data || lastFixtures || await getFixtures();
    const fx = (list || []).find(f => String(f.id) === id);
    if (!fx) return res.status(404).json({ error: 'Match not found. It may have been removed from the feed.' });
    const info = await matchInfo.getMatchInfo(fx, { match: teamsMatchAny, fallback: { standings: { home: fdStanding(fx.home), away: fdStanding(fx.away) } } });
    matchInfoSaver.soon();
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json(info);
  } catch (e) {
    console.error('Match info error:', e.message);
    res.status(500).json({ error: 'Match info is unavailable right now.' });
  }
});

// Public, cacheable: lets the static frontend learn which social logins are on (and their client ids) without templating index.html.
app.get('/api/public/config', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    appleClientId: APPLE_CLIENT_ID || null,
    appleRedirectUri: String(process.env.APPLE_REDIRECT_URI || '').trim() || null
  });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  sessions.delete(req.authToken);
  saveSessionsSoon();
  clearSessionCookies(req, res);
  res.json({ ok: true });
});

const pubHits = new Map();
setInterval(() => pubHits.clear(), 60 * 1000).unref();
app.get('/api/public/fixtures', async (req, res) => {
  const ip = req.ip || 'unknown';
  const n = (pubHits.get(ip) || 0) + 1; pubHits.set(ip, n);
  if (n > 40) return res.status(429).json({ error: 'Too many requests', fixtures: [] });
  try {
    const fixtures = await getFixtures();
    const out = fixtures.filter(f => f.status === 'notstarted' || f.status === 'started').slice(0, 60).map(f => ({
      id: f.id, league: f.league, women: isWomenFixture(f) || undefined, date: f.date, kickoff: f.kickoff, status: f.status,
      homeScore: f.status === 'started' ? f.homeScore : null,
      awayScore: f.status === 'started' ? f.awayScore : null,
      home: { name: f.home.name, logo: f.home.logo || null },
      away: { name: f.away.name, logo: f.away.logo || null }
    }));
    res.set('Cache-Control', 'public, max-age=15');
    res.json({ fixtures: out });
    const crestP = ensureFdCrests(); if (crestP) crestP.catch(() => {});
    const logoP = ensureLogos(fixtures.flatMap(f => [f.home, f.away]));
    if (logoP) logoP.catch(() => {});
  } catch (e) { res.status(500).json({ error: 'Server error', fixtures: [] }); }
});

const presence = require('./presence')({
  lookup: (() => { try { return require('geoip-lite').lookup; } catch (e) { return null; } })(),
  trustCfGeo: process.env.TRUST_CF_GEO === '1'
});
app.post('/api/presence', presence.ping);
app.get('/api/presence', presence.snapshot);

const FORMS_WAIT_MS = Math.max(0, parseInt(process.env.FORMS_WAIT_MS, 10) || 8000);
const ENGINE_MIN_BOOKS_WANTED = Number.isFinite(parseInt(process.env.ENGINE_MIN_BOOKS, 10)) ? Math.max(1, parseInt(process.env.ENGINE_MIN_BOOKS, 10)) : 1;
// Without ODDS_API_KEY the only price source is Bzzoiro = ONE bookmaker per match. Asking for more than that blocks every bet forever
// (that is how "0 value bets" happened with ENGINE_MIN_BOOKS=3), so the requirement is capped by what the configured sources can deliver.
const ENGINE_MAX_BOOKS_POSSIBLE = oddsApi.status().enabled ? Infinity : 1;
const ENGINE_MIN_BOOKS = Math.min(ENGINE_MIN_BOOKS_WANTED, ENGINE_MAX_BOOKS_POSSIBLE);
if (ENGINE_MIN_BOOKS < ENGINE_MIN_BOOKS_WANTED) console.log(`⚠️ ENGINE_MIN_BOOKS=${ENGINE_MIN_BOOKS_WANTED} is higher than the sources allow (only ${ENGINE_MAX_BOOKS_POSSIBLE} bookmaker without ODDS_API_KEY): using ${ENGINE_MIN_BOOKS}.`);
const ENGINE_MAX_EV = (() => { const v = parseFloat(process.env.ENGINE_MAX_EV); return Number.isFinite(v) && v >= 0.05 && v <= 2 ? v : 0.15; })();
const ENGINE_MARKET_WEIGHT = (() => { const v = parseFloat(process.env.ENGINE_MARKET_WEIGHT); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.85; })();   // evaluate: the market alone beats the model, so lean on it
const ENGINE_ELO_WEIGHT = (() => { const v = parseFloat(process.env.ENGINE_ELO_WEIGHT); return Number.isFinite(v) && v >= 0 && v <= 0.5 ? v : 0.15; })();
const leagueAvgCache = { map: new Map(), ts: 0 };
function getLeagueAvgs() {
  if (Date.now() - leagueAvgCache.ts < 30 * 60 * 1000) return leagueAvgCache.map;
  const agg = new Map();
  for (const f of snapshotStore.values()) {
    if (!f || f.status !== 'finished' || !Number.isInteger(f.homeScore) || !Number.isInteger(f.awayScore) || !f.league) continue;
    const a = agg.get(f.league) || { g: 0, n: 0 }; a.g += f.homeScore + f.awayScore; a.n++; agg.set(f.league, a);
  }
  const out = new Map();
  for (const [lg, a] of agg) if (a.n >= 10) out.set(lg, (a.g + 1.35 * 2 * 20) / (2 * (a.n + 20)));
  leagueAvgCache.map = out; leagueAvgCache.ts = Date.now();
  return out;
}
const eloCache = { book: null, ts: 0 };
function getEloBook() {
  if (ENGINE_ELO_WEIGHT <= 0) return null;
  if (eloCache.book && Date.now() - eloCache.ts < 10 * 60 * 1000) return eloCache.book;
  try { eloCache.book = require('./engine/elo').build([...snapshotStore.values()]); eloCache.ts = Date.now(); } catch (e) { console.error('Elo build error:', e.message); eloCache.book = null; }
  return eloCache.book;
}
const ENGINE_MAX_GAP = (() => { const v = parseFloat(process.env.ENGINE_MAX_GAP); return Number.isFinite(v) && v >= 0.05 && v <= 0.6 ? v : 0.2; })();
async function getFixturesWithForms() {
  let fixtures = await getFixtures();
  const upcoming = fixtures.filter(f => f.status === 'notstarted' || f.status === 'started');
  if (!upcoming.length) return fixtures;
  const teams = upcoming.flatMap(f => [f.home, f.away]).filter(t => t.id);
  const pending = [teams.length ? ensureForms(teams) : null, ensureBzzForms(), ensureFdSeasonStats()].filter(Boolean);
  if (pending.length) {
    let timer;
    await Promise.race([Promise.all(pending.map(p => p.catch(() => {}))), new Promise(r => { timer = setTimeout(r, FORMS_WAIT_MS); })]);
    clearTimeout(timer);
    fixtures = await getFixtures();
  }
  return fixtures;
}

app.get('/api/fixtures', dataLimiter, authMiddleware, requirePro, async (req, res) => {
  try {
    const fixtures = await getFixturesWithForms();
    const teams = fixtures.filter(f => f.status === 'notstarted' || f.status === 'started').flatMap(f => [f.home, f.away]).filter(t => t.id);
    res.json({ fixtures, feed: feedHealth() });
    if (teams.length && !prefetchInProgress) ensureForms(teams).catch(e => console.error(e.message));
    const crestP = ensureFdCrests(); if (crestP) crestP.catch(() => {});
    const logoP = ensureLogos(fixtures.flatMap(f => [f.home, f.away]));
    if (logoP) logoP.catch(e => console.error('Logo fetch error:', e.message));
  } catch (e) { res.status(500).json({ error: 'Server error', fixtures: [] }); }
});

const engineDecide = require('./engine/decision'), engineValidate = require('./engine/validate'), engineServe = require('./engine/serve');
app.get('/api/engine/predictions', dataLimiter, authMiddleware, requirePro, async (req, res) => {
  try {
    const fixtures = await getFixturesWithForms();
    const eloBook = getEloBook(), lgAvg = getLeagueAvgs();
    const qmw = parseFloat(req.query.mw), qev = parseFloat(req.query.mev);
    const mw = Number.isFinite(qmw) && qmw >= 0 && qmw <= 1 ? qmw : ENGINE_MARKET_WEIGHT;
    const dOpts = { minBooks: ENGINE_MIN_BOOKS, maxGap: ENGINE_MAX_GAP, maxEV: ENGINE_MAX_EV };
    if (Number.isFinite(qev) && qev >= 0 && qev <= 0.5) dOpts.minEV = qev;
    const out = fixtures.map(fx0 => {
      const f = lgAvg.has(fx0.league) ? Object.assign({}, fx0, { leagueAvg: lgAvg.get(fx0.league) }) : fx0;
      return engineServe.item(f, { marketWeight: mw, eloWeight: ENGINE_ELO_WEIGHT, eloBook, decide: dOpts, maxGap: ENGINE_MAX_GAP });
    });
    const xgCounts = {}; for (const f of fixtures) { const k = f.xgSource || 'none'; xgCounts[k] = (xgCounts[k] || 0) + 1; }
    res.json({ predictions: out, meta: { feed: feedHealth(), minBooks: ENGINE_MIN_BOOKS, maxEV: ENGINE_MAX_EV, marketWeight: ENGINE_MARKET_WEIGHT, eloWeight: ENGINE_ELO_WEIGHT, fdSeason: { competitions: fdSeasonMaps().length, teams: fdSeasonMaps().reduce((n, m) => n + m.size, 0) }, xgSources: xgCounts, bzzForms: bzzFormCache.stats || (BZZOIRO_API_KEY ? 'not run yet' : 'no BZZOIRO_API_KEY') } });
  } catch (e) { res.status(500).json({ error: 'Server error', predictions: [] }); }
});

const historyResponseCache = { body: null, version: -1, cutoff: null, at: 0 };
app.get('/api/history', dataLimiter, async (req, res) => {
  try {
    await refreshHistoryResults().catch(e => console.error(e.message));
    const cutoff = dateDaysAgo(HISTORY_KEEP_DAYS);
    // Same data as last time (no saved change, same day, < 60 s old): send the cached body instead of rebuilding ~6 MB of JSON.
    const hc = historyResponseCache;
    if (hc.body && hc.version === snapshotVersion && hc.cutoff === cutoff && Date.now() - hc.at < 60 * 1000) return res.type('application/json').send(hc.body);
    const fixtures = dedupeFixtures([...snapshotStore.values()].filter(f => f.status === 'finished' && f.date >= cutoff && Number.isInteger(f.homeScore) && Number.isInteger(f.awayScore)))   // score still pending: not listed yet
      .sort((a, b) => (b.date + b.kickoff).localeCompare(a.date + a.kickoff));
    // openOdds (opening prices, server-side tracking only) is not used by the page: leave it out (~11% of the payload).
    const body = JSON.stringify({ fixtures: fixtures.map(f => { const o = Object.assign({}, f); delete o.openOdds; if (isWomenFixture(f) && f.women !== true) o.women = true; return o; }) });
    Object.assign(historyResponseCache, { body, version: snapshotVersion, cutoff, at: Date.now() });
    res.type('application/json').send(body);
  } catch (e) {
    res.status(500).json({ error: 'Server error', fixtures: [] });
  }
});

async function backgroundTick() {
  try {
    const fixtures = await getFixtures();
    if (API_KEY && !prefetchInProgress) {
      const teams = fixtures.filter(f => f.status === 'notstarted' || f.status === 'started').flatMap(f => [f.home, f.away]).filter(t => t.id);
      if (teams.length) ensureForms(teams).catch(e => console.error(e.message));
    }
    ensureBzzForms();
    // Second odds source (no-op without ODDS_API_KEY). New prices => drop the fixtures cache so the next request uses them.
    await oddsApi.discover(fixtures, teamsMatchAny).catch(() => 0);
    if (await oddsApi.refresh(fixtures).catch(() => 0)) fixturesCache.data = null;
    await refreshHistoryResults();
  } catch (e) { console.error('Background tick error:', e.message); }
}
setTimeout(backgroundTick, 10 * 1000);
setInterval(backgroundTick, 3 * 60 * 1000).unref();

const server = app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
server.headersTimeout = 15 * 1000;
server.requestTimeout = 20 * 1000;
server.keepAliveTimeout = 65 * 1000;
server.maxHeadersCount = 60;
// Bound the socket count so a connection flood (e.g. many half-open sockets) cannot exhaust file descriptors / memory,
// and drop sockets that go idle or stall mid-exchange — defence in depth alongside the per-request timeouts above.
server.maxConnections = Math.max(64, parseInt(process.env.MAX_CONNECTIONS, 10) || 1024);
server.timeout = 30 * 1000;

setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const [k, u] of users) if (u.verified === false && now - u.createdAt > 24 * 60 * 60 * 1000) { users.delete(k); otps.delete(k); otpSends.delete(k); n++; }
  if (n) { saveUsersSoon(); console.log(`🧹 Removed ${n} unverified sign-ups`); }
}, 60 * 60 * 1000).unref();

let shuttingDown = false;
let demoSaver = null;   // set once Demo Arena is wired below
let discoverSaver = null;   // declared before shutdown() so an early signal can't hit the temporal dead zone
function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: saving data before exit`);
  // Each saver is read inside try/catch: one that is not created yet (early signal) or that throws must not block the exit.
  for (const getSaver of [() => userSaver, () => sessionSaver, () => licenseSaver, () => snapshotSaver, () => discoverSaver, () => demoSaver, () => footballSaver, () => matchInfoSaver]) {
    try { const sv = getSaver(); if (sv) sv.now(); } catch (e) { console.error('Shutdown save error:', e && e.message); }
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e && e.message));
process.on('uncaughtException', e => { console.error('Uncaught exception:', e && e.stack); shutdown('uncaughtException', 1); });

try {
  const dir = path.dirname(USERS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.W_OK);
  console.log(`💾 Data folder OK: ${dir}`);
} catch (e) {
  console.error(`❌ DATA FOLDER NOT WRITABLE (${e.message}). Accounts and logins will be LOST on every deploy.`);
}

/* ═══════════════════════════════════════════════════════════
   ✅ DISCOVER (TWEETS & IMAGES) - FIXED FOR EXPRESS 5
   ═══════════════════════════════════════════════════════════ */
const DISCOVER_FILE = process.env.DISCOVER_FILE || path.join(path.dirname(HISTORY_FILE), 'discover.json');
const discoverPosts = new Map();

try {
  if (fs.existsSync(DISCOVER_FILE)) {
    const arr = JSON.parse(fs.readFileSync(DISCOVER_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const p of arr) if (p && p.id) discoverPosts.set(p.id, p);
    console.log(`📰 Loaded ${discoverPosts.size} discover posts`);
  }
} catch (e) { console.error('Discover load error:', e.message); }
discoverSaver = makeSaver('Discover', () => writeAtomic(DISCOVER_FILE, JSON.stringify([...discoverPosts.values()])), 1000);
const saveDiscoverSoon = discoverSaver.soon;

// Uploaded images live next to the other data files (a persistent disk), not inside the app folder that every deploy replaces.
const UPLOADS_DIR = path.join(path.dirname(HISTORY_FILE), 'uploads');
const LEGACY_UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');   // images uploaded before this change keep working
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) { console.error('Uploads folder error:', e.message); }
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
app.use('/uploads', express.static(UPLOADS_DIR, {
  dotfiles: 'deny', index: false, maxAge: '7d',
  setHeaders(res) { res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox"); }
}));

// Player head-shots cached on the persistent disk, so the tactical pitch never depends on the
// API media host at view time. Lazy: the first request for a player pulls the photo from the
// provider's media CDN and stores it; every later request is served straight off disk. The media
// host is separate from the API-Football request quota, so warming portraits costs no budget.
const PORTRAITS_DIR = path.join(path.dirname(HISTORY_FILE), 'portraits');
try { fs.mkdirSync(PORTRAITS_DIR, { recursive: true }); } catch (e) { console.error('Portraits folder error:', e.message); }
const portraitInflight = new Map();
const PORTRAIT_HDRS = { 'Cache-Control': 'public, max-age=604800, immutable', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox" };
app.get('/portraits/:id.png', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^\d{1,8}$/.test(id)) return res.status(400).end();
  const file = path.join(PORTRAITS_DIR, id + '.png');
  const miss = path.join(PORTRAITS_DIR, id + '.none');          // remember "no photo" so we don't refetch on every view
  if (fs.existsSync(file)) return res.sendFile(file, { headers: PORTRAIT_HDRS });
  if (fs.existsSync(miss) && Date.now() - fs.statSync(miss).mtimeMs < 7 * 24 * 3600e3) return res.status(404).end();
  try {
    if (!portraitInflight.has(id)) portraitInflight.set(id, (async () => {
      const r = await fetch(`https://media.api-sports.io/football/players/${id}.png`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('upstream ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1500 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('placeholder');
      fs.writeFileSync(file, buf);
    })().finally(() => portraitInflight.delete(id)));
    await portraitInflight.get(id);
    return res.sendFile(file, { headers: PORTRAIT_HDRS });
  } catch (e) {
    try { fs.writeFileSync(miss, ''); } catch (_) {}            // negative-cache the miss; frontend falls back to the kit jersey
    return res.status(404).end();
  }
});

function imageSignatureOk(file, mimetype) {
  let b;
  try { const fd = fs.openSync(file, 'r'); b = Buffer.alloc(12); fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd); } catch (e) { return false; }
  const hex = b.toString('hex'), ascii = b.toString('latin1');
  if (mimetype === 'image/jpeg') return hex.startsWith('ffd8ff');
  if (mimetype === 'image/png') return hex.startsWith('89504e470d0a1a0a');
  if (mimetype === 'image/gif') return ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a');
  if (mimetype === 'image/webp') return ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP';
  return false;
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    cb(null, crypto.randomBytes(8).toString('hex') + (IMAGE_EXT[file.mimetype] || '.jpg'));
  }
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (IMAGE_EXT[file.mimetype]) cb(null, true);
    else cb(new Error('Only JPG, PNG, WebP or GIF images are allowed'));
  }
});

// ✅ Upload route safely wrapped for Express 5
app.post('/api/upload', dataLimiter, authMiddleware, requireAdmin, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  // The MIME type above comes from the browser. Check the file's real signature too, so only genuine JPG/PNG/WebP/GIF data is ever served.
  if (!imageSignatureOk(req.file.path, req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    auditLog('upload_rejected', req, { reason: 'signature_mismatch', mimetype: req.file.mimetype });
    return res.status(400).json({ error: 'The file is not a valid JPG, PNG, WebP or GIF image.' });
  }
  const url = '/uploads/' + req.file.filename;
  auditLog('upload', req, { file: req.file.filename, bytes: req.file.size, by: sessions.get(req.authToken).username });
  res.json({ ok: true, url });
});

// Compact, server-built snapshot of a fixture (never trust the client's copy)
function findFixture(id) {
  const list = (fixturesCache.data || lastFixtures || []);
  return list.find(f => String(f.id) === String(id)) || null;
}
function matchCard(f) {
  return {
    id: String(f.id), league: String(f.league || '').slice(0, 80), women: isWomenFixture(f) || undefined, date: f.date, kickoff: f.kickoff,
    status: f.status, homeScore: f.homeScore, awayScore: f.awayScore,
    home: { name: String(f.home.name).slice(0, 60), logo: f.home.logo || null },
    away: { name: String(f.away.name).slice(0, 60), logo: f.away.logo || null }
  };
}

// The bot's pick for a shared match: the one frozen BEFORE kickoff when it exists, else computed now.
function pickFor(f) {
  const snap = snapshotStore.get(f.id), pk = (snap && snap.pick) || freezePick(f);
  return pk ? { key: pk.key, p: pk.p } : null;
}
// Refreshes a shared match (status/score/logos) and, once it is finished, settles it as 'win' or 'loss' for good.
function settleMatch(m) {
  if (m.result) return m;
  const src = findFixture(m.id) || snapshotStore.get(m.id);
  if (!src) return m;
  const out = Object.assign({}, m, matchCard(src));
  if (src.status === 'finished' && m.pick && Number.isInteger(src.homeScore) && Number.isInteger(src.awayScore)) {
    const res = src.homeScore > src.awayScore ? 'home' : src.homeScore < src.awayScore ? 'away' : 'draw';
    out.result = res === m.pick.key ? 'win' : 'loss';
  }
  return out;
}

// Visible to every logged-in user (Pro and Free). Shared matches get their live status/score refreshed on each read.
// What a viewer may see of a post: counts and their own vote. Voter e-mails never leave the server.
// What other users see instead of an account name: never the e-mail (not even the part before the @).
const publicHandle = username => { const u = users.get(username); return u ? 'USR' + String(u.seq).padStart(6, '0') : 'USER-' + tokHash(username).slice(0, 6).toUpperCase(); };
const HANDLE_RE = /^(USR\d{6}|USER-[0-9A-F]{6})$/;
const discoverComments = p => (p.comments || []).slice(-200).map(c => HANDLE_RE.test(String(c.user)) ? c : Object.assign({}, c, { user: 'USER-' + tokHash(String(c.user)).slice(0, 6).toUpperCase() }));   // old comments stored the e-mail's local part
const discoverView = (p, match, me) => ({
  id: p.id, text: p.text, image: p.image, match: match || null, date: p.date, comments: discoverComments(p),
  likes: (p.likes || []).length, dislikes: (p.dislikes || []).length,
  isLiked: (p.likes || []).includes(me), isDisliked: (p.dislikes || []).includes(me)
});

// Visible to every logged-in user (Pro and Free). Shared matches get their live status/score refreshed on each read.
app.get('/api/discover', authMiddleware, (req, res) => {
  const me = sessions.get(req.authToken).username;
  const posts = [...discoverPosts.values()].sort((a, b) => b.date - a.date).map(p => {
    if (!p.match) return discoverView(p, null, me);
    const m = settleMatch(p.match);
    if (m.result && !p.match.result) { p.match = m; saveDiscoverSoon(); }   // keep the final result forever
    return discoverView(p, m, me);
  });
  res.json({ posts });
});

app.post('/api/discover', authMiddleware, requireAdmin, async (req, res) => {
  const { text, image, matchId } = req.body || {};
  const img = String(image || '').trim();
  if (img && !/^(\/uploads\/[a-f0-9]{16}\.(jpg|png|webp|gif)|https:\/\/[^\s"'<>]{1,480})$/i.test(img)) return res.status(400).json({ error: 'Invalid image URL.' });
  let match = null;
  if (matchId != null && matchId !== '') {
    // The in-memory list can be empty right after a restart or while it is being refreshed: load it before giving up,
    // then fall back to the saved snapshots (finished / earlier matches the admin may still see on screen).
    let f = findFixture(matchId);
    if (!f) { try { await getFixtures(); } catch (e) { /* feed down: try the snapshots */ } f = findFixture(matchId) || snapshotStore.get(String(matchId)) || null; }
    if (!f || !f.home || !f.away) return res.status(404).json({ error: 'Match not found (refresh the page).' });
    if ([...discoverPosts.values()].some(p => p.match && String(p.match.id) === String(f.id))) return res.status(409).json({ error: 'This match is already on Discover.' });
    match = matchCard(f); match.pick = pickFor(f);
  }
  if (!text && !img && !match) return res.status(400).json({ error: 'Post must have text, an image or a match.' });
  const id = crypto.randomBytes(8).toString('hex');
  const post = { id, text: String(text || '').slice(0, 1000), image: img, match, date: Date.now(), likes: [], dislikes: [], comments: [] };
  discoverPosts.set(id, post);
  saveDiscoverSoon();
  auditLog('discover_post', req, { id, by: sessions.get(req.authToken).username, match: match ? match.id : null });
  res.json({ ok: true, post: discoverView(post, match, sessions.get(req.authToken).username) });
});

// Admin: delete a post (POST, because the global method guard rejects DELETE with 405)
app.post('/api/discover/:id/delete', authMiddleware, requireAdmin, (req, res) => {
  const p = discoverPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  discoverPosts.delete(p.id);
  saveDiscoverSoon();
  auditLog('discover_delete', req, { id: p.id, by: sessions.get(req.authToken).username });
  if (typeof p.image === 'string' && p.image.startsWith('/uploads/')) {
    const name = path.basename(p.image);
    const stillUsed = [...discoverPosts.values()].some(o => o.image === p.image);
    if (!stillUsed) for (const dir of [UPLOADS_DIR, LEGACY_UPLOADS_DIR]) fs.unlink(path.join(dir, name), () => {});
  }
  res.json({ ok: true });
});

// ✅ Fixed Express 5 Routes (Removed regex params like :action(like|dislike))
app.post('/api/discover/:id/like', dataLimiter, authMiddleware, (req, res) => {
  const p = discoverPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  const user = sessions.get(req.authToken).username;
  
  if (p.likes.includes(user)) {
    p.likes.splice(p.likes.indexOf(user), 1); // Unlike
  } else {
    p.likes.push(user); // Like
    const idx = p.dislikes.indexOf(user);
    if (idx > -1) p.dislikes.splice(idx, 1); // Remove dislike if exists
  }
  saveDiscoverSoon();
  res.json({ ok: true, likes: p.likes.length, dislikes: p.dislikes.length, isLiked: p.likes.includes(user), isDisliked: p.dislikes.includes(user) });
});

app.post('/api/discover/:id/dislike', dataLimiter, authMiddleware, (req, res) => {
  const p = discoverPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  const user = sessions.get(req.authToken).username;
  
  if (p.dislikes.includes(user)) {
    p.dislikes.splice(p.dislikes.indexOf(user), 1); // Un-dislike
  } else {
    p.dislikes.push(user); // Dislike
    const idx = p.likes.indexOf(user);
    if (idx > -1) p.likes.splice(idx, 1); // Remove like if exists
  }
  saveDiscoverSoon();
  res.json({ ok: true, likes: p.likes.length, dislikes: p.dislikes.length, isLiked: p.likes.includes(user), isDisliked: p.dislikes.includes(user) });
});

const COMMENTS_PER_USER = 10;
app.post('/api/discover/:id/comment', dataLimiter, authMiddleware, (req, res) => {
  const p = discoverPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  const text = String((req.body || {}).text || '').trim();
  if (!text || text.length > 500) return res.status(400).json({ error: 'Comment must be 1-500 chars.' });
  
  if ((p.comments || (p.comments = [])).length >= 200) return res.status(429).json({ error: 'This post has reached its comment limit.' });
  const user = sessions.get(req.authToken).username, handle = publicHandle(user);
  // The post-wide cap is 200: without a per-account cap a single account could use all of it and silence everyone else.
  if (p.comments.filter(c => c.user === handle).length >= COMMENTS_PER_USER) return res.status(429).json({ error: `You can post at most ${COMMENTS_PER_USER} comments on one post.` });
  const comment = { id: crypto.randomBytes(4).toString('hex'), user: handle, text, date: Date.now() };
  p.comments.push(comment);
  saveDiscoverSoon();
  res.json({ ok: true, comment });
});

/* ═══════════════════════════════════════════════════════════
   🎯 DEMO ARENA — virtual-credit prediction simulator (no real money, ever). Logic lives in demo-arena.js.
   ═══════════════════════════════════════════════════════════ */
async function demoFeed() {
  try {
    const live = await getFixtures();
    const byId = new Map(live.map(f => [String(f.id), f]));
    const cut = dateDaysAgo(3);
    for (const s of snapshotStore.values()) if (s && s.status === 'finished' && s.date >= cut && !byId.has(String(s.id))) byId.set(String(s.id), s);
    return { ok: true, fixtures: [...byId.values()] };
  } catch (e) { return { ok: false, error: e.message, fixtures: [] }; }
}
function demoLookup(id) {
  const f = findFixture(id), s = snapshotStore.get(String(id));
  const sFinal = s && s.status === 'finished' && Number.isInteger(s.homeScore) && Number.isInteger(s.awayScore);
  const src = sFinal && (!f || f.status !== 'finished') ? s : (f || s);
  return src ? { status: src.status, homeScore: src.homeScore, awayScore: src.awayScore } : null;
}
const demoArena = require('./demo-arena').create({
  app, authMiddleware, requireAdmin, dataLimiter, writeAtomic, makeSaver, planOf,
  getSession: req => sessions.get(req.authToken),
  isAdminSession,
  file: process.env.DEMO_FILE || path.join(path.dirname(HISTORY_FILE), 'demo-arena.json'),
  getFeed: demoFeed,
  lookupMatch: demoLookup,
  providerStatus: () => ({
    configured: !!(BZZOIRO_API_KEY || API_KEY || apiFootball.status().enabled),
    providers: { bzzoiro: !!BZZOIRO_API_KEY, footballData: !!API_KEY, apiFootball: apiFootball.status().enabled },
    apiFootball: apiFootball.status(),
    bzzoiroRequestsToday: bzzUsage.n, bzzoiroDailyBudget: BZZ_DAILY_BUDGET,
  }),
  planOfUserKey: key => {
    const i = key.indexOf(':'), kind = key.slice(0, i), name = key.slice(i + 1);
    return kind === 'email' ? planOf({ kind: 'local', username: name }) : null;
  }
});
demoSaver = demoArena.saver;


// Error handler LAST among the routes: Express only sends errors to handlers registered after the route that threw (Discover/uploads used to answer with an HTML 500).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && (err.status || err.statusCode);
  if (status === 413) return res.status(413).json({ error: 'Request too large' });
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'Bad request' });
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'Server error' });
});

// ✅ Express 5 JSON 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
