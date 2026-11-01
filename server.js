const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

const BZZOIRO_API_KEY = process.env.BZZOIRO_API_KEY;
const BZZOIRO_API_BASE = 'https://sports.bzzoiro.com/api';

/* ═══════════════════════════════════════════════════════════
   KEYAUTH CONFIG
   ═══════════════════════════════════════════════════════════ */
// No hardcoded fallbacks: secrets must come from environment variables (never from source code).
const KEYAUTH_NAME    = process.env.KEYAUTH_NAME;
const KEYAUTH_OWNERID = process.env.KEYAUTH_OWNERID;
const KEYAUTH_SECRET  = process.env.KEYAUTH_SECRET;
const KEYAUTH_VERSION = process.env.KEYAUTH_VERSION || "1.0";
const AUTH_CONFIGURED = !!(KEYAUTH_NAME && KEYAUTH_OWNERID && KEYAUTH_SECRET);
if (!AUTH_CONFIGURED) console.error('❌ KEYAUTH_NAME / KEYAUTH_OWNERID / KEYAUTH_SECRET are not set: login is disabled until they are.');
const MAX_SESSIONS_PER_USER = 2; // stops one key being shared by many people at once
const KEYAUTH_BASE    = 'https://keyauth.win/api/1.3/';

const SESSION_TTL = 24 * 60 * 60 * 1000;
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt > SESSION_TTL) sessions.delete(k);
  }
}, 60 * 60 * 1000).unref();

/* ═══════════════════════════════════════════════════════════
   CACHE & CONCURRENCY
   ═══════════════════════════════════════════════════════════ */
const FORM_TTL = 60 * 60 * 1000;
const FIXTURES_TTL = 20 * 1000;
// API-saving TTLs: refresh fast only while a match is live / about to start, slowly otherwise.
const EVENTS_TTL_ACTIVE = 60 * 1000;
const EVENTS_TTL_IDLE = 10 * 60 * 1000;
const FD_TTL_ACTIVE = 60 * 1000;
const FD_TTL_IDLE = 10 * 60 * 1000;
const ODDS_TTL = 60 * 1000;              // how often we check which odds are due
const ODDS_EVENT_TTL = 10 * 60 * 1000;   // each event's odds are re-fetched at most this often
const ODDS_MISS_TTL = 3 * 60 * 1000;     // retry delay when an odds request failed / had no odds
const FORM_MISS_TTL = 10 * 60 * 1000;    // retry delay when a team-form request failed
// ✅ 5 minutes TTL so landing page gets fresh history data
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
const oddsByEvent = new Map(); // eventId -> { parsed, ts }
let lastFixtures = null;

// Bzzoiro daily request budget (plan limit is 7,500/day; keep headroom for restarts & manual use).
const BZZ_DAILY_BUDGET = parseInt(process.env.BZZ_DAILY_BUDGET, 10) || 5500;
const bzzUsage = { day: null, n: 0 };
function bzzRoll() { const d = new Date().toISOString().slice(0, 10); if (bzzUsage.day !== d) { bzzUsage.day = d; bzzUsage.n = 0; } }
function bzzCount() { bzzRoll(); bzzUsage.n++; if (bzzUsage.n % 100 === 0) console.log(`📈 Bzzoiro requests today: ${bzzUsage.n}/${BZZ_DAILY_BUDGET}`); }
function bzzBudgetOk() { bzzRoll(); return bzzUsage.n < BZZ_DAILY_BUDGET; }

// Active = a match is live or kicks off within 15 min (or we have no data yet).
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

// Today's football-data matches, cached (60s while active, 10 min otherwise).
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
    if (!matches.length) return { form: null, gf5: null, ga5: null };
    let form = '', gf5 = 0, ga5 = 0;
    for (const m of matches) {
      const isHome = m.homeTeam.id === teamId;
      const scored = isHome ? m.score.fullTime.home : m.score.fullTime.away;
      const conceded = isHome ? m.score.fullTime.away : m.score.fullTime.home;
      gf5 += scored || 0; ga5 += conceded || 0;
      if (scored > conceded) form += 'W'; else if (scored === conceded) form += 'D'; else form += 'L';
    }
    return { form, gf5, ga5 };
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
      else formCache.set(team.id, { data: null, ts: Date.now() - FORM_TTL + FORM_MISS_TTL }); // don't hammer failures
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
      // Fetch odds for every valid event that is due (not fetched within ODDS_EVENT_TTL),
      // so every snapshot carries odds.
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
  if (H.xgFor != null && A.xgFor != null) { fixture.xgSource = 'direct'; fixture.dataQuality = 'high'; return; }
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

        const hf = fdMatch ? formCache.get(fdMatch.homeTeam.id)?.data : null;
        const af = fdMatch ? formCache.get(fdMatch.awayTeam.id)?.data : null;

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

        // Never mark a match finished without a real score (would corrupt WIN/LOSS history)
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
            ga5: hf?.ga5 ?? null
          },
          away: {
            id: fdMatch?.awayTeam.id || null,
            name: ev.away_team,
            logo: fdMatch?.awayTeam?.crest || ev.away_team_logo || ev.away_logo || cachedLogo(ev.away_team) || null,
            form: af?.form || null,
            gf5: af?.gf5 ?? null,
            ga5: af?.ga5 ?? null
          },
          odds: oddsMap.has(normalizeTeamKey(ev.home_team, ev.away_team)) ? [oddsMap.get(normalizeTeamKey(ev.home_team, ev.away_team))] : [],
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
          home: { id: m.homeTeam.id, name: m.homeTeam.name, logo: m.homeTeam.crest || cachedLogo(m.homeTeam.name) || null, form: hf?.form || null, gf5: hf?.gf5 ?? null, ga5: hf?.ga5 ?? null },
          away: { id: m.awayTeam.id, name: m.awayTeam.name, logo: m.awayTeam.crest || cachedLogo(m.awayTeam.name) || null, form: af?.form || null, gf5: af?.gf5 ?? null, ga5: af?.ga5 ?? null },
          odds: odds ? [odds] : [],
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
   PERSISTENT SNAPSHOT STORE (history of every day)
   ───────────────────────────────────────────────────────────
   Every match is saved BEFORE kickoff with the exact inputs the
   model used (odds, form, xG). After kickoff those inputs are
   frozen and only status/score are updated, so the bot's pick
   for a past match never changes and past days stay in the chart.
   Set HISTORY_FILE to a path on a persistent disk/volume.
   ═══════════════════════════════════════════════════════════ */
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(__dirname, 'data', 'history.json');
const HISTORY_KEEP_DAYS = 60;
const RESULTS_REFRESH_TTL = 5 * 60 * 1000;
const snapshotStore = new Map();
let saveTimer = null;
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

function saveSnapshotsSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      const cutoff = dateDaysAgo(HISTORY_KEEP_DAYS);
      for (const [id, f] of snapshotStore) if (f.date < cutoff) snapshotStore.delete(id);
      const tmp = HISTORY_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...snapshotStore.values()]));
      fs.renameSync(tmp, HISTORY_FILE);
    } catch (e) { console.error('History save error:', e.message); }
  }, 2000);
}

function recordSnapshots(fixtures) {
  let changed = false;
  for (const f of fixtures) {
    if (!f || !f.id || !f.home || !f.away) continue;
    const prev = snapshotStore.get(f.id);

    if (!prev) {
      // Only keep matches we saw BEFORE kickoff: that way the pick is a real prediction.
      if (f.status !== 'notstarted') continue;
      snapshotStore.set(f.id, Object.assign(JSON.parse(JSON.stringify(f)), { openOdds: JSON.parse(JSON.stringify(f.odds || [])) }));
      changed = true;
      continue;
    }

    if (prev.status === 'notstarted' && f.status === 'notstarted') {
      // Still before kickoff: keep the latest odds/form (= closing odds once the match starts); openOdds stays frozen.
      const open = prev.openOdds || JSON.parse(JSON.stringify(prev.odds || []));
      snapshotStore.set(f.id, Object.assign(JSON.parse(JSON.stringify(f)), { openOdds: open }));
      changed = true;
      continue;
    }

    // After kickoff: inputs stay frozen, only status / score / logos move.
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

// Matches that end after midnight UTC leave the "today" feed: settle them from Bzzoiro.
async function refreshHistoryResults() {
  if (!BZZOIRO_API_KEY) return;
  if (Date.now() - historyCache.ts < RESULTS_REFRESH_TTL) return;
  if (!bzzBudgetOk()) return;
  if (resultsRefreshInProgress) return resultsRefreshInProgress;

  // Only matches whose kickoff has already passed can have a result to settle.
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
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const sess = sessions.get(token);
  if (!sess || Date.now() - sess.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }
  req.authToken = token;
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
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.set('trust proxy', 1);
const loginAttempts = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of loginAttempts) if (n - v.t > 10 * 60 * 1000) loginAttempts.delete(k); }, 10 * 60 * 1000).unref();
function loginLimiter(req, res, next) {
  const ip = req.ip || 'unknown', now = Date.now();
  const e = loginAttempts.get(ip) || { n: 0, t: now };
  if (now - e.t > 10 * 60 * 1000) { e.n = 0; e.t = now; }
  if (e.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  e.n++; loginAttempts.set(ip, e);
  next();
}

/* ═══════════════════════════════════════════════════════════
   EMAIL ACCOUNTS  (free by default; "pro" is granted by the owner after payment)
   Stored in USERS_FILE (put it on a persistent disk, like HISTORY_FILE).
   ═══════════════════════════════════════════════════════════ */
const USERS_FILE = process.env.USERS_FILE || path.join(path.dirname(HISTORY_FILE), 'users.json');
const users = new Map(); // email -> { email, salt, hash, plan, planUntil, createdAt, seq }
let usersTimer = null;
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const u of arr) if (u && u.email && u.salt && u.hash) users.set(u.email, u);
    console.log(`👤 Loaded ${users.size} accounts`);
  } catch (e) { console.error('Users load error:', e.message); }
}
function saveUsersSoon() {
  if (usersTimer) return;
  usersTimer = setTimeout(() => {
    usersTimer = null;
    try {
      fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
      const tmp = USERS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...users.values()]), { mode: 0o600 });
      fs.renameSync(tmp, USERS_FILE);
    } catch (e) { console.error('Users save error:', e.message); }
  }, 1000);
}
loadUsers();
const TERMS_VERSION = '2026-11-01';
const scryptAsync = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? no(e) : ok(k))));
const DUMMY_SALT = crypto.randomBytes(16);

/* ═══════════════════════════════════════════════════════════
   EMAIL OTP  (6-digit code sent by email before a login session starts)
   Needs RESEND_API_KEY (https://resend.com) + MAIL_FROM on a verified domain.
   Without RESEND_API_KEY the OTP step is skipped (a warning is logged at startup).
   ═══════════════════════════════════════════════════════════ */
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'LuciBet <onboarding@resend.dev>';
const OTP_ENABLED = !!RESEND_API_KEY;
if (!OTP_ENABLED) console.error('⚠️ RESEND_API_KEY is not set: email OTP is OFF, so email logins skip the code check.');
const OTP_TTL = 10 * 60 * 1000, OTP_RESEND_GAP = 45 * 1000, OTP_MAX_TRIES = 5, OTP_MAX_SENDS_PER_HOUR = 6;
const OTP_SECRET = crypto.randomBytes(32);
const otps = new Map();      // email -> { hash, exp, tries, sentAt }
const otpSends = new Map();  // email -> { n, t }  (sends per hour)
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

// Creates and emails a fresh code. If a still-valid code was sent less than 45s ago it is kept (reused: true).
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
      `Your LuciBet verification code is ${code}. It expires in 10 minutes. If you did not request it, you can ignore this email. This is a one-time security message about your LuciBet account, not marketing; we do not send newsletters.`,
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
  if (sess.kind === 'keyauth') return 'pro';
  const u = users.get(sess.username);
  return u && u.plan === 'pro' && (!u.planUntil || u.planUntil > Date.now()) ? 'pro' : 'free';
}
function profileOf(sess) {
  const u = sess.kind === 'keyauth' ? null : users.get(sess.username);
  return {
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
  sessions.set(token, { ...sess, createdAt: Date.now() });
  const mine = [...sessions.entries()].filter(([, v]) => v.username === sess.username).sort((a, b) => b[1].createdAt - a[1].createdAt);
  for (const [k] of mine.slice(MAX_SESSIONS_PER_USER)) sessions.delete(k);
  res.json({ token, username: sess.username, expiresIn: SESSION_TTL, profile: profileOf(sessions.get(token)) });
}
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

async function localLogin(res, email, password, uKey) {
  const u = users.get(email);
  let ok = false;
  try {
    const dk = await scryptAsync(password, u ? Buffer.from(u.salt, 'hex') : DUMMY_SALT);
    ok = !!u && crypto.timingSafeEqual(dk, Buffer.from(u.hash, 'hex'));
  } catch (e) { ok = false; }
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

app.post('/api/auth/register', loginLimiter, async (req, res) => {
  const body = req.body || {};
  const email = String(body.email || body.username || '').trim().toLowerCase();
  const password = body.password;
  // Legal: explicit 18+ confirmation and acceptance of Terms/Privacy (never pre-ticked, enforced server-side too).
  if (body.consent !== true || body.ageConfirmed !== true) return res.status(400).json({ error: 'You must confirm you are 18 or older and accept the Terms and Privacy Policy.' });
  if (!EMAIL_RE.test(email) || email.length > 120) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8 to 128 characters.' });
  if (users.size >= 50000) return res.status(503).json({ error: 'Registration is temporarily closed.' });
  const taken = u => u && u.verified !== false; // an unverified signup never proved it owns the email, so it can be re-claimed
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
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
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

// Owner-only: grant/revoke the Pro plan after a payment (needs ADMIN_TOKEN env var).
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
   LICENSE KEYS  (owner generates keys, the customer redeems them to activate Pro on their own account)
   Only SHA-256 hashes are stored; the plain key is shown once, when generated.
   Stored in LICENSES_FILE (persistent disk, like USERS_FILE).
   ═══════════════════════════════════════════════════════════ */
const LICENSES_FILE = process.env.LICENSES_FILE || path.join(path.dirname(HISTORY_FILE), 'licenses.json');
const licenses = new Map(); // sha256(key) -> { hash, days, createdAt, note, usedBy, usedAt }
let licensesTimer = null;
try {
  if (fs.existsSync(LICENSES_FILE)) {
    const arr = JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const l of arr) if (l && l.hash) licenses.set(l.hash, l);
    console.log(`🔑 Loaded ${licenses.size} licenses`);
  }
} catch (e) { console.error('Licenses load error:', e.message); }
function saveLicensesSoon() {
  if (licensesTimer) return;
  licensesTimer = setTimeout(() => {
    licensesTimer = null;
    try {
      fs.mkdirSync(path.dirname(LICENSES_FILE), { recursive: true });
      const tmp = LICENSES_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...licenses.values()]), { mode: 0o600 });
      fs.renameSync(tmp, LICENSES_FILE);
    } catch (e) { console.error('Licenses save error:', e.message); }
  }, 500);
}
const licHash = key => crypto.createHash('sha256').update(String(key).toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
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

// Owner-only: generate license keys.  POST {days:30, count:5, note:"..."}  (days 0 = lifetime)
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

// Customer: redeem a license key on the logged-in email account.
// Keys come from KeyAuth (validated live, bound to ONE email account here) or from /api/admin/license.
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
  let until = null;          // absolute end of the plan (ms); null = lifetime
  let extendDays = null;     // owner-generated keys add days on top of the current plan
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
    const cur = licenses.get(h); // re-check after the await: another request may have bound it meanwhile
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

// Per-username lockout (the per-IP limiter alone can be dodged by rotating IPs).
const userFails = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of userFails) if (n - v.t > 10 * 60 * 1000) userFails.delete(k); }, 10 * 60 * 1000).unref();

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
  res.json({ ok: true });
});

// Right to erasure: the user deletes their own account and everything we hold about it.
app.delete('/api/account', loginLimiter, authMiddleware, async (req, res) => {
  const sess = sessions.get(req.authToken);
  if (!sess || sess.kind !== 'local') return res.status(400).json({ error: 'This login is managed through Telegram support. Message us there and we will delete it.' });
  const email = sess.username;
  const u = users.get(email);
  if (!u) return res.status(404).json({ error: 'Account not found' });
  const password = (req.body || {}).password;
  if (typeof password !== 'string' || password.length > 200) return res.status(400).json({ error: 'Password required' });
  const uKey = email.toLowerCase();
  const uf = userFails.get(uKey);
  if (uf && uf.n >= 8 && Date.now() - uf.t < 10 * 60 * 1000) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  let ok = false;
  try { ok = crypto.timingSafeEqual(await scryptAsync(password, Buffer.from(u.salt, 'hex')), Buffer.from(u.hash, 'hex')); } catch (e) { ok = false; }
  if (!ok) { const f = userFails.get(uKey) || { n: 0, t: Date.now() }; f.n++; f.t = Date.now(); userFails.set(uKey, f); return res.status(401).json({ error: 'Wrong password' }); }
  users.delete(email);
  for (const [k, v] of sessions) if (v.username === email) sessions.delete(k);
  for (const l of licenses.values()) if (l.usedBy === email) l.usedBy = 'deleted-account'; // keep the hash so a used key cannot be reused, drop the email
  otps.delete(email); otpSends.delete(email); userFails.delete(uKey); userFails.delete('lic:' + email);
  saveUsersSoon(); saveLicensesSoon();
  res.json({ ok: true });
});

// Public preview for the landing page: matches only. No odds, forms, xG or predictions leave the server here.
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

// Live presence for the landing-page globe: approximate, city-level points only (see presence.js).
const presence = require('./presence')({
  lookup: (() => { try { return require('geoip-lite').lookup; } catch (e) { return null; } })(),
  trustCfGeo: process.env.TRUST_CF_GEO === '1'
});
app.post('/api/presence', presence.ping);
app.get('/api/presence', presence.snapshot);

// Team forms (last-5 goals) are the only real xG input the engine accepts. They used to be fetched AFTER the response was sent,
// so the first responses had no forms, the engine saw source=market and the gate hid every value bet.
// Now we wait (bounded) for the forms before answering; later requests hit formCache and return instantly.
const FORMS_WAIT_MS = Math.max(0, parseInt(process.env.FORMS_WAIT_MS, 10) || 8000);
// Engine data-safety threshold. Default 2 (unchanged). The odds feed currently gives ONE bookmaker per match, so 2 blocks every bet:
// set ENGINE_MIN_BOOKS=1 on the host to allow single-bookmaker odds (knowingly less reliable market consensus).
const ENGINE_MIN_BOOKS = Number.isFinite(parseInt(process.env.ENGINE_MIN_BOOKS, 10)) ? Math.max(1, parseInt(process.env.ENGINE_MIN_BOOKS, 10)) : 2;
async function getFixturesWithForms() {
  let fixtures = await getFixtures();
  const teams = fixtures.filter(f => f.status === 'notstarted').flatMap(f => [f.home, f.away]).filter(t => t.id);
  if (!teams.length) return fixtures;
  const pending = ensureForms(teams);
  if (pending) {
    let timer;
    await Promise.race([pending.catch(() => {}), new Promise(r => { timer = setTimeout(r, FORMS_WAIT_MS); })]);
    clearTimeout(timer);
    fixtures = await getFixtures(); // ensureForms clears fixturesCache when done, so this rebuilds fixtures with the forms
  }
  return fixtures;
}

app.get('/api/fixtures', authMiddleware, requirePro, async (req, res) => {
  try {
    const fixtures = await getFixturesWithForms();
    // Form data is only useful before kickoff (snapshots are frozen afterwards).
    const teams = fixtures.filter(f => f.status === 'notstarted').flatMap(f => [f.home, f.away]).filter(t => t.id);
    res.json({ fixtures });
    if (teams.length && !prefetchInProgress) ensureForms(teams).catch(e => console.error(e.message));
    const logoP = ensureLogos(fixtures.flatMap(f => [f.home, f.away]));
    if (logoP) logoP.catch(e => console.error('Logo fetch error:', e.message));
  } catch (e) { res.status(500).json({ error: 'Server error', fixtures: [] }); }
});

// Independent engine output (additive: the legacy browser model keeps working). Pro only.
const enginePre = require('./engine/prematch'), engineDecide = require('./engine/decision'), engineValidate = require('./engine/validate');
app.get('/api/engine/predictions', authMiddleware, requirePro, async (req, res) => {
  try {
    const fixtures = await getFixturesWithForms();
    const out = fixtures.map(f => {
      const pred = enginePre.predict(f, { marketWeight: 0.5 });
      const decision = engineDecide.decide(f, pred, { minBooks: ENGINE_MIN_BOOKS });
      return { id: f.id, safety: (decision.safety || []), xgSource: f.xgSource || null, prediction: pred && { p: pred.p, over: pred.over, top: pred.top, source: pred.source }, validation: engineValidate.validate(pred, f), decision };
    });
    res.json({ predictions: out });
  } catch (e) { res.status(500).json({ error: 'Server error', predictions: [] }); }
});

// History = saved snapshots (pre-match odds/form frozen) + final scores.
app.get('/api/history', async (req, res) => {
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

// Background tick: keeps saving matches (and their results) even when nobody has the site open.
async function backgroundTick() {
  try {
    const fixtures = await getFixtures();
    if (API_KEY && !prefetchInProgress) {
      const teams = fixtures.filter(f => f.status === 'notstarted').flatMap(f => [f.home, f.away]).filter(t => t.id);
      if (teams.length) ensureForms(teams).catch(e => console.error(e.message));
    }
    await refreshHistoryResults();
  } catch (e) { console.error('Background tick error:', e.message); }
}
setTimeout(backgroundTick, 10 * 1000);
setInterval(backgroundTick, 3 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
