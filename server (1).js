const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

const BZZOIRO_API_KEY = process.env.BZZOIRO_API_KEY;
const BZZOIRO_API_BASE = 'https://sports.bzzoiro.com/api';

/* ═══════════════════════════════════════════════════════════
   CACHE & CONCURRENCY
   ═══════════════════════════════════════════════════════════ */
const FORM_TTL = 60 * 60 * 1000;
const FORM_FAIL_TTL = 10 * 60 * 1000;      // ila form fshel, ma n3awdouch nhitou 3la API kol request
const FORM_DELAY = 7000;                   // football-data free = 10 req/min → 1 request kol 7s
const FIXTURES_TTL = 2 * 60 * 1000;        // normal
const FIXTURES_LIVE_TTL = 30 * 1000;       // ila kayn match live / 7ssen ybda
const EVENTS_TTL = 15 * 60 * 1000;         // normal
const EVENTS_LIVE_TTL = 60 * 1000;         // ila kayn match live
const ODDS_TTL = 15 * 60 * 1000;
const ODDS_CONCURRENCY = 3;
const ODDS_DELAY = 150;
const FETCH_TIMEOUT = 10 * 1000;

const LIVE_WINDOW_MIN = 150;   // match li "notstarted" w douz 3la kickoff dyalo 150 d9i9a = kayn live
const STALE_LIVE_MIN = 210;    // ila source galk live w douzat 210 d9i9a = ghalib sala

const formCache = new Map();
const fixturesCache = { data: null, ts: 0, day: null };
const eventsCache = { data: null, ts: 0, day: null };
const oddsCache = { data: null, ts: 0 };
let prefetchInProgress = null;
let oddsFetchInProgress = null;
let fixturesFetchInProgress = null;
let eventsFetchInProgress = null;
let fdBlockedUntil = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, options = {}, timeoutMs = FETCH_TIMEOUT) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status} ${url}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
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

function cleanTeamName(s) {
  const t = String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return TEAM_ALIASES[t] || t;
}

function normalizeTeamKey(home, away) {
  return `${cleanTeamName(home)}|${cleanTeamName(away)}`;
}

function teamsFuzzyMatch(a, b) {
  if (!a || !b) return false;
  const clean = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(fc|ac|as|us|ss|cf|sc|afc|cd|club|calcio|sporting|sport|city|united|town|the|de|la|le|1907)\b/g, ' ').replace(/[^a-z0-9]/g, '').trim();
  const ca = clean(a), cb = clean(b);
  if (!ca || !cb) return false;
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

/* ═══════════════════════════════════════════════════════════
   DATES & STATUS
   ═══════════════════════════════════════════════════════════ */
function dayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const todayStr = () => dayStr(0);

// Kheli ghir matchat dyal lyoum + matchat li bdaw lbare7 w mazalin live (ex: 23:00 UTC)
function inWindow(kickoffTs, srcState, now = Date.now()) {
  if (new Date(kickoffTs).toISOString().slice(0, 10) === todayStr()) return true;
  const elapsedMin = (now - kickoffTs) / 60000;
  return srcState !== 'finished' && elapsedMin >= 0 && elapsedMin < STALE_LIVE_MIN;
}

// Kat7awl ay status men ay API l 4 7alat: notstarted | live | finished | canceled | postponed | unknown
function normalizeStatus(raw) {
  const s = String(raw || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return 'notstarted';
  if (/^(canceled|cancelled)$/.test(s)) return 'canceled';
  if (/^(postponed|abandoned)$/.test(s)) return 'postponed';
  if (/(finish|ended|full_time|^ft$|awarded|after_)/.test(s)) return 'finished';
  if (/(live|play|progress|half|^ht$|^[12]h$|extra|penalt|paused|break|suspend)/.test(s)) return 'live';
  if (/(not_?started|schedul|timed|upcoming|^ns$|tbd)/.test(s)) return 'notstarted';
  return 'unknown';
}

function estimateMinute(elapsedMin) {
  if (elapsedMin < 0) return null;
  if (elapsedMin <= 45) return `${Math.max(elapsedMin, 1)}'`;
  if (elapsedMin <= 60) return 'HT';
  const m = elapsedMin - 15;
  return m > 90 ? "90+'" : `${m}'`;
}

// Kat7seb status l7a9i9i f wa9t response (machi f wa9t cache), bach "Started" tban fo9ha
function decorateFixture(f, now = Date.now()) {
  const elapsedMin = Math.floor((now - f.kickoffTs) / 60000);
  let status = f.srcState === 'unknown' ? 'notstarted' : f.srcState;
  let inferred = false;

  if (status !== 'finished' && elapsedMin >= 0) {
    if (f.srcState === 'notstarted' || f.srcState === 'unknown') {
      status = elapsedMin < LIVE_WINDOW_MIN ? 'live' : 'finished';
      inferred = true;
    } else if (status === 'live' && elapsedMin > STALE_LIVE_MIN) {
      status = 'finished';
      inferred = true;
    }
  }

  const started = status !== 'notstarted';
  const minute = status === 'live' ? (f.srcMinute ? `${f.srcMinute}'` : estimateMinute(elapsedMin)) : null;

  return {
    ...f,
    status,
    started,
    isLive: status === 'live',
    statusInferred: inferred,
    statusLabel: status === 'live' ? 'Started' : (status === 'finished' ? 'Finished' : null),
    minute
  };
}

const STATUS_ORDER = { live: 0, notstarted: 1, finished: 2 };

/* ═══════════════════════════════════════════════════════════
   APIs & DATA FETCHING
   ═══════════════════════════════════════════════════════════ */
async function apiGet(endpoint) {
  return fetchJson(`${API_BASE}${endpoint}`, { headers: { 'X-Auth-Token': API_KEY || '' } });
}

async function fetchTeamForm(teamId) {
  // Mohim: ma kankhdmouch b limit=5 7it API kat3ti l9dam matchat dyal lmosim, kanjibou kolchi w nakhdou akhir 5
  const data = await apiGet(`/teams/${teamId}/matches?status=FINISHED`);
  const matches = (data.matches || [])
    .filter(m => m.score?.fullTime?.home != null && m.score?.fullTime?.away != null)
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .slice(-5);
  if (!matches.length) return { form: null, gf5: null, ga5: null };
  let form = '', gf5 = 0, ga5 = 0;
  for (const m of matches) {
    const isHome = m.homeTeam.id === teamId;
    const scored = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const conceded = isHome ? m.score.fullTime.away : m.score.fullTime.home;
    gf5 += scored; ga5 += conceded;
    form += scored > conceded ? 'W' : (scored === conceded ? 'D' : 'L');
  }
  return { form, gf5, ga5 };
}

function formIsFresh(entry) {
  return entry && Date.now() - entry.ts < (entry.failed ? FORM_FAIL_TTL : FORM_TTL);
}

async function prefetchForms(teams) {
  const queue = [...new Map(teams.map(t => [t.id, t])).values()];
  while (queue.length) {
    if (Date.now() < fdBlockedUntil) break;
    const team = queue.shift();
    if (formIsFresh(formCache.get(team.id))) continue;
    try {
      const form = await fetchTeamForm(team.id);
      formCache.set(team.id, { data: form, ts: Date.now() });
    } catch (e) {
      if (e.status === 429) { fdBlockedUntil = Date.now() + 65 * 1000; break; }
      formCache.set(team.id, { data: null, ts: Date.now(), failed: true });
    }
    await sleep(FORM_DELAY);
  }
}

function ensureForms(teams) {
  const needed = teams.filter(t => t && t.id && !formIsFresh(formCache.get(t.id)));
  if (!needed.length || Date.now() < fdBlockedUntil) return prefetchInProgress;
  if (prefetchInProgress) return prefetchInProgress;
  prefetchInProgress = (async () => {
    try { await prefetchForms(needed); fixturesCache.data = null; }
    catch (e) { console.error('prefetchForms:', e.message); }
    finally { prefetchInProgress = null; }
  })();
  return prefetchInProgress;
}

function eventsHaveActive(events) {
  const now = Date.now();
  return (events || []).some(ev => {
    const ts = new Date(ev.event_date).getTime();
    if (isNaN(ts)) return false;
    const st = normalizeStatus(ev.status);
    if (st === 'finished' || st === 'canceled' || st === 'postponed') return false;
    return ts - now < 15 * 60000 && now - ts < STALE_LIVE_MIN * 60000;
  });
}

async function fetchBzzoiroEvents() {
  if (!BZZOIRO_API_KEY) return [];
  if (eventsCache.data && eventsCache.day === todayStr()) {
    const ttl = eventsHaveActive(eventsCache.data) ? EVENTS_LIVE_TTL : EVENTS_TTL;
    if (Date.now() - eventsCache.ts < ttl) return eventsCache.data;
  }
  if (eventsFetchInProgress) return eventsFetchInProgress;
  eventsFetchInProgress = (async () => {
    try {
      // lbare7 + lyoum: bach matchat li bdaw qbel 00:00 UTC ma ytl3ouch mn lpage
      let url = `${BZZOIRO_API_BASE}/v2/events/?date_from=${dayStr(-1)}&date_to=${todayStr()}`;
      const events = [];
      for (let page = 0; url && page < 5; page++) {
        const data = await fetchJson(url, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' } });
        events.push(...(data.results || data.data || []));
        url = typeof data.next === 'string' && data.next.startsWith('http') ? data.next : null;
      }
      eventsCache.data = events; eventsCache.ts = Date.now(); eventsCache.day = todayStr();
      return events;
    } catch (e) {
      console.error('fetchBzzoiroEvents:', e.message);
      return eventsCache.data || [];
    } finally { eventsFetchInProgress = null; }
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
    const data = await fetchJson(`${BZZOIRO_API_BASE}/v2/events/${eventId}/odds/`, { headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}` } });
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
      // ma kanjibou odds l matchat salaw/mlghyin
      const valid = events.filter(ev => {
        if (!ev.home_team || !ev.away_team) return false;
        const st = normalizeStatus(ev.status);
        return st !== 'finished' && st !== 'canceled' && st !== 'postponed';
      });
      const queue = [...valid];
      const workers = Array.from({ length: ODDS_CONCURRENCY }, async () => {
        while (queue.length) {
          const ev = queue.shift();
          const parsed = parseBzzoiroOdds(await fetchEventOdds(ev.id));
          if (parsed) oddsMap.set(normalizeTeamKey(ev.home_team, ev.away_team), parsed);
          await sleep(ODDS_DELAY);
        }
      });
      await Promise.all(workers);
      oddsCache.data = oddsMap; oddsCache.ts = Date.now(); fixturesCache.data = null;
    } catch (e) { console.error('fetchOdds:', e.message); }
    finally { oddsFetchInProgress = null; }
    return oddsMap;
  })();
  return oddsFetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   ESTIMATE XG & MERGE FIXTURES
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
  const seen = new Set(), result = [];
  for (const f of fixtures) {
    const key = `${f.date}|${f.kickoff}|${cleanTeamName(f.home.name)}|${cleanTeamName(f.away.name)}`;
    if (!seen.has(key)) { seen.add(key); result.push(f); }
  }
  return result;
}

function fixturesCacheTtl() {
  const active = (fixturesCache.data || []).some(f => {
    if (f.srcState === 'finished') return false;
    const now = Date.now();
    return f.kickoffTs - now < 15 * 60000 && now - f.kickoffTs < STALE_LIVE_MIN * 60000;
  });
  return active ? FIXTURES_LIVE_TTL : FIXTURES_TTL;
}

async function getFixtures() {
  if (fixturesCache.data && fixturesCache.day === todayStr() && Date.now() - fixturesCache.ts < fixturesCacheTtl()) {
    return fixturesCache.data;
  }
  if (fixturesFetchInProgress) return fixturesFetchInProgress;

  fixturesFetchInProgress = (async () => {
    try {
      const [bzzEvents, fdMatches, oddsMap] = await Promise.all([
        fetchBzzoiroEvents().catch(() => []),
        API_KEY
          ? apiGet(`/matches?dateFrom=${dayStr(-1)}&dateTo=${dayStr(1)}`).then(d => d.matches || []).catch(e => { console.error('fd matches:', e.message); return []; })
          : Promise.resolve([]),
        fetchOdds().catch(() => new Map())
      ]);

      const now = Date.now();
      const fixtures = [], usedFdIds = new Set();

      for (const ev of bzzEvents) {
        const srcState = normalizeStatus(ev.status);
        if (srcState === 'canceled' || srcState === 'postponed') continue;
        const kickoff = new Date(ev.event_date);
        if (isNaN(kickoff.getTime())) continue;
        const kickoffTs = kickoff.getTime();
        if (!inWindow(kickoffTs, srcState, now)) continue;

        let fdMatch = null;
        for (const m of fdMatches) {
          if (usedFdIds.has(m.id)) continue;
          if (teamsFuzzyMatch(ev.home_team, m.homeTeam.name) && teamsFuzzyMatch(ev.away_team, m.awayTeam.name)) {
            fdMatch = m; usedFdIds.add(m.id); break;
          }
        }

        const hf = fdMatch ? formCache.get(fdMatch.homeTeam.id)?.data : null;
        const af = fdMatch ? formCache.get(fdMatch.awayTeam.id)?.data : null;
        const odds = oddsMap.get(normalizeTeamKey(ev.home_team, ev.away_team));

        const fixture = {
          id: `bzz_${ev.id}`,
          league: fdMatch?.competition?.name || ev.league_name || ev.league?.name || (ev.league_id ? `League #${ev.league_id}` : 'Football'),
          date: kickoff.toISOString().slice(0, 10),
          kickoff: kickoff.toISOString().slice(11, 16),
          kickoffTs,
          srcState,
          srcMinute: ev.current_minute ?? ev.minute ?? ev.elapsed ?? null,
          homeScore: ev.home_score ?? 0,
          awayScore: ev.away_score ?? 0,
          home: { id: fdMatch?.homeTeam.id || null, name: ev.home_team, form: hf?.form || null, gf5: hf?.gf5 ?? null, ga5: hf?.ga5 ?? null },
          away: { id: fdMatch?.awayTeam.id || null, name: ev.away_team, form: af?.form || null, gf5: af?.gf5 ?? null, ga5: af?.ga5 ?? null },
          odds: odds ? [odds] : [],
          h2h: ev.head_to_head || null,
          sources: fdMatch ? ['bzz', 'fd'] : ['bzz']
        };
        estimateXGForFixture(fixture);
        fixtures.push(fixture);
      }

      for (const m of fdMatches) {
        if (usedFdIds.has(m.id)) continue;
        const srcState = normalizeStatus(m.status);   // IN_PLAY, PAUSED, EXTRA_TIME... kolhom kayrj3o 'live'
        if (srcState === 'canceled' || srcState === 'postponed') continue;
        const kickoff = new Date(m.utcDate);
        if (isNaN(kickoff.getTime())) continue;
        const kickoffTs = kickoff.getTime();
        if (!inWindow(kickoffTs, srcState, now)) continue;

        const hf = formCache.get(m.homeTeam.id)?.data, af = formCache.get(m.awayTeam.id)?.data;
        const odds = oddsMap.get(normalizeTeamKey(m.homeTeam.name, m.awayTeam.name));

        const fixture = {
          id: String(m.id),
          league: m.competition?.name || 'N/A',
          date: kickoff.toISOString().slice(0, 10),
          kickoff: kickoff.toISOString().slice(11, 16),
          kickoffTs,
          srcState,
          srcMinute: m.minute ?? null,
          homeScore: m.score?.fullTime?.home ?? 0,
          awayScore: m.score?.fullTime?.away ?? 0,
          home: { id: m.homeTeam.id, name: m.homeTeam.name, form: hf?.form || null, gf5: hf?.gf5 ?? null, ga5: hf?.ga5 ?? null },
          away: { id: m.awayTeam.id, name: m.awayTeam.name, form: af?.form || null, gf5: af?.gf5 ?? null, ga5: af?.ga5 ?? null },
          odds: odds ? [odds] : [],
          sources: odds ? ['fd', 'bzz'] : ['fd']
        };
        estimateXGForFixture(fixture);
        fixtures.push(fixture);
      }

      const deduped = dedupeFixtures(fixtures);
      fixturesCache.data = deduped; fixturesCache.ts = Date.now(); fixturesCache.day = todayStr();
      return deduped;
    } finally { fixturesFetchInProgress = null; }
  })();
  return fixturesFetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════ */
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/fixtures            → kolchi (live 1st, men b3d upcoming, men b3d finished)
// GET /api/fixtures?status=live|upcoming|finished
app.get('/api/fixtures', async (req, res) => {
  try {
    const now = Date.now();
    const all = (await getFixtures()).map(f => decorateFixture(f, now));

    const filter = String(req.query.status || '').toLowerCase();
    const wanted = { live: 'live', started: 'live', upcoming: 'notstarted', notstarted: 'notstarted', finished: 'finished' }[filter];
    const fixtures = (wanted ? all.filter(f => f.status === wanted) : all)
      .sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (a.kickoffTs - b.kickoffTs));

    res.set('Cache-Control', 'no-store');
    res.json({
      fixtures,
      meta: {
        total: fixtures.length,
        live: all.filter(f => f.status === 'live').length,
        upcoming: all.filter(f => f.status === 'notstarted').length,
        finished: all.filter(f => f.status === 'finished').length,
        updatedAt: new Date(fixturesCache.ts || now).toISOString()
      }
    });

    // Forms: ghir l matchat li mazal ma salaw
    const teams = all.filter(f => f.status !== 'finished').flatMap(f => [f.home, f.away]).filter(t => t.id);
    if (teams.length) ensureForms(teams);
  } catch (e) {
    console.error('/api/fixtures:', e.message);
    res.status(500).json({ error: e.message, fixtures: [] });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    footballData: !!API_KEY,
    bzzoiro: !!BZZOIRO_API_KEY,
    formsCached: formCache.size,
    fixturesCachedAt: fixturesCache.ts ? new Date(fixturesCache.ts).toISOString() : null,
    fdRateLimitedUntil: fdBlockedUntil > Date.now() ? new Date(fdBlockedUntil).toISOString() : null
  });
});

process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.message ? e.message : e));

app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
