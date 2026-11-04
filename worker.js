// Cloudflare Worker — Matchday Edge proxy
// Kayjib fixtures dyal l'yom mn footballdata.io w kaymappiha l'schema dyal l'site.

const API_BASE = 'https://footballdata.io/api/v1';

// ALLOWED_ORIGINS (Worker variable, comma-separated), e.g. "https://your-site.com,https://www.your-site.com".
// Only these origins get CORS headers and may use the proxy, so nobody else burns the footballdata.io quota from a browser.
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers });

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
    const allowed = allowedOrigins(env);
    const origin = request.headers.get('Origin') || '';
    // No ALLOWED_ORIGINS configured, or an origin that is not on the list => refused (fail closed).
    if (!allowed.length || !allowed.includes(origin)) {
      return json({ error: 'Forbidden' }, 403, { 'Content-Type': 'application/json', 'Vary': 'Origin' });
    }
    const headers = cors(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, headers);

    try {
      const fixtures = await fetchFixtures(env);
      return json({ fixtures: fixtures.map(mapMatch) }, 200, headers);
    } catch (e) {
      console.error(e.message);
      return json({ error: 'Upstream error' }, 502, headers);   // never leak upstream details to the browser
    }
  }
};
