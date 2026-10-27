const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

const BZZOIRO_API_KEY = process.env.BZZOIRO_API_KEY;
const BZZOIRO_API_BASE = 'https://sports.bzzoiro.com/api';

/* ═══════════════════════════════════════════════════════════
   CACHE & CONCURRENCY CONTROL
   ═══════════════════════════════════════════════════════════ */
const FORM_TTL = 60 * 60 * 1000;         // Forms: ساعة
const FIXTURES_TTL = 5 * 60 * 1000;      // Fixtures: 5 دقايق
const ODDS_TTL = 15 * 60 * 1000;         // Odds: 15 دقيقة
const CONCURRENCY = 2;
const ODDS_CONCURRENCY = 3;              // 3 طلبات فـ نفس الوقت (البzzoiro rate limit 10/s)
const API_DELAY = 400;

const formCache = new Map();
const fixturesCache = { data: null, ts: 0 };
const oddsCache = { data: null, ts: 0, warned: false };
let prefetchInProgress = null;
let oddsFetchInProgress = null;
let fixturesFetchInProgress = null;      // ← lock جديد

/* ═══════════════════════════════════════════════════════════
   TEAM ALIASES
   ═══════════════════════════════════════════════════════════ */
const TEAM_ALIASES = {
  'manchester united fc': 'manchester united',
  'manchester city fc': 'manchester city',
  'arsenal fc': 'arsenal',
  'chelsea fc': 'chelsea',
  'liverpool fc': 'liverpool',
  'tottenham hotspur fc': 'tottenham hotspur',
  'newcastle united fc': 'newcastle united',
  'aston villa fc': 'aston villa',
  'west ham united fc': 'west ham united',
  'brighton & hove albion fc': 'brighton and hove albion',
  'wolverhampton wanderers fc': 'wolverhampton wanderers',
  'nottingham forest fc': 'nottingham forest',
  'crystal palace fc': 'crystal palace',
  'everton fc': 'everton',
  'fulham fc': 'fulham',
  'brentford fc': 'brentford',
  'afc bournemouth': 'bournemouth',
  'leicester city fc': 'leicester city',
  'ipswich town fc': 'ipswich town',
  'southampton fc': 'southampton',
  'real madrid cf': 'real madrid',
  'fc barcelona': 'barcelona',
  'atletico de madrid': 'atletico madrid',
  'sevilla fc': 'sevilla',
  'real betis balompie': 'real betis',
  'valencia cf': 'valencia',
  'villarreal cf': 'villarreal',
  'athletic club': 'athletic bilbao',
  'fc internazionale milano': 'inter milan',
  'ac milan': 'ac milan',
  'juventus fc': 'juventus',
  'ssc napoli': 'napoli',
  'as roma': 'roma',
  'ss lazio': 'lazio',
  'atalanta bc': 'atalanta',
  'acf fiorentina': 'fiorentina',
  'fc bayern munchen': 'bayern munich',
  'borussia dortmund': 'borussia dortmund',
  'rb leipzig': 'rb leipzig',
  'bayer 04 leverkusen': 'bayer leverkusen',
  'eintracht frankfurt': 'eintracht frankfurt',
  'paris saint-germain fc': 'paris saint germain',
  'olympique de marseille': 'marseille',
  'olympique lyonnais': 'lyon',
  'as monaco': 'monaco',
  'losc lille': 'lille'
};

function normalizeTeamKey(home, away) {
  const clean = s => {
    let t = String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return TEAM_ALIASES[t] || t;
  };
  return `${clean(home)}|${clean(away)}`;
}

/* ═══════════════════════════════════════════════════════════
   FOOTBALL-DATA.ORG
   ═══════════════════════════════════════════════════════════ */
async function apiGet(endpoint) {
  const r = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'X-Auth-Token': API_KEY || '' }
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`API ${endpoint} → ${r.status} ${text.slice(0, 200)}`);
  }
  return r.json();
}

/* ═══════════════════════════════════════════════════════════
   FORMS
   ═══════════════════════════════════════════════════════════ */
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
      gf5 += scored || 0;
      ga5 += conceded || 0;
      if (scored > conceded) form += 'W';
      else if (scored === conceded) form += 'D';
      else form += 'L';
    }
    return { form, gf5, ga5 };
  } catch (e) {
    console.warn(`Form fetch failed [team ${teamId}]:`, e.message);
    return null;
  }
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
  const count = Math.min(CONCURRENCY, Math.max(queue.length, 1));
  await Promise.all(Array.from({ length: count }, worker));
}

async function ensureForms(teams) {
  const now = Date.now();
  const needed = teams.filter(t => {
    if (!t || !t.id) return false;
    const c = formCache.get(t.id);
    return !c || (now - c.ts) > FORM_TTL;
  });

  if (!needed.length) return;
  if (prefetchInProgress) return prefetchInProgress;

  prefetchInProgress = (async () => {
    const start = Date.now();
    console.log(`🔄 Prefetching forms for ${needed.length} team(s)`);
    try {
      await prefetchForms(needed);
      console.log(`✅ Prefetch done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error('Prefetch error:', e.message);
    } finally {
      prefetchInProgress = null;
    }
  })();

  return prefetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   TODAY
   ═══════════════════════════════════════════════════════════ */
function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/* ═══════════════════════════════════════════════════════════
   BZZOIRO ODDS PARSING
   ─────────────────────────────────────────────────────────
   الهيكل الحقيقي من Bzzoiro (شوفناه فـ الـ logs):
   {
     "event_id": 602465,
     "odds": {
       "home_win": 2.5,
       "draw": 3.1,
       "away_win": 2.75,
       "over_25_goals": 1.89,
       "under_25_goals": 1.87,
       "btts_yes": 1.83,
       "btts_no": 1.87
     }
   }
   ═══════════════════════════════════════════════════════════ */
function parseBzzoiroOdds(oddsObj) {
  if (!oddsObj || typeof oddsObj !== 'object') return null;

  const h = parseFloat(oddsObj.home_win);
  const d = parseFloat(oddsObj.draw);
  const a = parseFloat(oddsObj.away_win);

  if (!(h > 1 && d > 1 && a > 1)) return null;

  const over = parseFloat(oddsObj.over_25_goals);
  const under = parseFloat(oddsObj.under_25_goals);

  return {
    book: 'Bzzoiro',
    home: h,
    draw: d,
    away: a,
    over25: over > 1 ? over : null,
    under25: under > 1 ? under : null
  };
}

async function fetchEventOdds(eventId) {
  try {
    const r = await fetch(`${BZZOIRO_API_BASE}/v2/events/${eventId}/odds/`, {
      headers: {
        'Authorization': `Token ${BZZOIRO_API_KEY}`,
        'Accept': 'application/json'
      }
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.odds || data;
  } catch (e) {
    return null;
  }
}

async function fetchOdds() {
  if (!BZZOIRO_API_KEY) {
    if (!oddsCache.warned) {
      console.warn('⚠️  BZZOIRO_API_KEY not set — odds disabled');
      oddsCache.warned = true;
    }
    return new Map();
  }

  const now = Date.now();
  if (oddsCache.data && now - oddsCache.ts < ODDS_TTL) {
    return oddsCache.data;
  }
  if (oddsFetchInProgress) return oddsFetchInProgress;

  oddsFetchInProgress = (async () => {
    const start = Date.now();
    console.log('📊 Fetching odds from Bzzoiro...');
    const today = todayStr();
    const oddsMap = new Map();

    try {
      const eventsUrl = `${BZZOIRO_API_BASE}/v2/events/?date_from=${today}&date_to=${today}`;
      const r = await fetch(eventsUrl, {
        headers: {
          'Authorization': `Token ${BZZOIRO_API_KEY}`,
          'Accept': 'application/json'
        }
      });

      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Events HTTP ${r.status}: ${text.slice(0, 200)}`);
      }

      const data = await r.json();
      const events = data.results || data.data || (Array.isArray(data) ? data : []);
      console.log(`  · Got ${events.length} events`);

      // فلتر الـ events اللي عندهم أسماء فرق صحيحة
      const validEvents = events.filter(ev => {
        const h = ev.home_team;
        const a = ev.away_team;
        return typeof h === 'string' && typeof a === 'string' && h && a;
      });
      console.log(`  · ${validEvents.length} events with valid teams`);

      // نجيبو الـ odds بالتوازي (concurrency 3)
      const queue = [...validEvents];
      let withOdds = 0;
      let probed = 0;

      const workers = Array.from({ length: ODDS_CONCURRENCY }, async () => {
        while (queue.length) {
          const ev = queue.shift();
          if (!ev) continue;

          const oddsObj = await fetchEventOdds(ev.id);

          if (probed < 2 && process.env.DEBUG) {
            probed++;
            console.log(`  · Sample event ${ev.id} (${ev.home_team} vs ${ev.away_team}):`,
              JSON.stringify(oddsObj).slice(0, 300));
          }

          const parsed = parseBzzoiroOdds(oddsObj);
          if (parsed) {
            const key = normalizeTeamKey(ev.home_team, ev.away_team);
            oddsMap.set(key, parsed);
            withOdds++;
          }
        }
      });

      await Promise.all(workers);
      console.log(`  · Matched ${withOdds}/${validEvents.length} events with complete odds`);
    } catch (e) {
      console.error('❌ Odds fetch error:', e.message);
      oddsFetchInProgress = null;
      return oddsCache.data || new Map();
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ Odds ready: ${oddsMap.size} matches in ${elapsed}s`);

    oddsCache.data = oddsMap;
    oddsCache.ts = now;
    oddsFetchInProgress = null;
    return oddsMap;
  })();

  return oddsFetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   FIXTURES — مع lock و parallel fetch
   ═══════════════════════════════════════════════════════════ */
async function getFixtures() {
  const now = Date.now();
  if (fixturesCache.data && now - fixturesCache.ts < FIXTURES_TTL) {
    return fixturesCache.data;
  }
  if (fixturesFetchInProgress) return fixturesFetchInProgress;

  fixturesFetchInProgress = (async () => {
    try {
      if (!API_KEY) {
        console.warn('⚠️  FOOTBALL_API_KEY not set — skipping fixtures (no matches to match odds against)');
        fixturesCache.data = [];
        fixturesCache.ts = Date.now();
        return [];
      }

      const today = todayStr();
      console.log(`📡 Fetching fixtures + odds for ${today}`);

      // نجيبو fixtures و odds بالتوازي
      const fixturesPromise = apiGet(`/matches?date=${today}`)
        .catch(e => {
          console.error('❌ Football API error:', e.message);
          return { matches: [] };
        });

      const oddsPromise = fetchOdds();

      const [raw, oddsMap] = await Promise.all([fixturesPromise, oddsPromise]);

      const matches = raw.matches || [];
      console.log(`📦 Got ${matches.length} raw matches`);

      let matchedOdds = 0;
      const fixtures = matches.map(m => {
        const kickoff = new Date(m.utcDate);
        const dateStr = kickoff.toISOString().slice(0, 10);
        const timeStr = kickoff.toISOString().slice(11, 16);
        const hf = formCache.get(m.homeTeam.id)?.data;
        const af = formCache.get(m.awayTeam.id)?.data;

        const key = normalizeTeamKey(m.homeTeam.name, m.awayTeam.name);
        const odds = oddsMap.get(key);
        if (odds) matchedOdds++;

        return {
          id: String(m.id),
          league: m.competition?.name || 'N/A',
          date: dateStr,
          kickoff: timeStr,
          home: {
            id: m.homeTeam.id,
            name: m.homeTeam.name,
            form: hf?.form || null,
            gf5: hf?.gf5 ?? null,
            ga5: hf?.ga5 ?? null,
            xgFor: null, xgAgainst: null, injuries: null
          },
          away: {
            id: m.awayTeam.id,
            name: m.awayTeam.name,
            form: af?.form || null,
            gf5: af?.gf5 ?? null,
            ga5: af?.ga5 ?? null,
            xgFor: null, xgAgainst: null, injuries: null
          },
          odds: odds ? [odds] : []
        };
      });

      console.log(`🎯 Matched odds for ${matchedOdds}/${matches.length} fixtures`);

      // إلا كان DEBUG، وري الماتشات اللي ما تطابقوش (باش تزيد aliases)
      if (process.env.DEBUG && matchedOdds < matches.length) {
        const unmatched = matches
          .filter(m => !oddsMap.has(normalizeTeamKey(m.homeTeam.name, m.awayTeam.name)))
          .slice(0, 5)
          .map(m => `${m.homeTeam.name} vs ${m.awayTeam.name}`);
        if (unmatched.length) {
          console.log(`  · Unmatched fixtures (first 5):`, unmatched);
          console.log(`  · Available odds keys (first 10):`,
            Array.from(oddsMap.keys()).slice(0, 10));
        }
      }

      fixturesCache.data = fixtures;
      fixturesCache.ts = Date.now();
      return fixtures;
    } finally {
      fixturesFetchInProgress = null;
    }
  })();

  return fixturesFetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════ */
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/fixtures', async (req, res) => {
  try {
    const fixtures = await getFixtures();
    const teams = fixtures.flatMap(f => [f.home, f.away]);

    res.json({
      fixtures,
      meta: {
        formsComplete: fixtures.every(f =>
          formCache.has(f.home.id) && formCache.has(f.away.id)
        ),
        oddsEnabled: !!BZZOIRO_API_KEY,
        oddsCached: oddsCache.data ? oddsCache.data.size : 0,
        oddsAge: oddsCache.data
          ? Math.round((Date.now() - oddsCache.ts) / 1000) + 's'
          : null,
        footballApiEnabled: !!API_KEY,
        timestamp: Date.now()
      }
    });

    if (fixtures.length && !prefetchInProgress) {
      ensureForms(teams).catch(e => console.error('BG prefetch:', e.message));
    }
  } catch (e) {
    console.error('Fixtures error:', e.message);
    res.status(500).json({ error: e.message, fixtures: [] });
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    keys: {
      football: !!API_KEY,
      bzzoiro: !!BZZOIRO_API_KEY
    },
    forms: {
      cached: formCache.size,
      prefetchRunning: !!prefetchInProgress
    },
    fixtures: {
      cached: !!fixturesCache.data,
      count: fixturesCache.data?.length ?? 0,
      age: fixturesCache.data
        ? Math.round((Date.now() - fixturesCache.ts) / 1000) + 's'
        : null,
      fetching: !!fixturesFetchInProgress
    },
    odds: {
      enabled: !!BZZOIRO_API_KEY,
      cached: oddsCache.data ? oddsCache.data.size : 0,
      age: oddsCache.data
        ? Math.round((Date.now() - oddsCache.ts) / 1000) + 's'
        : null,
      fetching: !!oddsFetchInProgress
    }
  });
});

/* ═══════════════════════════════════════════════════════════
   DEBUG — كيعرض شكل الـ events و odds
   افتح: GET /api/debug/bzzoiro
   ═══════════════════════════════════════════════════════════ */
app.get('/api/debug/bzzoiro', async (req, res) => {
  if (!BZZOIRO_API_KEY) {
    return res.status(400).json({ error: 'BZZOIRO_API_KEY not set' });
  }

  try {
    const today = todayStr();
    const eventsUrl = `${BZZOIRO_API_BASE}/v2/events/?date_from=${today}&date_to=${today}`;
    const r = await fetch(eventsUrl, {
      headers: {
        'Authorization': `Token ${BZZOIRO_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    const data = await r.json();
    const events = data.results || [];
    const sample = events.slice(0, 3);

    // نجيبو odds لأول 3 events
    const sampleOdds = [];
    for (const ev of sample) {
      if (!ev.id) continue;
      try {
        const ores = await fetch(`${BZZOIRO_API_BASE}/v2/events/${ev.id}/odds/`, {
          headers: {
            'Authorization': `Token ${BZZOIRO_API_KEY}`,
            'Accept': 'application/json'
          }
        });
        const odata = await ores.json();
        sampleOdds.push({
          event_id: ev.id,
          home_team: ev.home_team,
          away_team: ev.away_team,
          raw_odds_response: odata,
          parsed: parseBzzoiroOdds(odata.odds || odata)
        });
      } catch (e) {
        sampleOdds.push({ event_id: ev.id, error: e.message });
      }
    }

    res.json({
      events_url: eventsUrl,
      events_status: r.status,
      events_count: events.length,
      sample_events: sample.map(ev => ({
        id: ev.id,
        home_team: ev.home_team,
        away_team: ev.away_team,
        league_id: ev.league_id,
        event_date: ev.event_date,
        status: ev.status
      })),
      sample_odds: sampleOdds
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`✅ Matchday Edge on port ${PORT}`);
  console.log(`   Football API key: ${API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   Bzzoiro API key:  ${BZZOIRO_API_KEY ? 'SET ✓' : 'MISSING ✗ (odds disabled)'}`);
  if (!API_KEY) console.error('   ⚠️  FOOTBALL_API_KEY missing → no fixtures will be loaded');
  if (!BZZOIRO_API_KEY) console.warn('   ⚠️  BZZOIRO_API_KEY missing → no odds will be loaded');
});
