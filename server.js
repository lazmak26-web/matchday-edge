const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

const BZZOIRO_API_KEY = process.env.BZZOIRO_API_KEY;
const BZZOIRO_API_BASE = 'https://sports.bzzoiro.com/api';

/* ═══════════════════════════════════════════════════════════
   KEYAUTH CONFIG
   ═══════════════════════════════════════════════════════════ */
const KEYAUTH_NAME    = process.env.KEYAUTH_NAME    || "Lazmak26's Application";
const KEYAUTH_OWNERID = process.env.KEYAUTH_OWNERID || "pHNY47TKT0";
const KEYAUTH_SECRET  = process.env.KEYAUTH_SECRET  || "224780ffea2a6df27e3cb18c7332e0356adfee48c2cd1662004332919376fac0";
const KEYAUTH_VERSION = process.env.KEYAUTH_VERSION || "1.0";
const KEYAUTH_BASE    = 'https://keyauth.win/api/1.3/';

const SESSION_TTL = 24 * 60 * 60 * 1000;
const sessions = new Map();

/* ═══════════════════════════════════════════════════════════
   CACHE & CONCURRENCY
   ═══════════════════════════════════════════════════════════ */
const FORM_TTL = 60 * 60 * 1000;
const FIXTURES_TTL = 20 * 1000;
const EVENTS_TTL = 30 * 1000;
const ODDS_TTL = 60 * 1000;
const HISTORY_TTL = 12 * 60 * 60 * 1000;

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
  const r = await fetch(`${API_BASE}${endpoint}`, { headers: { 'X-Auth-Token': API_KEY || '' } });
  if (!r.ok) throw new Error(`API ${endpoint} → ${r.status}`);
  return r.json();
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
      const existing = formCache.get(team.id);
      if (existing && Date.now() - existing.ts < FORM_TTL) continue;
      const form = await fetchTeamForm(team.id);
      if (form) formCache.set(team.id, { data: form, ts: Date.now() });
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
    try { await prefetchForms(needed); fixturesCache.data = null; }
    catch (e) { console.error(e.message); }
    finally { prefetchInProgress = null; }
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
    logoFetchInProgress = null;
  })();
  
  return logoFetchInProgress;
}

function todayStr() {
  const d = new Date(); const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function fetchBzzoiroEvents() {
  if (!BZZOIRO_API_KEY) return [];
  if (eventsCache.data && Date.now() - eventsCache.ts < EVENTS_TTL) return eventsCache.data;
  if (eventsFetchInProgress) return eventsFetchInProgress;
  eventsFetchInProgress = (async () => {
    try {
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
        eventsCache.ts = Date.now() - EVENTS_TTL + 10 * 1000;
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
      const queue = [...valid];
      const workers = Array.from({ length: ODDS_CONCURRENCY }, async () => {
        while (queue.length) {
          const ev = queue.shift();
          const parsed = parseBzzoiroOdds(await fetchEventOdds(ev.id));
          if (parsed) oddsMap.set(normalizeTeamKey(ev.home_team, ev.away_team), parsed);
          await new Promise(r => setTimeout(r, ODDS_DELAY));
        }
      });
      await Promise.all(workers);
    } catch (e) { console.error(e.message); }
    oddsCache.data = oddsMap; oddsCache.ts = Date.now(); fixturesCache.data = null;
    oddsFetchInProgress = null; return oddsMap;
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
      const fdP = API_KEY
        ? apiGet(`/matches?date=${todayStr()}`).then(d => d.matches || []).catch(() => [])
        : Promise.resolve([]);

      let oddsMap = oddsCache.data;
      if (!oddsMap) oddsMap = await fetchOdds().catch(() => new Map());
      else if (Date.now() - oddsCache.ts > ODDS_TTL) fetchOdds().catch(() => {});

      const [bzzEvents, fdMatches] = await Promise.all([eventsP, fdP]);
      const fixtures = [], usedFdIds = new Set();

      for (const ev of bzzEvents) {
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
        const status = fdS ? pickBetterStatus(bzzS, fdS) : bzzS;

        let homeScore, awayScore;
        if (fdMatch && (fdS === 'started' || fdS === 'finished')) {
          homeScore = fdMatch.score?.fullTime?.home ?? 0;
          awayScore = fdMatch.score?.fullTime?.away ?? 0;
        } else {
          homeScore = ev.home_score ?? 0;
          awayScore = ev.away_score ?? 0;
        }

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
        estimateXGForFixture(fixture);
        fixtures.push(fixture);
      }

      const deduped = dedupeFixtures(fixtures);
      fixturesCache.data = deduped; fixturesCache.ts = Date.now();
      return deduped;
    } finally { fixturesFetchInProgress = null; }
  })();
  return fixturesFetchInProgress;
}

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

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/login', async (req, res) => {
  const { username, password, hwid } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const init = await keyauthInit();
    if (!init.success) throw new Error(init.message || 'Init failed');
    const sessionid = init.sessionid;
    
    const login = await keyauthLogin(username, password, sessionid, hwid);
    if (!login.success) throw new Error(login.message || 'Invalid username or password');
    
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { keyauthSessionId: sessionid, username, createdAt: Date.now() });
    res.json({ token, username, expiresIn: SESSION_TTL });
  } catch (e) { res.status(401).json({ error: e.message }); }
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ ok: true, username: sessions.get(req.authToken).username });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  sessions.delete(req.authToken);
  res.json({ ok: true });
});

app.get('/api/fixtures', authMiddleware, async (req, res) => {
  try {
    const fixtures = await getFixtures();
    const teams = fixtures.flatMap(f => [f.home, f.away]).filter(t => t.id);
    res.json({ fixtures });
    if (teams.length && !prefetchInProgress) ensureForms(teams).catch(e => console.error(e.message));
    ensureLogos(fixtures.flatMap(f => [f.home, f.away]));
  } catch (e) { res.status(500).json({ error: e.message, fixtures: [] }); }
});

// حيدنا authMiddleware من هنا باش الشارت يخدم فـ الـ Landing Page
app.get('/api/history', async (req, res) => {
  if (historyCache.data && Date.now() - historyCache.ts < HISTORY_TTL) {
    return res.json({ fixtures: historyCache.data });
  }
  const past = new Date(); past.setDate(past.getDate() - 30);
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateFrom = `${past.getUTCFullYear()}-${pad(past.getUTCMonth() + 1)}-${pad(past.getUTCDate())}`;
  const dateTo = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`;

  try {
    const r = await fetch(`${BZZOIRO_API_BASE}/v2/events/?date_from=${dateFrom}&date_to=${dateTo}`, {
      headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('History fetch failed');
    const data = await r.json();
    const events = (data.results || data.data || []).filter(ev => ev.status === 'finished' || ev.status === 'FT');
    
    const fixtures = events.map(ev => {
       const kickoff = new Date(ev.event_date);
       const fixture = {
          id: `bzz_${ev.id}`,
          league: ev.league_id ? `League #${ev.league_id}` : 'Football',
          date: kickoff.toISOString().slice(0, 10),
          kickoff: kickoff.toISOString().slice(11, 16),
          status: 'finished',
          homeScore: ev.home_score ?? 0,
          awayScore: ev.away_score ?? 0,
          home: { name: ev.home_team, form: null, gf5: null, ga5: null },
          away: { name: ev.away_team, form: null, gf5: null, ga5: null },
          odds: [] 
       };
       estimateXGForFixture(fixture);
       return fixture;
    });
    historyCache.data = fixtures;
    historyCache.ts = Date.now();
    res.json({ fixtures });
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
});

app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
