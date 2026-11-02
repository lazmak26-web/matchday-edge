const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer'); // ✅ زدنا هادي باش نرفعو التصاور

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

const BZZOIRO_API_KEY = process.env.BZZOIRO_API_KEY;
const BZZOIRO_API_BASE = 'https://sports.bzzoiro.com/api';
const afOdds = require('./apifootball').create({
  key: process.env.APIFOOTBALL_KEY,
  teamsFuzzyMatch: (a, b) => teamsFuzzyMatch(a, b),
  dailyBudget: parseInt(process.env.APIFOOTBALL_DAILY_BUDGET, 10) || 90,
  maxPages: parseInt(process.env.APIFOOTBALL_MAX_PAGES, 10) || 6,
  statsBudget: parseInt(process.env.APIFOOTBALL_STATS_BUDGET, 10) || 35,
  onUpdate: () => { fixturesCache.data = null; }
});

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

/* ═══════════════════════════════════════════════════════════
   ✅ FIX: userFails كانت معرفة تحت app.listen وطيحت السيرفر، دبا تنقلت للفوق
   ═══════════════════════════════════════════════════════════ */
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
const FORM_TTL = 60 * 60 * 1000;
const FIXTURES_TTL = 20 * 1000;
const EVENTS_TTL_ACTIVE = 60 * 1000;
const EVENTS_TTL_IDLE = 10 * 60 * 1000;
const FD_TTL_ACTIVE = 60 * 1000;
const FD_TTL_IDLE = 10 * 60 * 1000;
const ODDS_TTL = 60 * 1000;
const ODDS_EVENT_TTL = 10 * 60 * 1000;
const ODDS_MISS_TTL = 3 * 60 * 1000;
const FORM_MISS_TTL = 10 * 60 * 1000;
const HISTORY_TTL = 5 * 60 * 1000;

const CONCURRENCY = 2;
const ODDS_CONCURRENCY = 3;
const API_DELAY = 400;
const ODDS_DELAY = 150;

const formCache = new Map();
const fixturesCache = { data: null, ts: 0 };
const eventsCache = { data: null, ts: 0 };
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
const bzzUsage = { day: null, n: 0 };
function bzzRoll() { const d = new Date().toISOString().slice(0, 10); if (bzzUsage.day !== d) { bzzUsage.day = d; bzzUsage.n = 0; } }
function bzzCount() { bzzRoll(); bzzUsage.n++; if (bzzUsage.n % 100 === 0) console.log(`📈 Bzzoiro requests today: ${bzzUsage.n}/${BZZ_DAILY_BUDGET}`); }
function bzzBudgetOk() { bzzRoll(); return bzzUsage.n < BZZ_DAILY_BUDGET; }

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
   TEAM ALIASES & MATCHING
   ═══════════════════════════════════════════════════════════ */
const TEAM_ALIASES = {
  'manchester united fc': 'manchester united', 'manchester city fc': 'manchester city',
  'arsenal fc': 'arsenal', 'chelsea fc': 'chelsea', 'liverpool fc': 'liverpool',
  'tottenham hotspur fc': 'tottenham hotspur', 'newcastle united fc': 'newcastle united',
  'aston villa fc': 'aston villa', 'west ham united fc': 'west ham united',
  'brighton & hove albion fc': 'brighton and hove albion', 'wolverhampton wanderers fc': 'wolverhampton wanderers',
  'nottingham forest fc': 'nottingham forest', 'crystal palace fc': 'crystal palace',
  'everton fc': 'everton', 'fulham fc': 'fulham', 'brentford fc': 'brentford',
  'afc bournemouth': 'bournemouth', 'leicester city fc': 'leicester city',
  'ipswich town fc': 'ipswich town', 'southampton fc': 'southampton',
  'real madrid cf': 'real madrid', 'fc barcelona': 'barcelona', 'atletico de madrid': 'atletico madrid',
  'sevilla fc': 'sevilla', 'real betis balompie': 'real betis', 'valencia cf': 'valencia',
  'villarreal cf': 'villarreal', 'athletic club': 'athletic bilbao',
  'fc internazionale milano': 'inter milan', 'ac milan': 'ac milan', 'juventus fc': 'juventus',
  'ssc napoli': 'napoli', 'as roma': 'roma', 'ss lazio': 'lazio', 'atalanta bc': 'atalanta',
  'acf fiorentina': 'fiorentina', 'fc bayern munchen': 'bayern munich', 'borussia dortmund': 'borussia dortmund',
  'rb leipzig': 'rb leipzig', 'bayer 04 leverkusen': 'bayer leverkusen', 'eintracht frankfurt': 'eintracht frankfurt',
  'paris saint-germain fc': 'paris saint germain', 'olympique de marseille': 'marseille',
  'olympique lyonnais': 'lyon', 'as monaco': 'monaco', 'losc lille': 'lille',
  'us sassuolo calcio': 'sassuolo', 'torino fc': 'torino', 'como 1907': 'como', 'cagliari calcio': 'cagliari'
};

function normalizeTeamKey(home, away) {
  const clean = s => {
    let t = String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    return TEAM_ALIASES[t] || t;
  };
  return `${clean(home)}|${clean(away)}`;
}

function teamsFuzzyMatch(a, b) {
  if (!a || !b) return false;
  const clean = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(fc|ac|as|us|ss|cf|sc|afc|cd|club|calcio|sporting|sport|city|united|town|the|de|la|le|1907|calcio)\b/g, ' ').replace(/[^a-z0-9]/g, '').trim();
  const ca = clean(a), cb = clean(b);
  if (!ca || !cb) return false;
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

/* ═══════════════════════════════════════════════════════════
   STATUS NORMALIZATION
   ═══════════════════════════════════════════════════════════ */
const STATUS_FINISHED = new Set(['finished','ft','ended','full_time','fulltime','after_extra_time','after_penalties','aet','pen','ended_after_extra_time','ended_after_penalties','full-time','end']);
const STATUS_CANCELED = new Set(['canceled','cancelled','abandoned','postponed','suspended','interrupted']);
const STATUS_LIVE = new Set(['in_play','inplay','live','started','halftime','ht','in_progress','1h','2h','first_half','second_half','playing','paused','break','int','in-progress','half_time']);
const STATUS_NOTSTARTED = new Set(['not_started','notstarted','scheduled','timed','tbd','pre','upcoming','not-started']);

function normalizeStatus(rawStatus, kickoffDate) {
  const s = String(rawStatus || '').toLowerCase().trim().replace(/[\s\-]+/g, '_');
  if (STATUS_FINISHED.has(s)) return 'finished';
  if (STATUS_CANCELED.has(s)) return 'canceled';
  if (STATUS_LIVE.has(s)) return 'started';
  if (STATUS_NOTSTARTED.has(s) || !s) {
    if (kickoffDate) {
      const e = Date.now() - new Date(kickoffDate).getTime();
      if (!isNaN(e)) {
        if (e > 4 * 60 * 60 * 1000) return 'finished';
        if (e > 10 * 60 * 1000) return 'started';
      }
    }
    return 'notstarted';
  }
  if (kickoffDate) {
    const e = Date.now() - new Date(kickoffDate).getTime();
    if (!isNaN(e)) {
      if (e > 4 * 60 * 60 * 1000) return 'finished';
      if (e > 10 * 60 * 1000) return 'started';
    }
  }
  return 'notstarted';
}

function pickBetterStatus(a, b) {
  const o = { finished: 4, started: 3, canceled: 2, notstarted: 1 };
  return (o[a] || 0) >= (o[b] || 0) ? a : b;
}

/* ═══════════════════════════════════════════════════════════
   APIs & DATA FETCHING
   ═══════════════════════════════════════════════════════════ */
async function apiGet(endpoint) {
  if (Date.now() < fdBlockedUntil) throw new Error('football-data cooling down after 429');
  const r = await fetch(`${API_BASE}${endpoint}`, { headers: { 'X-Auth-Token': API_KEY || '' } });
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
   TEAM FORMS FROM BZZOIRO RESULTS
   ═══════════════════════════════════════════════════════════ */
const BZZ_FORM_TTL = 6 * 60 * 60 * 1000;
const BZZ_FORM_RETRY = 10 * 60 * 1000;
const BZZ_FORM_DAYS = Math.max(7, parseInt(process.env.BZZ_FORM_DAYS, 10) || 30);
const BZZ_FORM_GAMES = Math.min(15, Math.max(5, parseInt(process.env.BZZ_FORM_GAMES, 10) || 8));
const BZZ_FORM_MAX_PAGES = Math.max(1, parseInt(process.env.BZZ_FORM_MAX_PAGES, 10) || 80);
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
          const r = await fetch(url, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' } });
          if (!r.ok) throw new Error(`Bzz forms HTTP ${r.status}`);
          const data = await r.json();
          events.push(...(data.results || data.data || []));
          url = typeof data.next === 'string' && data.next ? data.next : null;
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
const cachedLogo = name => { const c = logoCache.get(logoKey(name)); return c && c.url ? c.url : null; };

function cleanNameForSearch(name) {
  return String(name || '')
    .replace(/\b(fc|afc|sc|ac|cf|club|calcio|as|ss|us|cd)\b/gi, '')
    .replace(/[^\w\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchLogoByName(name) {
  try {
    const searchName = cleanNameForSearch(name);
    const r = await fetch(`https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(searchName)}`);
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

async function fetchBzzoiroEvents() {
  if (!BZZOIRO_API_KEY) return [];
  const eventsTtl = isActive() ? EVENTS_TTL_ACTIVE : EVENTS_TTL_IDLE;
  if (eventsCache.data && Date.now() - eventsCache.ts < eventsTtl) return eventsCache.data;
  if (!bzzBudgetOk()) return eventsCache.data || [];
  if (eventsFetchInProgress) return eventsFetchInProgress;
  eventsFetchInProgress = (async () => {
    try {
      bzzCount();
      const r = await fetch(`${BZZOIRO_API_BASE}/v2/events/?date_from=${todayStr()}&date_to=${todayStr()}`, {
        headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' }
      });
      if (!r.ok) throw new Error(`Events HTTP ${r.status}`);
      const data = await r.json();
      const events = data.results || data.data || [];
      if (Array.isArray(events) && events.length > 0) {
        eventsCache.data = events; eventsCache.ts = Date.now();
      } else if (!eventsCache.data || !eventsCache.data.length) {
        eventsCache.data = events; eventsCache.ts = Date.now();
      } else {
        eventsCache.ts = Date.now() - eventsTtl + 10 * 1000;
      }
      return eventsCache.data || [];
    } catch (e) { return eventsCache.data || []; }
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
    const r = await fetch(`${BZZOIRO_API_BASE}/v2/events/${eventId}/odds/`, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}` } });
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
        if (!bzzBudgetOk()) return false;
        if (!c) return true;
        return now - c.ts > (c.parsed ? ODDS_EVENT_TTL : ODDS_MISS_TTL);
      });
      const workers = Array.from({ length: ODDS_CONCURRENCY }, async () => {
        while (queue.length) {
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
  const inj = afOdds.injuriesFor(H.name, A.name, new Date(fixture.date + 'T' + fixture.kickoff + ':00Z').getTime());
  if (inj) { H.injuries = inj.home; A.injuries = inj.away; }
  if (H.xgFor != null && A.xgFor != null) { fixture.xgSource = 'direct'; fixture.dataQuality = 'high'; return; }
  const ss = afOdds.statsFor(H.name, A.name, new Date(fixture.date + 'T' + fixture.kickoff + ':00Z').getTime());
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

function mergeOdds(base, home, away, kickoffMs) {
  const out = base ? [base] : [], seen = new Set(out.map(b => String(b.book).toLowerCase()));
  for (const b of afOdds.lookup(home, away, kickoffMs)) { const k = String(b.book).toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(b); } }
  return out;
}

function dedupeFixtures(fixtures) {
  const seen = new Map(), result = [];
  for (const f of fixtures) {
    const key = `${f.date}|${f.kickoff}|${normalizeTeamKey(f.home.name, '').split('|')[0]}|${normalizeTeamKey(f.away.name, '').split('|')[0]}`;
    if (!seen.has(key)) { seen.set(key, f); result.push(f); }
  }
  return result;
}

async function getFixtures() {
  if (fixturesCache.data && Date.now() - fixturesCache.ts < FIXTURES_TTL) return fixturesCache.data;
  if (fixturesFetchInProgress) return fixturesFetchInProgress;

  fixturesFetchInProgress = (async () => {
    try {
      const eventsP = fetchBzzoiroEvents().catch(() => []);
      const fdP = API_KEY ? fetchFdMatches() : Promise.resolve([]);

      let oddsMap = oddsCache.data;
      if (!oddsMap || Date.now() - oddsCache.ts > ODDS_TTL) {
        oddsMap = await fetchOdds().catch(() => oddsMap || new Map());
      }
      if (!oddsMap) oddsMap = new Map();

      const [bzzEvents, fdMatches] = await Promise.all([eventsP, fdP]);
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
          if (teamsFuzzyMatch(ev.home_team, m.homeTeam.name) && teamsFuzzyMatch(ev.away_team, m.awayTeam.name)) {
            fdMatch = m; usedFdIds.add(m.id); break;
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

        if (status === 'finished' && !fdHasScore && (ev.home_score == null || ev.away_score == null)) status = 'started';
        const fixture = {
          id: `bzz_${ev.id}`,
          league: fdMatch?.competition?.name || (ev.league_id ? `League #${ev.league_id}` : 'Football'),
          date: kickoff.toISOString().slice(0, 10),
          kickoff: kickoff.toISOString().slice(11, 16),
          status, homeScore, awayScore,
          home: {
            id: fdMatch?.homeTeam.id || null,
            name: ev.home_team,
            logo: fdMatch?.homeTeam?.crest || ev.home_team_logo || ev.home_logo || cachedLogo(ev.home_team) || null,
            form: hf?.form || null,
            gf5: hf?.gf5 ?? null,
            ga5: hf?.ga5 ?? null,
            formN: hf?.n ?? null
          },
          away: {
            id: fdMatch?.awayTeam.id || null,
            name: ev.away_team,
            logo: fdMatch?.awayTeam?.crest || ev.away_team_logo || ev.away_logo || cachedLogo(ev.away_team) || null,
            form: af?.form || null,
            gf5: af?.gf5 ?? null,
            ga5: af?.ga5 ?? null,
            formN: af?.n ?? null
          },
          odds: mergeOdds(oddsMap.get(normalizeTeamKey(ev.home_team, ev.away_team)), ev.home_team, ev.away_team, kickoff.getTime()),
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
          home: { id: m.homeTeam.id, name: m.homeTeam.name, logo: m.homeTeam.crest || cachedLogo(m.homeTeam.name) || null, form: hf?.form || null, gf5: hf?.gf5 ?? null, ga5: hf?.ga5 ?? null, formN: hf?.n ?? null },
          away: { id: m.awayTeam.id, name: m.awayTeam.name, logo: m.awayTeam.crest || cachedLogo(m.awayTeam.name) || null, form: af?.form || null, gf5: af?.gf5 ?? null, ga5: af?.ga5 ?? null, formN: af?.n ?? null },
          odds: mergeOdds(odds, m.homeTeam.name, m.awayTeam.name, kickoff.getTime()),
          sources: odds ? ['fd', 'bzz'] : ['fd']
        };
        if (fixture.status === 'finished' && (m.score?.fullTime?.home == null || m.score?.fullTime?.away == null)) fixture.status = 'started';
        estimateXGForFixture(fixture);
        fixtures.push(fixture);
      }

      const deduped = dedupeFixtures(fixtures);
      try { recordSnapshots(deduped); } catch (e) { console.error('Snapshot error:', e.message); }
      fixturesCache.data = deduped; fixturesCache.ts = Date.now(); lastFixtures = deduped;
      return deduped;
    } finally { fixturesFetchInProgress = null; }
  })();
  return fixturesFetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   PERSISTENT SNAPSHOT STORE
   ═══════════════════════════════════════════════════════════ */
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, 'data', 'history.json');
const HISTORY_KEEP_DAYS = 60;
const RESULTS_REFRESH_TTL = 5 * 60 * 1000;
const snapshotStore = new Map();
let resultsRefreshInProgress = null;

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
const saveSnapshotsSoon = snapshotSaver.soon;

function recordSnapshots(fixtures) {
  let changed = false;
  for (const f of fixtures) {
    if (!f || !f.id || !f.home || !f.away) continue;
    const prev = snapshotStore.get(f.id);

    if (!prev) {
      if (f.status !== 'notstarted') continue;
      snapshotStore.set(f.id, Object.assign(JSON.parse(JSON.stringify(f)), { openOdds: JSON.parse(JSON.stringify(f.odds || [])) }));
      changed = true;
      continue;
    }

    if (prev.status === 'notstarted' && f.status === 'notstarted') {
      const open = prev.openOdds || JSON.parse(JSON.stringify(prev.odds || []));
      snapshotStore.set(f.id, Object.assign(JSON.parse(JSON.stringify(f)), { openOdds: open }));
      changed = true;
      continue;
    }

    if (f.status !== 'canceled' && (prev.status !== f.status || prev.homeScore !== f.homeScore || prev.awayScore !== f.awayScore)) {
      if (prev.status !== 'finished' || f.status === 'finished') {
        prev.status = f.status; prev.homeScore = f.homeScore; prev.awayScore = f.awayScore;
        changed = true;
      }
    }
    if (!prev.home.logo && f.home.logo) { prev.home.logo = f.home.logo; changed = true; }
    if (!prev.away.logo && f.away.logo) { prev.away.logo = f.away.logo; changed = true; }
  }
  if (changed) saveSnapshotsSoon();
}

async function refreshHistoryResults() {
  if (!BZZOIRO_API_KEY) return;
  if (Date.now() - historyCache.ts < RESULTS_REFRESH_TTL) return;
  if (!bzzBudgetOk()) return;
  if (resultsRefreshInProgress) return resultsRefreshInProgress;

  const unfinished = [...snapshotStore.values()].filter(f => {
    if (f.status === 'finished' || !String(f.id).startsWith('bzz_')) return false;
    const t = new Date(f.date + 'T' + f.kickoff + ':00Z').getTime();
    return isNaN(t) || t < Date.now();
  });
  if (!unfinished.length) { historyCache.ts = Date.now(); return; }

  resultsRefreshInProgress = (async () => {
    try {
      const oldest = unfinished.reduce((m, f) => (f.date < m ? f.date : m), todayStr());
      const dateFrom = oldest < dateDaysAgo(14) ? dateDaysAgo(14) : oldest;
      let url = `${BZZOIRO_API_BASE}/v2/events/?date_from=${dateFrom}&date_to=${todayStr()}`;
      let changed = false;

      for (let page = 0; url && page < 10; page++) {
        bzzCount();
        const r = await fetch(url, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' } });
        if (!r.ok) throw new Error(`Results refresh HTTP ${r.status}`);
        const data = await r.json();
        for (const ev of (data.results || data.data || [])) {
          const snap = snapshotStore.get(`bzz_${ev.id}`);
          if (!snap || snap.status === 'finished') continue;
          if (normalizeStatus(ev.status, ev.event_date) !== 'finished') continue;
          if (ev.home_score == null || ev.away_score == null) continue;
          snap.status = 'finished';
          snap.homeScore = ev.home_score;
          snap.awayScore = ev.away_score;
          changed = true;
        }
        url = typeof data.next === 'string' && data.next ? data.next : null;
      }
      if (changed) saveSnapshotsSoon();
      historyCache.ts = Date.now();
    } catch (e) {
      console.error(e.message);
    } finally { resultsRefreshInProgress = null; }
  })();
  return resultsRefreshInProgress;
}

loadSnapshots();

/* ═══════════════════════════════════════════════════════════
   KEYAUTH HELPERS
   ═══════════════════════════════════════════════════════════ */
async function keyauthRequest(params) {
  const url = new URL(KEYAUTH_BASE);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const r = await fetch(url.toString(), { method: 'GET' });
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
   AUTH MIDDLEWARE & ENDPOINTS
   ═══════════════════════════════════════════════════════════ */
function authMiddleware(req, res, next) {
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!token || token.length > 200) return res.status(401).json({ error: 'Authentication required' });
  const key = tokHash(token), now = Date.now();
  const sess = sessions.get(key);
  if (!sess || sessionExpired(sess, now)) {
    if (sess) { sessions.delete(key); saveSessionsSoon(); }
    return res.status(401).json({ error: 'Session expired' });
  }
  if (now - (sess.lastSeen || 0) > 10 * 60 * 1000) { sess.lastSeen = now; saveSessionsSoon(); }
  req.authToken = key;
  next();
}

app.disable('x-powered-by');
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
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

app.set('trust proxy', 1);

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

app.use(express.json({ limit: '10kb' }));
app.use(pageLimiter);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], dotfiles: 'deny', index: 'index.html' }));

/* ═══════════════════════════════════════════════════════════
   EMAIL ACCOUNTS
   ═══════════════════════════════════════════════════════════ */
const USERS_FILE = process.env.USERS_FILE || path.join(path.dirname(HISTORY_FILE), 'users.json');
const users = new Map();
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const u of arr) if (u && u.email && u.salt && u.hash) users.set(u.email, u);
    console.log(`👤 Loaded ${users.size} accounts`);
  } catch (e) { console.error('Users load error:', e.message); }
}
const userSaver = makeSaver('Users', () => writeAtomic(USERS_FILE, JSON.stringify([...users.values()])), 1000);
const saveUsersSoon = userSaver.soon;
loadUsers();
loadSessions();
const TERMS_VERSION = '2026-11-01';
const SCRYPT_MAX = 3, SCRYPT_QUEUE = 40;
let scryptActive = 0;
const scryptWait = [];
const scryptAsync = (pw, salt) => new Promise((ok, no) => {
  const run = () => {
    scryptActive++;
    crypto.scrypt(pw, salt, 64, (e, k) => {
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

async function sendMail(to, subject, text, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(`Mail API HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
}

async function sendOtp(email) {
  const now = Date.now();
  const prev = otps.get(email);
  if (prev && now < prev.exp && now - prev.sentAt < OTP_RESEND_GAP) {
    return { ok: true, reused: true, resendIn: Math.ceil((OTP_RESEND_GAP - (now - prev.sentAt)) / 1000) };
  }
  const cap = otpSends.get(email) || { n: 0, t: now };
  if (now - cap.t > 3600000) { cap.n = 0; cap.t = now; }
  if (cap.n >= OTP_MAX_SENDS_PER_HOUR) return { error: 'Too many codes requested. Try again later.', status: 429 };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  try {
    await sendMail(email, 'Your LuciBet login code',
      `Your LuciBet verification code is ${code}. It expires in 10 minutes. If you did not request it, you can ignore this email.`,
      `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px"><h2 style="margin:0 0 12px">LuciBet</h2><p>Your verification code is:</p><p style="font-size:32px;letter-spacing:6px;font-weight:800;margin:12px 0">${code}</p><p style="color:#666">It expires in 10 minutes. If you did not request it, you can ignore this email.</p></div>`);
  } catch (e) {
    console.error('OTP mail error:', e.message);
    return { error: 'Could not send the code. Please try again.', status: 502 };
  }
  otps.set(email, { hash: otpHash(email, code), exp: now + OTP_TTL, tries: 0, sentAt: now });
  cap.n++; otpSends.set(email, cap);
  return { ok: true, resendIn: OTP_RESEND_GAP / 1000 };
}

function planOf(sess) {
  if (!sess) return 'free';
  if (sess.kind === 'keyauth') return sess.lifetime === true || !sess.expiry || sess.expiry > Date.now() ? 'pro' : 'free';
  const u = users.get(sess.username);
  return u && u.plan === 'pro' && (!u.planUntil || u.planUntil > Date.now()) ? 'pro' : 'free';
}

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'marocheat2@gmail.com').trim().toLowerCase();
function isAdminSession(sess) {
  if (!sess || sess.kind !== 'local' || sess.username !== ADMIN_EMAIL) return false;
  const u = users.get(sess.username);
  if (!u || u.verified === false) return false;
  return OTP_ENABLED || process.env.ADMIN_ALLOW_NO_OTP === '1';
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
function startSession(res, sess) {
  const token = crypto.randomBytes(32).toString('hex');
  const key = tokHash(token), now = Date.now();
  sessions.set(key, { ...sess, createdAt: now, lastSeen: now });
  const mine = [...sessions.entries()].filter(([, v]) => v.username === sess.username).sort((a, b) => b[1].createdAt - a[1].createdAt);
  for (const [k] of mine.slice(MAX_SESSIONS_PER_USER)) sessions.delete(k);
  saveSessionsSoon();
  res.json({ token, username: sess.username, expiresIn: SESSION_TTL, profile: profileOf(sessions.get(key)) });
}
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

async function localLogin(res, email, password, uKey) {
  if (otpUnavailable(res)) return;
  const u = users.get(email);
  let ok = false;
  try {
    const dk = await scryptAsync(password, u ? Buffer.from(u.salt, 'hex') : DUMMY_SALT);
    ok = !!u && crypto.timingSafeEqual(dk, Buffer.from(u.hash, 'hex'));
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
  if (!OTP_ENABLED) return startSession(res, { kind: 'local', username: email });
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
  try {
    const salt = crypto.randomBytes(16);
    const hash = await scryptAsync(password, salt);
    const cur = users.get(email);
    if (taken(cur)) return res.status(409).json({ error: 'This email is already registered. Please log in.' });
    if (cur) { cur.salt = salt.toString('hex'); cur.hash = hash.toString('hex'); }
    else {
      const seq = [...users.values()].reduce((m, u) => Math.max(m, u.seq || 0), 0) + 1;
      users.set(email, { email, salt: salt.toString('hex'), hash: hash.toString('hex'), plan: 'free', planUntil: null, createdAt: Date.now(), seq, verified: !OTP_ENABLED, consentAt: Date.now(), termsVersion: TERMS_VERSION });
    }
    saveUsersSoon();
    if (!OTP_ENABLED) return startSession(res, { kind: 'local', username: email });
    const o = await sendOtp(email);
    if (!o.ok) return res.status(o.status).json({ error: o.error });
    res.json({ otpRequired: true, email, resendIn: o.resendIn });
  } catch (e) {
    if (e && e.busy) return res.status(503).json({ error: 'Server is busy. Please try again in a moment.' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/verify-otp', loginLimiter, (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').replace(/\D/g, '');
  const u = users.get(email), rec = otps.get(email);
  if (!u || !rec || Date.now() > rec.exp) return res.status(400).json({ error: 'Code expired. Please request a new one.' });
  if (rec.tries >= OTP_MAX_TRIES) { otps.delete(email); return res.status(429).json({ error: 'Too many wrong attempts. Please request a new code.' }); }
  rec.tries++;
  const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(otpHash(email, code), 'hex'), Buffer.from(rec.hash, 'hex'));
  if (!ok) return res.status(400).json({ error: 'Wrong code.', triesLeft: OTP_MAX_TRIES - rec.tries });
  otps.delete(email);
  if (u.verified === false) { u.verified = true; saveUsersSoon(); }
  startSession(res, { kind: 'local', username: email });
});

app.post('/api/auth/resend-otp', loginLimiter, async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!OTP_ENABLED || !users.has(email) || !otps.has(email)) return res.status(400).json({ error: 'Please log in again to get a new code.' });
  const o = await sendOtp(email);
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

app.post('/api/admin/plan', loginLimiter, (req, res) => {
  const tok = process.env.ADMIN_TOKEN;
  if (!tok) return res.status(404).end();
  const a = Buffer.from(String(req.headers['x-admin-token'] || '')), b = Buffer.from(tok);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'Forbidden' });
  const { email, plan, days } = req.body || {};
  const u = users.get(String(email || '').trim().toLowerCase());
  if (!u) return res.status(404).json({ error: 'No such account' });
  if (plan === 'pro') { u.plan = 'pro'; u.planUntil = Number(days) > 0 ? Date.now() + Number(days) * 86400000 : null; }
  else { u.plan = 'free'; u.planUntil = null; }
  saveUsersSoon();
  res.json({ ok: true, email: u.email, plan: u.plan, planUntil: u.planUntil });
});

/* ═══════════════════════════════════════════════════════════
   LICENSE KEYS
   ═══════════════════════════════════════════════════════════ */
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

app.post('/api/admin/license', loginLimiter, (req, res) => {
  const ok = adminOk(req);
  if (ok === null) return res.status(404).end();
  if (!ok) return res.status(403).json({ error: 'Forbidden' });
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
  res.json({ ok: true, days, keys });
});

async function keyauthLicense(key, sessionid, hwid) {
  return keyauthRequest({ type: 'license', key, hwid, sessionid, name: KEYAUTH_NAME, ownerid: KEYAUTH_OWNERID, secret: KEYAUTH_SECRET });
}
app.post('/api/license/activate', loginLimiter, authMiddleware, async (req, res) => {
  const sess = sessions.get(req.authToken);
  if (!sess || sess.kind !== 'local') return res.status(400).json({ error: 'This login is already Premium.' });
  const u = users.get(sess.username);
  if (!u) return res.status(404).json({ error: 'Account not found' });
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
  res.json({ ok: true, profile: profileOf(sess) });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { username, password, hwid } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 200 || (hwid != null && (typeof hwid !== 'string' || hwid.length > 200))) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  const uKey = username.toLowerCase();
  const uf = userFails.get(uKey);
  if (uf && uf.n >= 8 && Date.now() - uf.t < 10 * 60 * 1000) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  if (username.includes('@')) return localLogin(res, username.trim().toLowerCase(), password, uKey);
  if (!AUTH_CONFIGURED) return res.status(503).json({ error: 'Login is temporarily unavailable.' });
  try {
    const init = await keyauthInit();
    if (!init.success) throw new Error(init.message || 'Init failed');
    const sessionid = init.sessionid;

    const login = await keyauthLogin(username, password, sessionid, hwid);
    if (!login.success) throw new Error(login.message || 'Invalid username or password');

    userFails.delete(uKey);
    const subs = (login.info && login.info.subscriptions) || [];
    const exp = Math.max(0, ...subs.map(x => Number(x.expiry) || 0));
    const sx = { kind: 'keyauth', keyauthSessionId: sessionid, username };
    if (exp > 0) { if (exp * 1000 > Date.UTC(2090, 0, 1)) sx.lifetime = true; else sx.expiry = exp * 1000; }
    startSession(res, sx);
  } catch (e) {
    const f = userFails.get(uKey) || { n: 0, t: Date.now() };
    f.n++; f.t = Date.now(); userFails.set(uKey, f);
    res.status(401).json({ error: e.message });
  }
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ ok: true, ...profileOf(sessions.get(req.authToken)) });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  sessions.delete(req.authToken);
  saveSessionsSoon();
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
      id: f.id, league: f.league, date: f.date, kickoff: f.kickoff, status: f.status,
      homeScore: f.status === 'started' ? f.homeScore : null,
      awayScore: f.status === 'started' ? f.awayScore : null,
      home: { name: f.home.name, logo: f.home.logo || null },
      away: { name: f.away.name, logo: f.away.logo || null }
    }));
    res.set('Cache-Control', 'public, max-age=15');
    res.json({ fixtures: out });
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
const ENGINE_MIN_BOOKS = Number.isFinite(parseInt(process.env.ENGINE_MIN_BOOKS, 10)) ? Math.max(1, parseInt(process.env.ENGINE_MIN_BOOKS, 10)) : 2;
const ENGINE_MARKET_WEIGHT = (() => { const v = parseFloat(process.env.ENGINE_MARKET_WEIGHT); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.7; })();
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
  const upcoming = fixtures.filter(f => f.status === 'notstarted');
  if (!upcoming.length) return fixtures;
  const teams = upcoming.flatMap(f => [f.home, f.away]).filter(t => t.id);
  const pending = [teams.length ? ensureForms(teams) : null, ensureBzzForms(), afOdds.ensure(), afOdds.ensureStats(upcoming.map(f => ({ home: f.home.name, away: f.away.name, t: new Date(f.date + 'T' + f.kickoff + ':00Z').getTime() })))].filter(Boolean);
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
    const teams = fixtures.filter(f => f.status === 'notstarted').flatMap(f => [f.home, f.away]).filter(t => t.id);
    res.json({ fixtures });
    if (teams.length && !prefetchInProgress) ensureForms(teams).catch(e => console.error(e.message));
    const logoP = ensureLogos(fixtures.flatMap(f => [f.home, f.away]));
    if (logoP) logoP.catch(e => console.error('Logo fetch error:', e.message));
  } catch (e) { res.status(500).json({ error: 'Server error', fixtures: [] }); }
});

const enginePre = require('./engine/prematch'), engineDecide = require('./engine/decision'), engineValidate = require('./engine/validate');
app.get('/api/engine/predictions', authMiddleware, requirePro, async (req, res) => {
  try {
    const fixtures = await getFixturesWithForms();
    const eloBook = getEloBook(), lgAvg = getLeagueAvgs();
    const qmw = parseFloat(req.query.mw), qev = parseFloat(req.query.mev);
    const mw = Number.isFinite(qmw) && qmw >= 0 && qmw <= 1 ? qmw : ENGINE_MARKET_WEIGHT;
    const dOpts = { minBooks: ENGINE_MIN_BOOKS, maxGap: ENGINE_MAX_GAP };
    if (Number.isFinite(qev) && qev >= 0 && qev <= 0.5) dOpts.minEV = qev;
    const out = fixtures.map(fx0 => {
      const f = lgAvg.has(fx0.league) ? Object.assign({}, fx0, { leagueAvg: lgAvg.get(fx0.league) }) : fx0;
      const pred = enginePre.predict(f, { marketWeight: mw, eloWeight: ENGINE_ELO_WEIGHT, eloBook });
      const decision = engineDecide.decide(f, pred, dOpts);
      return { id: f.id, bestEv: decision.best ? decision.best.ev : null, tier: decision.action === 'BET' ? 'BET' : ((decision.safety || []).length ? 'NO BET' : 'WATCH'), safety: (decision.safety || []), xgSource: f.xgSource || null, prediction: pred && { p: pred.p, over: pred.over, top: pred.top, source: pred.source }, validation: engineValidate.validate(pred, f, { maxGap: ENGINE_MAX_GAP }), decision };
    });
    const xgCounts = {}; for (const f of fixtures) { const k = f.xgSource || 'none'; xgCounts[k] = (xgCounts[k] || 0) + 1; }
    res.json({ predictions: out, meta: { minBooks: ENGINE_MIN_BOOKS, marketWeight: ENGINE_MARKET_WEIGHT, eloWeight: ENGINE_ELO_WEIGHT, apiFootball: afOdds.stats(), xgSources: xgCounts, bzzForms: bzzFormCache.stats || (BZZOIRO_API_KEY ? 'not run yet' : 'no BZZOIRO_API_KEY') } });
  } catch (e) { res.status(500).json({ error: 'Server error', predictions: [] }); }
});

app.get('/api/history', dataLimiter, async (req, res) => {
  try {
    await refreshHistoryResults().catch(e => console.error(e.message));
    const cutoff = dateDaysAgo(HISTORY_KEEP_DAYS);
    const fixtures = [...snapshotStore.values()]
      .filter(f => f.status === 'finished' && f.date >= cutoff)
      .sort((a, b) => (b.date + b.kickoff).localeCompare(a.date + a.kickoff));
    res.json({ fixtures });
  } catch (e) {
    res.status(500).json({ error: 'Server error', fixtures: [] });
  }
});

async function backgroundTick() {
  try {
    const fixtures = await getFixtures();
    if (API_KEY && !prefetchInProgress) {
      const teams = fixtures.filter(f => f.status === 'notstarted').flatMap(f => [f.home, f.away]).filter(t => t.id);
      if (teams.length) ensureForms(teams).catch(e => console.error(e.message));
    }
    ensureBzzForms();
    await refreshHistoryResults();
  } catch (e) { console.error('Background tick error:', e.message); }
}
setTimeout(backgroundTick, 10 * 1000);
setInterval(backgroundTick, 3 * 60 * 1000).unref();

app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && (err.status || err.statusCode);
  if (status === 413) return res.status(413).json({ error: 'Request too large' });
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'Bad request' });
  console.error('Unhandled error:', err && err.message);
  res.status(500).json({ error: 'Server error' });
});

const server = app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
server.headersTimeout = 15 * 1000;
server.requestTimeout = 20 * 1000;
server.keepAliveTimeout = 65 * 1000;
server.maxHeadersCount = 60;

setInterval(() => {
  const now = Date.now(); let n = 0;
  for (const [k, u] of users) if (u.verified === false && now - u.createdAt > 24 * 60 * 60 * 1000) { users.delete(k); otps.delete(k); otpSends.delete(k); n++; }
  if (n) { saveUsersSoon(); console.log(`🧹 Removed ${n} unverified sign-ups`); }
}, 60 * 60 * 1000).unref();

let shuttingDown = false;
function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: saving data before exit`);
  for (const sv of [userSaver, sessionSaver, licenseSaver, snapshotSaver, discoverSaver]) sv.now(); // ✅ زدنا discoverSaver
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
   ✅ DISCOVER (TWEETS & IMAGES)
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
const discoverSaver = makeSaver('Discover', () => writeAtomic(DISCOVER_FILE, JSON.stringify([...discoverPosts.values()])), 1000);
const saveDiscoverSoon = discoverSaver.soon;

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, crypto.randomBytes(8).toString('hex') + ext);
  }
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images are allowed'));
  }
});

app.post('/api/upload', authMiddleware, requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const url = '/uploads/' + req.file.filename;
  res.json({ ok: true, url });
});

app.get('/api/discover', authMiddleware, (req, res) => {
  const posts = [...discoverPosts.values()].sort((a, b) => b.date - a.date);
  res.json({ posts });
});

app.post('/api/discover', authMiddleware, requireAdmin, (req, res) => {
  const { text, image } = req.body || {};
  if (!text && !image) return res.status(400).json({ error: 'Post must have text or an image.' });
  const id = crypto.randomBytes(8).toString('hex');
  const post = { id, text: String(text || '').slice(0, 1000), image: String(image || '').slice(0, 500), date: Date.now(), likes: [], dislikes: [], comments: [] };
  discoverPosts.set(id, post);
  saveDiscoverSoon();
  res.json({ ok: true, post });
});

app.post('/api/discover/:id/:action', authMiddleware, (req, res) => {
  const action = req.params.action;
  if (action !== 'like' && action !== 'dislike') return res.status(400).json({ error: 'Invalid action' });
  
  const p = discoverPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  const user = sessions.get(req.authToken).username;
  const isLike = action === 'like';
  const arr = isLike ? p.likes : p.dislikes;
  const otherArr = isLike ? p.dislikes : p.likes;

  if (arr.includes(user)) {
    arr.splice(arr.indexOf(user), 1);
  } else {
    arr.push(user);
    const idx = otherArr.indexOf(user);
    if (idx > -1) otherArr.splice(idx, 1);
  }
  saveDiscoverSoon();
  res.json({ ok: true, likes: p.likes.length, dislikes: p.dislikes.length, isLiked: p.likes.includes(user), isDisliked: p.dislikes.includes(user) });
});

app.post('/api/discover/:id/comment', authMiddleware, (req, res) => {
  const p = discoverPosts.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Post not found' });
  const text = String((req.body || {}).text || '').trim();
  if (!text || text.length > 500) return res.status(400).json({ error: 'Comment must be 1-500 chars.' });
  
  const user = sessions.get(req.authToken).username;
  const comment = { id: crypto.randomBytes(4).toString('hex'), user: user.split('@')[0], text, date: Date.now() };
  p.comments.push(comment);
  saveDiscoverSoon();
  res.json({ ok: true, comment });
});