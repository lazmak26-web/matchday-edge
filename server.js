const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.FOOTBALL_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

/* ═══════════════════════════════════════════════════════════
   CACHE & CONCURRENCY CONTROL
   ═══════════════════════════════════════════════════════════ */
const FORM_TTL = 60 * 60 * 1000;
const FIXTURES_TTL = 5 * 60 * 1000;
const CONCURRENCY = 2;
const API_DELAY = 400;

const formCache = new Map();
const fixturesCache = { data: null, ts: 0 };
let prefetchInProgress = null;

/* ═══════════════════════════════════════════════════════════
   API HELPER
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
   FIXTURES
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

  const fixtures = matches.map(m => {
    const kickoff = new Date(m.utcDate);
    const dateStr = kickoff.toISOString().slice(0, 10);
    const timeStr = kickoff.toISOString().slice(11, 16);
    const hf = formCache.get(m.homeTeam.id)?.data;
    const af = formCache.get(m.awayTeam.id)?.data;

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
      odds: []
    };
  });

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
    formsCached: formCache.size,
    fixturesCached: !!fixturesCache.data,
    fixturesAge: fixturesCache.data
      ? Math.round((Date.now() - fixturesCache.ts) / 1000) + 's'
      : null,
    prefetchRunning: !!prefetchInProgress
  });
});

/* ═══════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`✅ Matchday Edge on port ${PORT}`);
  console.log(`   API key: ${API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  if (!API_KEY) console.error('   ⚠️  Set FOOTBALL_API_KEY env var');
});
