'use strict';
// The Odds API (https://the-odds-api.com) as a SECOND odds source, so the consensus and line shopping use many real books (Pinnacle included).
//
// Credit protection (free plan = 500 credits/month; cost = markets x regions per call):
//   - ONE call per league (sport key) returns every upcoming event of that league -> never one call per match.
//   - only h2h (1X2) and one region ("eu" has Pinnacle) => 1 credit per call.
//   - only leagues that really have a not-started match today are fetched, and each league is cached ODDS_API_TTL_H hours.
//   - hard daily cap (ODDS_API_MAX_CALLS_PER_DAY) and a reserve: stops when the provider says fewer than ODDS_API_RESERVE credits remain.
//   - no key => the module does nothing (no error, the rest of the app is unchanged).
const KEY = process.env.ODDS_API_KEY;
const REGIONS = process.env.ODDS_API_REGIONS || 'eu';
const TTL = Math.max(1, parseFloat(process.env.ODDS_API_TTL_H) || 6) * 3600 * 1000;
const MAX_DAY = parseInt(process.env.ODDS_API_MAX_CALLS_PER_DAY, 10) || 10;
const RESERVE = parseInt(process.env.ODDS_API_RESERVE, 10) || 25;
const BASE = 'https://api.the-odds-api.com/v4';

// League name (as shown by our fixtures) -> Odds API sport key. Unknown leagues are skipped (no credit spent).
const LEAGUES = [
  [/premier league.*(eng|england)|^premier league$|english premier/i, 'soccer_epl'],
  [/championship/i, 'soccer_efl_champ'], [/la ?liga(?!.*2)|primera divisi[oó]n/i, 'soccer_spain_la_liga'],
  [/serie a/i, 'soccer_italy_serie_a'], [/bundesliga(?!.*2)/i, 'soccer_germany_bundesliga'], [/ligue 1/i, 'soccer_france_ligue_one'],
  [/eredivisie/i, 'soccer_netherlands_eredivisie'], [/primeira liga|liga portugal/i, 'soccer_portugal_primeira_liga'],
  [/champions league/i, 'soccer_uefa_champs_league'], [/europa league/i, 'soccer_uefa_europa_league'], [/conference league/i, 'soccer_uefa_europa_conference_league'],
  [/pro league|jupiler/i, 'soccer_belgium_first_div'], [/s[uü]per lig/i, 'soccer_turkey_super_league'], [/brasileir|serie a.*brazil/i, 'soccer_brazil_campeonato'],
  [/\bmls\b|major league soccer/i, 'soccer_usa_mls'], [/world cup/i, 'soccer_fifa_world_cup'], [/libertadores/i, 'soccer_conmebol_copa_libertadores'],
];
const sportKeyOf = league => { for (const [re, k] of LEAGUES) if (re.test(String(league || ''))) return k; return null; };

const cache = new Map();            // sportKey -> { ts, events:[{home,away,commence,books:[{book,home,draw,away}]}] }
const usage = { day: '', calls: 0, remaining: null };
const roll = () => { const d = new Date().toISOString().slice(0, 10); if (usage.day !== d) { usage.day = d; usage.calls = 0; } };

function parseEvents(json) {
  const out = [];
  for (const ev of Array.isArray(json) ? json : []) {
    if (!ev || !ev.home_team || !ev.away_team) continue;
    const books = [];
    for (const bk of ev.bookmakers || []) {
      const m = (bk.markets || []).find(x => x.key === 'h2h');
      if (!m || !Array.isArray(m.outcomes)) continue;
      const price = n => { const o = m.outcomes.find(x => x.name === n); return o && o.price > 1 ? o.price : null; };
      const h = price(ev.home_team), a = price(ev.away_team), d = price('Draw');
      if (h && d && a) books.push({ book: bk.title || bk.key, home: h, draw: d, away: a });
    }
    if (books.length) out.push({ home: ev.home_team, away: ev.away_team, commence: Date.parse(ev.commence_time), books });
  }
  return out;
}

async function fetchSport(sportKey) {
  const url = `${BASE}/sports/${sportKey}/odds/?apiKey=${encodeURIComponent(KEY)}&regions=${encodeURIComponent(REGIONS)}&markets=h2h&oddsFormat=decimal`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  usage.calls++;
  const rem = parseInt(r.headers.get('x-requests-remaining'), 10);
  if (Number.isFinite(rem)) usage.remaining = rem;
  if (!r.ok) throw new Error('odds-api ' + r.status);
  return parseEvents(await r.json());
}

// fixtures: [{league, status}] -> number of leagues refreshed (0 = nothing changed, no credit spent)
async function refresh(fixtures) {
  if (!KEY) return 0;
  roll();
  const need = new Set();
  for (const f of fixtures || []) { if (f && f.status === 'notstarted') { const k = sportKeyOf(f.league); if (k) need.add(k); } }
  let n = 0;
  for (const k of need) {
    const c = cache.get(k);
    if (c && Date.now() - c.ts < TTL) continue;
    if (usage.calls >= MAX_DAY) { console.log('odds-api: daily call cap reached'); break; }
    if (usage.remaining != null && usage.remaining <= RESERVE) { console.log('odds-api: credit reserve reached, stopping'); break; }
    try { cache.set(k, { ts: Date.now(), events: await fetchSport(k) }); n++; }
    catch (e) { console.error(e.message); cache.set(k, { ts: Date.now() - TTL + 10 * 60 * 1000, events: (c && c.events) || [] }); }   // on failure retry in 10 min, keep old data
  }
  return n;
}

// Books for one fixture. `same(a,b)` = the app's fuzzy team-name matcher. BOTH teams must match, so a wrong match cannot mix prices.
function booksFor(home, away, same) {
  if (!KEY) return [];
  for (const { events } of cache.values()) for (const e of events) if (same(home, e.home) && same(away, e.away)) return e.books;
  return [];
}
const status = () => ({ enabled: !!KEY, callsToday: usage.calls, maxPerDay: MAX_DAY, creditsRemaining: usage.remaining, leaguesCached: cache.size });

module.exports = { refresh, booksFor, sportKeyOf, parseEvents, status };
