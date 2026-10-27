// server.js — Matchday Edge backend (Railway)
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = 'https://footballdata.io/api/v1';
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;

// Kayjib l'frontend mn public/
app.use(express.static(path.join(__dirname, 'public')));

// CORS (mzyan l'dev, Railway ma y7tajch bzaf)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Endpoint li l'frontend kay3ayet 3lih
app.get('/api/fixtures', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'FOOTBALL_DATA_API_KEY is not set' });
  }

  try {
    const r = await fetch(`${API_BASE}/fixtures/today?limit=50`, {
      headers: { Authorization: `Bearer ${API_KEY}` }
    });
    if (!r.ok) throw new Error(`footballdata.io: ${r.status}`);
    const json = await r.json();
    const fixtures = json.data || [];

    const mapped = fixtures.map(m => {
      const h = m.home_team || m.home || {};
      const a = m.away_team || m.away || {};
      const kickoff = (m.kickoff_time || m.time || '').toString().slice(0, 5) || 'N/A';
      const odds = m.odds || m.bookmakers || null;

      return {
        id: String(m.match_id || m.id || `${h.name}-${a.name}-${m.match_date}`),
        league: m.league?.name || m.competition?.name || 'Unknown league',
        date: m.match_date || m.date || new Date().toISOString().slice(0, 10),
        kickoff,
        home: {
          name: h.name || 'Home',
          form: typeof h.form === 'string' ? h.form : Array.isArray(h.form) ? h.form.slice(-5).join('') : null,
          gf5: h.goals_for_last_5 ?? null,
          ga5: h.goals_against_last_5 ?? null,
          xgFor: h.xg ?? h.xg_for ?? null,
          xgAgainst: h.xg_against ?? null,
          injuries: h.injuries || null
        },
        away: {
          name: a.name || 'Away',
          form: typeof a.form === 'string' ? a.form : Array.isArray(a.form) ? a.form.slice(-5).join('') : null,
          gf5: a.goals_for_last_5 ?? null,
          ga5: a.goals_against_last_5 ?? null,
          xgFor: a.xg ?? a.xg_for ?? null,
          xgAgainst: a.xg_against ?? null,
          injuries: a.injuries || null
        },
        odds: Array.isArray(odds) && odds.length ? odds : null,
        h2h: m.h2h || null,
        weather: m.weather || null
      };
    });

    res.json({ fixtures: mapped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fallback: ila ma3ndekch frontend, 3ayet l'API
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Matchday Edge running on port ${PORT}`);
});
