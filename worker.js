// Cloudflare Worker — Matchday Edge proxy
// Kayjib fixtures dyal l'yom mn footballdata.io w kaymappiha l'schema dyal l'site.

const API_BASE = 'https://footballdata.io/api/v1';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

async function fetchFixtures(env) {
  const res = await fetch(`${API_BASE}/fixtures/today?limit=50`, {
    headers: { Authorization: `Bearer ${env.FOOTBALL_DATA_API_KEY}` }
  });
  if (!res.ok) throw new Error(`footballdata.io: ${res.status} ${res.statusText}`);
  const json = await res.json();
  return json.data || [];
}

function mapForm(t) {
  if (!t) return null;
  if (typeof t.form === 'string') return t.form;
  if (Array.isArray(t.form)) return t.form.slice(-5).join('');
  return null;
}

function mapMatch(m) {
  const h = m.home_team || m.home || {};
  const a = m.away_team || m.away || {};
  const kickoff = (m.kickoff_time || m.time || '')
    .toString().slice(0, 5) || 'N/A';

  // Kay7awel yjbed odds ila kanou f l'fixture (free tier 3adatan ma kaynch)
  const odds = m.odds || m.bookmakers || null;

  return {
    id: String(m.match_id || m.id || `${h.name}-${a.name}-${m.match_date}`),
    league: m.league?.name || m.competition?.name || 'Unknown league',
    date: m.match_date || m.date || new Date().toISOString().slice(0, 10),
    kickoff: kickoff,
    home: {
      name: h.name || 'Home',
      form: mapForm(h),
      gf5: h.goals_for_last_5 ?? null,
      ga5: h.goals_against_last_5 ?? null,
      xgFor: h.xg ?? h.xg_for ?? null,
      xgAgainst: h.xg_against ?? null,
      injuries: h.injuries || null
    },
    away: {
      name: a.name || 'Away',
      form: mapForm(a),
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
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    try {
      const fixtures = await fetchFixtures(env);
      const mapped = fixtures.map(mapMatch);
      return new Response(JSON.stringify({ fixtures: mapped }), {
        headers: cors()
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: cors()
      });
    }
  }
};
