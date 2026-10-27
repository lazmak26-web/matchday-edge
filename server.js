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
const FIXTURES_TTL = 2 * 60 * 1000;
const EVENTS_TTL = 15 * 60 * 1000;
const ODDS_TTL = 15 * 60 * 1000;
const CONCURRENCY = 2;
const ODDS_CONCURRENCY = 3;
const API_DELAY = 400;
const ODDS_DELAY = 150;

const formCache = new Map();
const fixturesCache = { data: null, ts: 0, stats: null };
const eventsCache = { data: null, ts: 0 };
const oddsCache = { data: null, ts: 0, warned: false };
let prefetchInProgress = null;
let oddsFetchInProgress = null;
let fixturesFetchInProgress = null;
let eventsFetchInProgress = null;

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
  'losc lille': 'lille',
  'us sassuolo calcio': 'sassuolo',
  'torino fc': 'torino',
  'como 1907': 'como',
  'cagliari calcio': 'cagliari'
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

function teamsFuzzyMatch(a, b) {
  if (!a || !b) return false;
  const clean = s => String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|ac|as|us|ss|cf|sc|afc|cd|club|calcio|sporting|sport|city|united|town|the|de|la|le|1907|calcio)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
  const ca = clean(a), cb = clean(b);
  if (!ca || !cb) return false;
  return ca === cb || ca.includes(cb) || cb.includes(ca);
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
      fixturesCache.data = null;
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
   BZZOIRO
   ═══════════════════════════════════════════════════════════ */
async function fetchBzzoiroEvents() {
  if (!BZZOIRO_API_KEY) return [];

  const now = Date.now();
  if (eventsCache.data && now - eventsCache.ts < EVENTS_TTL) {
    return eventsCache.data;
  }
  if (eventsFetchInProgress) return eventsFetchInProgress;

  eventsFetchInProgress = (async () => {
    try {
      const today = todayStr();
      const url = `${BZZOIRO_API_BASE}/v2/events/?date_from=${today}&date_to=${today}`;
      const r = await fetch(url, {
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
      eventsCache.data = events;
      eventsCache.ts = Date.now();
      return events;
    } catch (e) {
      console.error('❌ Bzzoiro events error:', e.message);
      return eventsCache.data || [];
    } finally {
      eventsFetchInProgress = null;
    }
  })();

  return eventsFetchInProgress;
}

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
    home: h, draw: d, away: a,
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
    const oddsMap = new Map();

    try {
      const events = await fetchBzzoiroEvents();
      const validEvents = events.filter(ev => {
        const h = typeof ev.home_team === 'string' ? ev.home_team : ev.home_team?.name;
        const a = typeof ev.away_team === 'string' ? ev.away_team : ev.away_team?.name;
        return h && a;
      });
      console.log(`  · ${events.length} events (${validEvents.length} valid)`);

      const queue = [...validEvents];
      let withOdds = 0;

      const workers = Array.from({ length: ODDS_CONCURRENCY }, async () => {
        while (queue.length) {
          const ev = queue.shift();
          if (!ev) continue;
          const oddsObj = await fetchEventOdds(ev.id);
          const parsed = parseBzzoiroOdds(oddsObj);
          if (parsed) {
            const h = typeof ev.home_team === 'string' ? ev.home_team : ev.home_team?.name;
            const a = typeof ev.away_team === 'string' ? ev.away_team : ev.away_team?.name;
            oddsMap.set(normalizeTeamKey(h, a), parsed);
            withOdds++;
          }
          await new Promise(r => setTimeout(r, ODDS_DELAY));
        }
      });

      await Promise.all(workers);
      console.log(`  · ${withOdds} events with odds`);
    } catch (e) {
      console.error('❌ Odds error:', e.message);
      oddsFetchInProgress = null;
      return oddsCache.data || new Map();
    }

    console.log(`✅ Odds ready: ${oddsMap.size} matches in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    oddsCache.data = oddsMap;
    oddsCache.ts = Date.now();
    fixturesCache.data = null;
    oddsFetchInProgress = null;
    return oddsMap;
  })();

  return oddsFetchInProgress;
}

/* ═══════════════════════════════════════════════════════════
   xG ESTIMATION — 4-level fallback chain
   ═══════════════════════════════════════════════════════════ */
function estimateXGForFixture(fixture) {
  const H = fixture.home, A = fixture.away;

  // Level 1: Direct xG (highest quality)
  if (H.xgFor != null && H.xgAgainst != null &&
      A.xgFor != null && A.xgAgainst != null) {
    fixture.xgSource = 'direct';
    fixture.dataQuality = 'high';
    return;
  }

  // Level 2: From forms (last 5 matches)
  if (H.gf5 != null && H.ga5 != null && A.gf5 != null && A.ga5 != null) {
    H.xgFor = H.gf5 / 5;
    H.xgAgainst = H.ga5 / 5;
    A.xgFor = A.gf5 / 5;
    A.xgAgainst = A.ga5 / 5;
    fixture.xgSource = 'forms';
    fixture.dataQuality = fixture.odds && fixture.odds.length ? 'medium' : 'low';
    return;
  }

  // Level 3: From H2H
  if (fixture.h2h && fixture.h2h.total_matches > 0) {
    const n = fixture.h2h.total_matches;
    const hg = (fixture.h2h.home_goals ?? 0) / n;
    const ag = (fixture.h2h.away_goals ?? 0) / n;
    H.xgFor = hg;
    H.xgAgainst = ag;
    A.xgFor = ag;
    A.xgAgainst = hg;
    fixture.xgSource = 'h2h';
    fixture.dataQuality = fixture.odds && fixture.odds.length ? 'low' : 'very-low';
    return;
  }

  // Level 4: League average (last resort — always produces something)
  H.xgFor = 1.4;
  H.xgAgainst = 1.2;
  A.xgFor = 1.2;
  A.xgAgainst = 1.4;
  fixture.xgSource = 'league-avg';
  fixture.dataQuality = 'very-low';
}

/* ═══════════════════════════════════════════════════════════
   MERGE FIXTURES — combine both sources
   ═══════════════════════════════════════════════════════════ */
function dedupeFixtures(fixtures) {
  const seen = new Map();
  const result = [];
  for (const f of fixtures) {
    const dateKey = f.date + '|' + (f.kickoff || '');
    const homeKey = normalizeTeamKey(f.home.name, '').split('|')[0];
    const awayKey = normalizeTeamKey(f.away.name, '').split('|')[0];
    const key = `${dateKey}|${homeKey}|${awayKey}`;
    if (!seen.has(key)) {
      seen.set(key, f);
      result.push(f);
    } else {
      const existing = seen.get(key);
      const existingScore = (existing.odds?.length || 0) * 2 + (existing.form != null ? 1 : 0);
      const newScore = (f.odds?.length || 0) * 2 + (f.form != null ? 1 : 0);
      if (newScore > existingScore) {
        const idx = result.indexOf(existing);
        result[idx] = f;
        seen.set(key, f);
      }
    }
  }
  return result;
}

async function getFixtures() {
  const now = Date.now();
  if (fixturesCache.data && now - fixturesCache.ts < FIXTURES_TTL) {
    return fixturesCache.data;
  }
  if (fixturesFetchInProgress) return fixturesFetchInProgress;

  fixturesFetchInProgress = (async () => {
    try {
      const today = todayStr();

      const [bzzEvents, fdMatches, oddsMap] = await Promise.all([
        fetchBzzoiroEvents().catch(e => { console.error('Bzz:', e.message); return []; }),
        API_KEY
          ? apiGet(`/matches?date=${today}`).then(d => d.matches || []).catch(e => { console.error('FD:', e.message); return []; })
          : Promise.resolve([]),
        fetchOdds().catch(e => { console.error('Odds:', e.message); return new Map(); })
      ]);

      console.log(`📡 Sources → Bzzoiro: ${bzzEvents.length} | FD: ${fdMatches.length} | Odds: ${oddsMap.size}`);

      const fixtures = [];
      const usedFdIds = new Set();

      // ─── PHASE 1: Bzzoiro events (with optional FD enrichment) ───
      for (const ev of bzzEvents) {
        if (ev.status === 'finished' || ev.status === 'canceled' || ev.status === 'postponed') continue;

        const homeName = typeof ev.home_team === 'string' ? ev.home_team : ev.home_team?.name;
        const awayName = typeof ev.away_team === 'string' ? ev.away_team : ev.away_team?.name;
        if (!homeName || !awayName) continue;

        const kickoff = new Date(ev.event_date);
        if (isNaN(kickoff.getTime())) continue;

        // Match to FD
        let fdMatch = null;
        for (const m of fdMatches) {
          if (usedFdIds.has(m.id)) continue;
          if (teamsFuzzyMatch(homeName, m.homeTeam.name) && teamsFuzzyMatch(awayName, m.awayTeam.name)) {
            fdMatch = m;
            usedFdIds.add(m.id);
            break;
          }
        }

        const key = normalizeTeamKey(homeName, awayName);
        const odds = oddsMap.get(key);
        const hf = fdMatch ? formCache.get(fdMatch.homeTeam.id)?.data : null;
        const af = fdMatch ? formCache.get(fdMatch.awayTeam.id)?.data : null;

        const fixture = {
          id: `bzz_${ev.id}`,
          league: fdMatch?.competition?.name || (ev.league_id ? `League #${ev.league_id}` : 'Football'),
          date: kickoff.toISOString().slice(0, 10),
          kickoff: kickoff.toISOString().slice(11, 16),
          home: {
            id: fdMatch?.homeTeam.id || null,
            name: homeName,
            form: hf?.form || null,
            gf5: hf?.gf5 ?? null, ga5: hf?.ga5 ?? null,
            xgFor: null, xgAgainst: null, injuries: null
          },
          away: {
            id: fdMatch?.awayTeam.id || null,
            name: awayName,
            form: af?.form || null,
            gf5: af?.gf5 ?? null, ga5: af?.ga5 ?? null,
            xgFor: null, xgAgainst: null, injuries: null
          },
          odds: odds ? [odds] : [],
          h2h: ev.head_to_head || null,
          weather: ev.weather || null,
          sources: fdMatch ? ['bzz', 'fd'] : ['bzz'],
          status: ev.status || 'notstarted'
        };

        estimateXGForFixture(fixture);
        fixtures.push(fixture);
      }

      // ─── PHASE 2: Football-data matches NOT found in Bzzoiro ───
      for (const m of fdMatches) {
        if (usedFdIds.has(m.id)) continue;

        const kickoff = new Date(m.utcDate);
        const hf = formCache.get(m.homeTeam.id)?.data;
        const af = formCache.get(m.awayTeam.id)?.data;

        const key = normalizeTeamKey(m.homeTeam.name, m.awayTeam.name);
        let odds = oddsMap.get(key);

        // Fuzzy fallback
        if (!odds) {
          for (const [k, o] of oddsMap.entries()) {
            const [kh, ka] = k.split('|');
            if (teamsFuzzyMatch(m.homeTeam.name, kh) && teamsFuzzyMatch(m.awayTeam.name, ka)) {
              odds = o;
              break;
            }
          }
        }

        const fixture = {
          id: String(m.id),
          league: m.competition?.name || 'N/A',
          date: kickoff.toISOString().slice(0, 10),
          kickoff: kickoff.toISOString().slice(11, 16),
          home: {
            id: m.homeTeam.id,
            name: m.homeTeam.name,
            form: hf?.form || null,
            gf5: hf?.gf5 ?? null, ga5: hf?.ga5 ?? null,
            xgFor: null, xgAgainst: null, injuries: null
          },
          away: {
            id: m.awayTeam.id,
            name: m.awayTeam.name,
            form: af?.form || null,
            gf5: af?.gf5 ?? null, ga5: af?.ga5 ?? null,
            xgFor: null, xgAgainst: null, injuries: null
          },
          odds: odds ? [odds] : [],
          h2h: null, weather: null,
          sources: odds ? ['fd', 'bzz'] : ['fd'],
          status: m.status || 'SCHEDULED'
        };

        estimateXGForFixture(fixture);
        fixtures.push(fixture);
      }

      const deduped = dedupeFixtures(fixtures);

      // Stats
      const stats = {
        total: deduped.length,
        withOdds: deduped.filter(f => f.odds.length > 0).length,
        high: deduped.filter(f => f.dataQuality === 'high').length,
        medium: deduped.filter(f => f.dataQuality === 'medium').length,
        low: deduped.filter(f => f.dataQuality === 'low').length,
        veryLow: deduped.filter(f => f.dataQuality === 'very-low').length,
        fromBzz: deduped.filter(f => f.sources.includes('bzz')).length,
        fromFd: deduped.filter(f => f.sources.includes('fd')).length,
        both: deduped.filter(f => f.sources.length === 2).length
      };

      console.log(`🎯 Total: ${stats.total} | Odds: ${stats.withOdds} | Quality H/M/L/VL: ${stats.high}/${stats.medium}/${stats.low}/${stats.veryLow}`);

      fixturesCache.data = deduped;
      fixturesCache.ts = Date.now();
      fixturesCache.stats = stats;
      return deduped;
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
    const teams = fixtures.flatMap(f => [f.home, f.away]).filter(t => t.id);

    res.json({
      fixtures,
      meta: {
        stats: fixturesCache.stats,
        formsComplete: fixtures.every(f =>
          (!f.home.id || formCache.has(f.home.id)) &&
          (!f.away.id || formCache.has(f.away.id))
        ),
        timestamp: Date.now()
      }
    });

    if (teams.length && !prefetchInProgress) {
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
    keys: { football: !!API_KEY, bzzoiro: !!BZZOIRO_API_KEY },
    forms: { cached: formCache.size, prefetchRunning: !!prefetchInProgress },
    events: {
      cached: eventsCache.data?.length ?? 0,
      age: eventsCache.data ? Math.round((Date.now() - eventsCache.ts) / 1000) + 's' : null
    },
    fixtures: {
      count: fixturesCache.data?.length ?? 0,
      stats: fixturesCache.stats,
      age: fixturesCache.data ? Math.round((Date.now() - fixturesCache.ts) / 1000) + 's' : null
    },
    odds: {
      cached: oddsCache.data ? oddsCache.data.size : 0,
      age: oddsCache.data ? Math.round((Date.now() - oddsCache.ts) / 1000) + 's' : null
    }
  });
});

app.get('/api/debug/bzzoiro', async (req, res) => {
  if (!BZZOIRO_API_KEY) return res.status(400).json({ error: 'BZZOIRO_API_KEY not set' });
  try {
    const today = todayStr();
    const r = await fetch(`${BZZOIRO_API_BASE}/v2/events/?date_from=${today}&date_to=${today}`, {
      headers: { 'Authorization': `Token ${BZZOIRO_API_KEY}`, 'Accept': 'application/json' }
    });
    const data = await r.json();
    const events = data.results || [];
    res.json({
      events_count: events.length,
      sample_events: events.slice(0, 5).map(ev => ({
        id: ev.id,
        home_team: ev.home_team,
        away_team: ev.away_team,
        event_date: ev.event_date,
        status: ev.status,
        league_id: ev.league_id
      }))
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
  console.log(`   Football API key: ${API_KEY ? 'SET ✓' : 'MISSING ✗ (optional)'}`);
  console.log(`   Bzzoiro API key:  ${BZZOIRO_API_KEY ? 'SET ✓' : 'MISSING ✗ (required)'}`);
});
