const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

/* ═══════════════════════════════════════════════════════════
   CACHE & CONCURRENCY CONTROL
   ═══════════════════════════════════════════════════════════ */
const FORM_TTL = 60 * 60 * 1000;         // Forms: ساعة
const FIXTURES_TTL = 5 * 60 * 1000;      // Fixtures: 5 دقايق
const ODDS_TTL = 15 * 60 * 1000;         // Odds: 15 دقيقة
const CONCURRENCY = 2;
const API_DELAY = 400;

const formCache = new Map();              // teamId → { data, ts }
const fixturesCache = { data: null, ts: 0 };
const oddsCache = { data: null, ts: 0 };  // Map: "home|away" → odds
let prefetchInProgress = null;
let oddsFetchInProgress = null;

/* ═══════════════════════════════════════════════════════════
   ALIASES — نطابقو الأسماء بين football-data.org و The Odds API
   ═══════════════════════════════════════════════════════════ */
const TEAM_ALIASES = {
  // England
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
  // Spain
  'real madrid cf': 'real madrid',
  'fc barcelona': 'barcelona',
  'atlético de madrid': 'atletico madrid',
  'atletico de madrid': 'atletico madrid',
  'sevilla fc': 'sevilla',
  'real betis balompié': 'real betis',
  'real betis balompie': 'real betis',
  'valencia cf': 'valencia',
  'villarreal cf': 'villarreal',
  'athletic club': 'athletic bilbao',
  // Italy
  'fc internazionale milano': 'inter milan',
  'ac milan': 'ac milan',
  'juventus fc': 'juventus',
  'ssc napoli': 'napoli',
  'as roma': 'roma',
  'ss lazio': 'lazio',
  'atalanta bc': 'atalanta',
  'acf fiorentina': 'fiorentina',
  // Germany
  'fc bayern münchen': 'bayern munich',
  'fc bayern munchen': 'bayern munich',
  'borussia dortmund': 'borussia dortmund',
  'rb leipzig': 'rb leipzig',
  'bayer 04 leverkusen': 'bayer leverkusen',
  'eintracht frankfurt': 'eintracht frankfurt',
  // France
  'paris saint-germain fc': 'paris saint germain',
  'paris saint-germain': 'paris saint germain',
  'olympique de marseille': 'marseille',
  'olympique lyonnais': 'lyon',
  'as monaco': 'monaco',
  'losc lille': 'lille',
  'los angeles': 'los angeles'  // placeholder
};

function normalizeTeamKey(home, away) {
  const clean = s => {
    let t = String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // حيّد الـ accents
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return TEAM_ALIASES[t] || t;
  };
  return `${clean(home)}|${clean(away)}`;
}

/* ═══════════════════════════════════════════════════════════
   API HELPERS
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
   FORMS — parallel fetch, cached, deduped
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
   ODDS — من The Odds API (cached 15 دقيقة)
   ═══════════════════════════════════════════════════════════ */
async function fetchOdds() {
  if (!ODDS_API_KEY) {
    if (!oddsCache.warned) {
      console.warn('⚠️  ODDS_API_KEY not set — odds disabled');
      oddsCache.warned = true;
    }
    return new Map();
  }

  // ─── Cache hit ───
  const now = Date.now();
  if (oddsCache.data && now - oddsCache.ts < ODDS_TTL) {
    return oddsCache.data;
  }

  // ─── Lock: ما نديروش fetch متوازي ───
  if (oddsFetchInProgress) return oddsFetchInProgress;

  oddsFetchInProgress = (async () => {
    const start = Date.now();
    console.log('📊 Fetching odds from The Odds API...');

    const sports = [
      'soccer_epl',
      'soccer_spain_la_liga',
      'soccer_italy_serie_a',
      'soccer_germany_bundesliga',
      'soccer_france_ligue_one',
      'soccer_uefa_champs_league'
    ];

    const oddsMap = new Map();
    let totalEvents = 0;
    let quotaRemaining = null;

    for (const sport of sports) {
      try {
        const url = `${ODDS_BASE}/sports/${sport}/odds` +
          `?apiKey=${ODDS_API_KEY}` +
          `&regions=eu` +
          `&markets=h2h,totals` +
          `&oddsFormat=decimal`;

        const r = await fetch(url);
        if (!r.ok) {
          const errText = await r.text().catch(() => '');
          console.warn(`  ✗ ${sport}: HTTP ${r.status} ${errText.slice(0, 100)}`);
          continue;
        }

        // راقب الـ quota
        const rem = r.headers.get('x-requests-remaining');
        if (rem) quotaRemaining = rem;

        const events = await r.json();
        if (!Array.isArray(events) || !events.length) {
          console.log(`  · ${sport}: 0 events`);
          continue;
        }

        console.log(`  · ${sport}: ${events.length} events`);
        totalEvents += events.length;

        for (const ev of events) {
          const key = normalizeTeamKey(ev.home_team, ev.away_team);

          // نجيبو أفضل odds من كل bookmaker
          let best = {
            home: { price: 0, book: 'N/A' },
            draw: { price: 0, book: 'N/A' },
            away: { price: 0, book: 'N/A' },
            over25: { price: 0, book: 'N/A' },
            under25: { price: 0, book: 'N/A' }
          };

          for (const book of ev.bookmakers || []) {
            for (const market of book.markets || []) {
              if (market.key === 'h2h') {
                const h = market.outcomes.find(o => o.name === ev.home_team);
                const d = market.outcomes.find(o => o.name === 'Draw');
                const a = market.outcomes.find(o => o.name === ev.away_team);
                if (h && h.price > best.home.price) best.home = { price: h.price, book: book.title };
                if (d && d.price > best.draw.price) best.draw = { price: d.price, book: book.title };
                if (a && a.price > best.away.price) best.away = { price: a.price, book: book.title };
              }
              if (market.key === 'totals') {
                const o = market.outcomes.find(x => x.name === 'Over' && x.point === 2.5);
                const u = market.outcomes.find(x => x.name === 'Under' && x.point === 2.5);
                if (o && o.price > best.over25.price) best.over25 = { price: o.price, book: book.title };
                if (u && u.price > best.under25.price) best.under25 = { price: u.price, book: book.title };
              }
            }
          }

          if (best.home.price && best.draw.price && best.away.price) {
            oddsMap.set(key, {
              book: best.home.book,
              home: best.home.price,
              draw: best.draw.price,
              away: best.away.price,
              over25: best.over25.price || null,
              under25: best.under25.price || null
            });
          }
        }

        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.warn(`  ✗ ${sport}: ${e.message}`);
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`✅ Odds ready: ${oddsMap.size} matches from ${totalEvents} events in ${elapsed}s`);
    if (quotaRemaining !== null) {
      console.log(`   📉 API quota remaining: ${quotaRemaining}`);
    }

    oddsCache.data = oddsMap;
    oddsCache.ts = now;
    oddsFetchInProgress = null;
    return oddsMap;
  })();

  return oddsFetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   FIXTURES — مع دمج الـ odds
   ═══════════════════════════════════════════════════════════ */
function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function getFixtures() {
  const now = Date.now();
  if (fixturesCache.data && now - fixturesCache.ts < FIXTURES_TTL) {
    return fixturesCache.data;
  }

  const today = todayStr();
  console.log(`📡 Fetching fixtures for ${today}`);
  const raw = await apiGet(`/matches?date=${today}`);
  const matches = raw.matches || [];
  console.log(`📦 Got ${matches.length} raw matches`);

  // نجيبو odds (cached 15 دقيقة)
  const oddsMap = await fetchOdds();

  let matchedOdds = 0;
  const fixtures = matches.map(m => {
    const kickoff = new Date(m.utcDate);
    const dateStr = kickoff.toISOString().slice(0, 10);
    const timeStr = kickoff.toISOString().slice(11, 16);
    const hf = formCache.get(m.homeTeam.id)?.data;
    const af = formCache.get(m.awayTeam.id)?.data;

    // نحاولو نلقاو الـ odds ديال هاد الماتش
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

  fixturesCache.data = fixtures;
  fixturesCache.ts = now;
  return fixtures;
}

/* ═══════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════ */
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/fixtures', async (req, res) => {
  try {
    const fixtures = await getFixtures();
    const teams = fixtures.flatMap(f => [f.home, f.away]);

    // رجع دغيا (بلا ما تتسنى forms)
    res.json({
      fixtures,
      meta: {
        formsComplete: fixtures.every(f =>
          formCache.has(f.home.id) && formCache.has(f.away.id)
        ),
        oddsEnabled: !!ODDS_API_KEY,
        oddsCached: oddsCache.data ? oddsCache.data.size : 0,
        oddsAge: oddsCache.data
          ? Math.round((Date.now() - oddsCache.ts) / 1000) + 's'
          : null,
        timestamp: Date.now()
      }
    });

    // فـ background: كمّل forms الناقصة
    if (!prefetchInProgress) {
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
    forms: {
      cached: formCache.size,
      prefetchRunning: !!prefetchInProgress
    },
    fixtures: {
      cached: !!fixturesCache.data,
      age: fixturesCache.data
        ? Math.round((Date.now() - fixturesCache.ts) / 1000) + 's'
        : null
    },
    odds: {
      enabled: !!ODDS_API_KEY,
      cached: oddsCache.data ? oddsCache.data.size : 0,
      age: oddsCache.data
        ? Math.round((Date.now() - oddsCache.ts) / 1000) + 's'
        : null,
      fetchRunning: !!oddsFetchInProgress
    }
  });
});

/* ═══════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`✅ Matchday Edge on port ${PORT}`);
  console.log(`   Football API key: ${API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`   Odds API key:     ${ODDS_API_KEY ? 'SET ✓' : 'MISSING ✗ (odds disabled)'}`);
  if (!API_KEY) console.error('   ⚠️  Set FOOTBALL_API_KEY env var');
  if (!ODDS_API_KEY) console.warn('   ⚠️  Set ODDS_API_KEY env var for odds support');
});
