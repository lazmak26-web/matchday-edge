const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

/* ═══════════════════════════════════════════════════════════
   BZZOIRO — المصدر ديال الـ odds (real decimal odds)
   ═══════════════════════════════════════════════════════════ */
const BZZOIRO_API_KEY = process.env.BZZOIRO_API_KEY;
const BZZOIRO_API_BASE = 'https://sports.bzzoiro.com/api';

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
const oddsCache = { data: null, ts: 0 };
let prefetchInProgress = null;
let oddsFetchInProgress = null;

/* ═══════════════════════════════════════════════════════════
   TEAM ALIASES — نطابقو الأسماء بين football-data.org و Bzzoiro
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
  'atletico de madrid': 'atletico madrid',
  'sevilla fc': 'sevilla',
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
  'fc bayern munchen': 'bayern munich',
  'borussia dortmund': 'borussia dortmund',
  'rb leipzig': 'rb leipzig',
  'bayer 04 leverkusen': 'bayer leverkusen',
  'eintracht frankfurt': 'eintracht frankfurt',
  // France
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
   ODDS — Bzzoiro (with fallback to per-event odds endpoint)
   ─────────────────────────────────────────────────────────
   - كتحاول تقرا odds من event.odds.bookmakers (inline)
   - إلا ما لقاتش، كتدير طلب لـ /v2/events/{id}/odds/
   - كتستعمل DEBUG=1 باش تطبع أول event كامل
   ═══════════════════════════════════════════════════════════ */
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
      const url = `${BZZOIRO_API_BASE}/v2/events/?date_from=${today}&date_to=${today}`;
      console.log(`  → GET ${url}`);

      const r = await fetch(url, {
        headers: {
          'Authorization': `Token ${BZZOIRO_API_KEY}`,
          'Accept': 'application/json'
        }
      });

      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      }

      const data = await r.json();
      const events = data.results || data.data || (Array.isArray(data) ? data : []);
      console.log(`  · Got ${events.length} events`);

      // DEBUG: اطبع أول event كامل
      if (events.length > 0 && process.env.DEBUG) {
        console.log('  · First event keys:', Object.keys(events[0]).join(', '));
        console.log('  · First event FULL:', JSON.stringify(events[0], null, 2).slice(0, 2000));
      }

      let withOdds = 0;
      let probed = 0;

      for (const ev of events) {
        // نجيبو أسماء الفرق من أي هيكل محتمل
        const homeName = ev.home_team?.name || ev.home?.name || ev.home_team || ev.home;
        const awayName = ev.away_team?.name || ev.away?.name || ev.away_team || ev.away;

        if (!homeName || !awayName || typeof homeName !== 'string' || typeof awayName !== 'string') {
          if (probed < 1 && process.env.DEBUG) {
            console.log('  · Skipping event — no team names:', Object.keys(ev).join(','));
          }
          continue;
        }

        const key = normalizeTeamKey(homeName, awayName);

        // نحاولو نجيبو الـ odds
        let bookmakers = ev.odds?.bookmakers || ev.bookmakers || ev.odds || null;

        // إلا ما كانش، نجيبو من endpoint منفصل
        if ((!bookmakers || !Array.isArray(bookmakers) || !bookmakers.length) && ev.id) {
          if (probed < 2) {
            probed++;
            console.log(`  · Probing odds endpoint for event ${ev.id}...`);
          }
          try {
            const oddsRes = await fetch(`${BZZOIRO_API_BASE}/v2/events/${ev.id}/odds/`, {
              headers: {
                'Authorization': `Token ${BZZOIRO_API_KEY}`,
                'Accept': 'application/json'
              }
            });
            if (oddsRes.ok) {
              const oddsData = await oddsRes.json();
              bookmakers = oddsData.bookmakers || oddsData.results || oddsData.odds || oddsData;
              if (probed <= 2) {
                console.log(`    → Odds response for event ${ev.id}:`, JSON.stringify(oddsData).slice(0, 400));
              }
            } else {
              if (probed <= 2) console.log(`    → Event ${ev.id} odds endpoint: HTTP ${oddsRes.status}`);
            }
          } catch (e) {
            if (probed <= 2) console.log(`    → Event ${ev.id} odds error: ${e.message}`);
          }
          // delay صغير باش ما نضربوش الـ API
          await new Promise(resolve => setTimeout(resolve, 200));
        }

        if (!Array.isArray(bookmakers) || !bookmakers.length) continue;

        const best = {
          home: { price: 0, book: 'N/A' },
          draw: { price: 0, book: 'N/A' },
          away: { price: 0, book: 'N/A' },
          over25: { price: 0, book: 'N/A' },
          under25: { price: 0, book: 'N/A' }
        };

        for (const book of bookmakers) {
          if (!book || typeof book !== 'object') continue;

          const bookName = book.name || book.title || book.bookmaker || book.book_name || 'N/A';
          const markets = book.markets || book.odds || [];

          // ─── حالة 1: الـ odds مسطحة مباشرة فـ book (بدون markets) ───
          if (!markets.length && (book.home || book.away || book.draw)) {
            const h = parseFloat(book.home);
            const d = parseFloat(book.draw);
            const a = parseFloat(book.away);
            if (h > 1 && d > 1 && a > 1) {
              if (h > best.home.price) best.home = { price: h, book: bookName };
              if (d > best.draw.price) best.draw = { price: d, book: bookName };
              if (a > best.away.price) best.away = { price: a, book: bookName };
            }
            const o = parseFloat(book.over_25 || book.over25 || book['over_2.5']);
            const u = parseFloat(book.under_25 || book.under25 || book['under_2.5']);
            if (o > 1) best.over25 = { price: o, book: bookName };
            if (u > 1) best.under25 = { price: u, book: bookName };
            continue;
          }

          if (!Array.isArray(markets)) continue;

          // ─── حالة 2: markets array (شبيه بـ The Odds API) ───
          for (const market of markets) {
            if (!market) continue;

            const mkey = String(market.key || market.name || market.type || market.label || '').toLowerCase();
            const outcomes = market.outcomes || market.selections || market.prices || [];
            if (!Array.isArray(outcomes) || !outcomes.length) continue;

            const is1X2 = /1x2|match|winner|result|h2h|moneyline|ml/.test(mkey) ||
                          /1x2|winner|match/i.test(market.name || '');
            const isOU = /over.under|totals|total|o\/u|ou/.test(mkey) ||
                         /over|under|total/i.test(market.name || '');

            for (const o of outcomes) {
              if (!o) continue;

              const oname = String(o.name || o.label || o.selection || o.outcome || '').toLowerCase();
              const price = parseFloat(o.price || o.odds || o.value || o.decimal);
              const point = parseFloat(o.point || o.handicap || o.line || 0);
              if (!price || price <= 1) continue;

              if (is1X2) {
                const isHome = oname === '1' || oname === 'home' ||
                               oname === homeName.toLowerCase() ||
                               oname.includes(homeName.toLowerCase());
                const isDraw = oname === 'x' || oname === 'draw' || oname === 'tie';
                const isAway = oname === '2' || oname === 'away' ||
                               oname === awayName.toLowerCase() ||
                               oname.includes(awayName.toLowerCase());

                if (isHome && price > best.home.price) best.home = { price, book: bookName };
                else if (isDraw && price > best.draw.price) best.draw = { price, book: bookName };
                else if (isAway && price > best.away.price) best.away = { price, book: bookName };
              }

              if (isOU && (point === 2.5 || point === 2 || point === 3)) {
                // غير 2.5 مهمتنا
                if (point !== 2.5) continue;
                if (oname.startsWith('over') || oname === 'o') {
                  if (price > best.over25.price) best.over25 = { price, book: bookName };
                } else if (oname.startsWith('under') || oname === 'u') {
                  if (price > best.under25.price) best.under25 = { price, book: bookName };
                }
              }
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
          withOdds++;
        }
      }

      console.log(`  · Matched ${withOdds}/${events.length} events with complete odds`);
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
   FIXTURES — مع دمج الـ odds
   ═══════════════════════════════════════════════════════════ */
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
        timestamp: Date.now()
      }
    });

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
      enabled: !!BZZOIRO_API_KEY,
      cached: oddsCache.data ? oddsCache.data.size : 0,
      age: oddsCache.data
        ? Math.round((Date.now() - oddsCache.ts) / 1000) + 's'
        : null,
      fetchRunning: !!oddsFetchInProgress
    }
  });
});

/* ═══════════════════════════════════════════════════════════
   DEBUG — شوف الـ response الخام ديال Bzzoiro
   افتح: GET /api/debug/bzzoiro
   ═══════════════════════════════════════════════════════════ */
app.get('/api/debug/bzzoiro', async (req, res) => {
  if (!BZZOIRO_API_KEY) {
    return res.status(400).json({ error: 'BZZOIRO_API_KEY not set' });
  }

  try {
    const today = todayStr();
    const url = `${BZZOIRO_API_BASE}/v2/events/?date_from=${today}&date_to=${today}`;

    const r = await fetch(url, {
      headers: {
        'Authorization': `Token ${BZZOIRO_API_KEY}`,
        'Accept': 'application/json'
      }
    });

    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {}

    // جيب أول event ID باش نختبرو الـ odds endpoint
    let firstEventOdds = null;
    const firstEventId = parsed?.results?.[0]?.id;
    if (firstEventId) {
      try {
        const oddsRes = await fetch(`${BZZOIRO_API_BASE}/v2/events/${firstEventId}/odds/`, {
          headers: {
            'Authorization': `Token ${BZZOIRO_API_KEY}`,
            'Accept': 'application/json'
          }
        });
        const oddsText = await oddsRes.text();
        let oddsParsed = null;
        try { oddsParsed = JSON.parse(oddsText); } catch (e) {}
        firstEventOdds = {
          eventId: firstEventId,
          status: oddsRes.status,
          preview: oddsText.slice(0, 3000),
          parsedKeys: oddsParsed && typeof oddsParsed === 'object' ? Object.keys(oddsParsed) : null
        };
      } catch (e) {
        firstEventOdds = { eventId: firstEventId, error: e.message };
      }
    }

    res.json({
      eventsUrl: url,
      status: r.status,
      contentType: r.headers.get('content-type'),
      preview: text.slice(0, 5000),
      parsedKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : null,
      resultCount: parsed?.results?.length ?? parsed?.data?.length ?? (Array.isArray(parsed) ? parsed.length : null),
      firstEventOdds
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
  if (!API_KEY) console.error('   ⚠️  Set FOOTBALL_API_KEY env var');
  if (!BZZOIRO_API_KEY) console.warn('   ⚠️  Set BZZOIRO_API_KEY env var for odds support');
});
