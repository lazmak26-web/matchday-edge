const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const API_BASE = 'https://api.football-data.org/v4';

// ═══════════════════════════════════════════════════════════
// CACHE — bach ma ne7r9och l'API calls
// ═══════════════════════════════════════════════════════════
const cache = {
  fixtures: { data: null, date: null, fetchedAt: 0 },
  forms: new Map(),
  prefetching: false
};
const TTL = { fixtures: 15 * 60 * 1000, forms: 6 * 60 * 60 * 1000 };
const RATE = { lastRequest: 0, minInterval: 6500 };

// Rate-limited fetch (10 req/min free tier)
async function apiFetch(url) {
  const wait = Math.max(0, RATE.minInterval - (Date.now() - RATE.lastRequest));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  RATE.lastRequest = Date.now();

  const r = await fetch(url, { headers: { 'X-Auth-Token': API_KEY } });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`football-data.org ${r.status}: ${text.slice(0, 150)}`);
  }
  return r.json();
}

// Kayjib matches dyal l'yom
async function getFixtures() {
  const today = new Date().toISOString().slice(0, 10);
  if (cache.fixtures.data && cache.fixtures.date === today &&
      Date.now() - cache.fixtures.fetchedAt < TTL.fixtures) {
    return cache.fixtures.data;
  }

  console.log('📡 Fetching fixtures for', today);
  const data = await apiFetch(`${API_BASE}/matches?date=${today}`);
  const raw = data.matches || [];
  console.log('📦 Got', raw.length, 'raw matches');

  const fixtures = raw.map(m => ({
    id: String(m.id),
    league: (m.competition && m.competition.name) || 'Unknown league',
    date: m.utcDate ? m.utcDate.slice(0, 10) : today,
    kickoff: m.utcDate ? m.utcDate.slice(11, 16) : 'N/A',
    home: { id: m.homeTeam && m.homeTeam.id, name: (m.homeTeam && m.homeTeam.name) || 'Home' },
    away: { id: m.awayTeam && m.awayTeam.id, name: (m.awayTeam && m.awayTeam.name) || 'Away' },
    odds: null,
    h2h: null,
    weather: null
  })).filter(f => f.home.id && f.away.id);

  cache.fixtures = { data: fixtures, date: today, fetchedAt: Date.now() };
  return fixtures;
}

// Kayjib form (akhir 5 matches) dyal team wa7ed
async function getForm(teamId) {
  const cached = cache.forms.get(teamId);
  if (cached && Date.now() - cached.fetchedAt < TTL.forms) return cached;

  const data = await apiFetch(`${API_BASE}/teams/${teamId}/matches?status=FINISHED&limit=10`);
  const finished = (data.matches || [])
    .filter(m => m.status === 'FINISHED' && m.score && m.score.fullTime &&
                 m.score.fullTime.home !== null && m.score.fullTime.away !== null)
    .slice(-5);

  let form = '', gf = 0, ga = 0, n = 0;
  for (const m of finished) {
    const isHome = m.homeTeam && m.homeTeam.id === teamId;
    const gFor = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const gAgainst = isHome ? m.score.fullTime.away : m.score.fullTime.home;
    if (gFor > gAgainst) form += 'W';
    else if (gFor < gAgainst) form += 'L';
    else form += 'D';
    gf += gFor; ga += gAgainst; n++;
  }

  const result = {
    form: form || null,
    gf5: n ? gf : null,
    ga5: n ? ga : null,
    xgFor: n ? +(gf / n).toFixed(2) : null,
    xgAgainst: n ? +(ga / n).toFixed(2) : null,
    injuries: null,
    fetchedAt: Date.now()
  };
  cache.forms.set(teamId, result);
  return result;
}

// Prefetch forms f background
async function prefetchForms(fixtures) {
  if (cache.prefetching) return;
  cache.prefetching = true;
  const teams = new Set();
  for (const fx of fixtures) { teams.add(fx.home.id); teams.add(fx.away.id); }
  console.log(`🔄 Prefetching forms for ${teams.size} teams`);

  for (const teamId of teams) {
    const cached = cache.forms.get(teamId);
    if (cached && Date.now() - cached.fetchedAt < TTL.forms) continue;
    try { await getForm(teamId); }
    catch (e) { console.error(`  ✗ Team ${teamId}:`, e.message); }
  }
  cache.prefetching = false;
  console.log('✅ Prefetch complete');
}

// ═══════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/fixtures', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'FOOTBALL_DATA_API_KEY not set. Add it in Railway → Variables.'
    });
  }
  try {
    const fixtures = await getFixtures();
    // Enrich b cached forms only (ma kaystenach)
    const enriched = fixtures.map(fx => ({
      ...fx,
      home: { ...fx.home, ...(cache.forms.get(fx.home.id) || {}) },
      away: { ...fx.away, ...(cache.forms.get(fx.away.id) || {}) }
    }));
    // Start background prefetch
    prefetchForms(fixtures).catch(e => console.error('Prefetch:', e.message));
    res.json({ fixtures: enriched });
  } catch (e) {
    console.error('❌ /api/fixtures:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    fixtures: (cache.fixtures.data || []).length,
    formsCached: cache.forms.size,
    prefetching: cache.prefetching,
    lastFetch: cache.fixtures.fetchedAt ? new Date(cache.fixtures.fetchedAt).toISOString() : null
  });
});

app.listen(PORT, () => {
  console.log(`✅ Matchday Edge on port ${PORT}`);
  console.log(`   API key: ${API_KEY ? 'SET ✓' : 'MISSING ✗'}`);
});
