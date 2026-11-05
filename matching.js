'use strict';
// Team-name matching and match de-duplication for the fixtures pipeline (Bzzoiro + football-data.org).
//
// Why this file exists: the old code treated two matches kicking off at the same time as ONE match as soon as a single team name
// looked "similar" (substring after dropping words like city/united/town). Manchester City vs Everton and Manchester United vs Fulham at
// 15:00 became one fixture, same for Bristol City/Rovers, Sheffield Wednesday/United, Roma/Romania, Real Madrid/Real Madrid Castilla...
// so the list silently lost matches. The rule now is:
//   same match = same kick-off (+-15 min) AND ( one team has EXACTLY the same name (after aliases)  OR  BOTH teams loosely match ).
// A team cannot play two matches at once, so one exactly-equal team is proof; loose similarity alone is only trusted when it holds on both sides.

const TEAM_ALIASES = {
  'manchester united fc': 'manchester united', 'manchester city fc': 'manchester city',
  'arsenal fc': 'arsenal', 'chelsea fc': 'chelsea', 'liverpool fc': 'liverpool',
  'tottenham hotspur fc': 'tottenham hotspur', 'newcastle united fc': 'newcastle united',
  'aston villa fc': 'aston villa', 'west ham united fc': 'west ham united',
  'brighton & hove albion fc': 'brighton and hove albion', 'wolverhampton wanderers fc': 'wolverhampton wanderers',
  'nottingham forest fc': 'nottingham forest', 'crystal palace fc': 'crystal palace',
  'everton fc': 'everton', 'fulham fc': 'fulham', 'brentford fc': 'brentford',
  'afc bournemouth': 'bournemouth', 'leicester city fc': 'leicester city',
  'ipswich town fc': 'ipswich town', 'southampton fc': 'southampton',
  'real madrid cf': 'real madrid', 'fc barcelona': 'barcelona', 'atletico de madrid': 'atletico madrid',
  'sevilla fc': 'sevilla', 'real betis balompie': 'real betis', 'valencia cf': 'valencia',
  'villarreal cf': 'villarreal', 'athletic club': 'athletic bilbao',
  'fc internazionale milano': 'inter milan', 'ac milan': 'ac milan', 'juventus fc': 'juventus',
  'ssc napoli': 'napoli', 'as roma': 'roma', 'ss lazio': 'lazio', 'atalanta bc': 'atalanta',
  'acf fiorentina': 'fiorentina', 'fc bayern munchen': 'bayern munich', 'borussia dortmund': 'borussia dortmund',
  'rb leipzig': 'rb leipzig', 'bayer 04 leverkusen': 'bayer leverkusen', 'eintracht frankfurt': 'eintracht frankfurt',
  'paris saint-germain fc': 'paris saint germain', 'olympique de marseille': 'marseille',
  'olympique lyonnais': 'lyon', 'as monaco': 'monaco', 'losc lille': 'lille',
  'us sassuolo calcio': 'sassuolo', 'torino fc': 'torino', 'como 1907': 'como', 'cagliari calcio': 'cagliari',
  // common short names / nicknames used by one feed but not the other
  'man city': 'manchester city', 'man utd': 'manchester united', 'man united': 'manchester united', 'manchester utd': 'manchester united',
  'spurs': 'tottenham hotspur', 'tottenham': 'tottenham hotspur', 'wolves': 'wolverhampton wanderers',
  'newcastle': 'newcastle united', 'brighton': 'brighton and hove albion', 'west ham': 'west ham united',
  'leeds': 'leeds united', 'leeds united fc': 'leeds united', 'sheffield utd': 'sheffield united', 'west brom': 'west bromwich albion',
  'psg': 'paris saint germain', 'inter': 'inter milan', 'internazionale': 'inter milan', 'bayern': 'bayern munich', 'bayern munchen': 'bayern munich',
  'atletico': 'atletico madrid'
};

// Lower-case, no accents, "&" -> "and", hyphens -> space, other punctuation dropped, single spaces.
// (The old code dropped "&" and "-" BEFORE the alias lookup, so alias keys containing them, e.g. "paris saint-germain fc", never matched.)
const plain = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[-–—]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const ALIASES = new Map(Object.entries(TEAM_ALIASES).map(([k, v]) => [plain(k), plain(v)]));
const normalizeName = s => { const t = plain(s); return ALIASES.get(t) || t; };
const normalizeTeamKey = (home, away) => `${normalizeName(home)}|${normalizeName(away)}`;

// Youth / women / reserve sides ("Spain U21", "Arsenal W", "Barcelona B") are different teams from the senior side.
const SQUAD_RE = /\b(u-?\d{2}|women|w|ii|b|reserves?|youth)\b/g;
function squadKey(name) {
  const m = String(name || '').toLowerCase().match(SQUAD_RE) || [];
  return m.map(x => x.replace('-', '')).map(x => (x === 'w' ? 'women' : x === 'reserve' ? 'reserves' : x === 'ii' ? 'b' : x)).sort().join('+');
}

// Loose similarity. NEVER enough on its own to say two single teams are the same (see samePairing).
function teamsFuzzyMatch(a, b) {
  if (!a || !b) return false;
  if (squadKey(a) !== squadKey(b)) return false;
  const clean = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(fc|ac|as|us|ss|cf|sc|afc|cd|club|calcio|sporting|sport|city|united|town|the|de|la|le|1907|calcio)\b/g, ' ').replace(/[^a-z0-9]/g, '').trim();
  const ca = clean(a), cb = clean(b);
  if (!ca || !cb) return false;
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

// Token-based matching: "Deportivo de A Coruña" == "RC Deportivo La Coruña" (club prefixes / articles / 1-letter words ignored)
const TEAM_STOP = new Set(['fc', 'ac', 'as', 'us', 'ss', 'cf', 'sc', 'afc', 'cd', 'ud', 'sd', 'rc', 'ca', 'cp', 'club', 'de', 'del', 'la', 'le', 'el', 'the', 'calcio', '1907']);
function teamTokens(n) {
  return String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !TEAM_STOP.has(w));
}
function teamsLooseMatch(a, b) {
  if (squadKey(a) !== squadKey(b)) return false;
  const ta = teamTokens(a), tb = teamTokens(b);
  if (!ta.length || !tb.length) return false;
  const sa = new Set(ta), sb = new Set(tb);
  const sub = (x, y) => [...x].every(t => y.has(t)) && [...x].some(t => t.length >= 5 || x.size > 1);
  return sub(sa, sb) || sub(sb, sa);
}
const teamsMatchAny = (a, b) => teamsFuzzyMatch(a, b) || teamsLooseMatch(a, b);

// Exactly the same team once aliases / accents / punctuation are normalised (and the same squad: senior vs U21 vs women).
const strictSame = (a, b) => { const x = normalizeName(a); return !!x && x === normalizeName(b) && squadKey(a) === squadKey(b); };

// Do (home1, away1) and (home2, away2) describe the same fixture? Assumes the kick-off times were already compared.
const samePairing = (h1, a1, h2, a2) => strictSame(h1, h2) || strictSame(a1, a2) || (teamsMatchAny(h1, h2) && teamsMatchAny(a1, a2));

// Same kick-off (+-15 min) and the same pairing => the same match seen through two sources.
function sameMatch(a, b) {
  const ta = Date.parse(a.date + 'T' + (a.kickoff || '00:00') + ':00Z'), tb = Date.parse(b.date + 'T' + (b.kickoff || '00:00') + ':00Z');
  if (isNaN(ta) || isNaN(tb) || Math.abs(ta - tb) > 15 * 60 * 1000) return false;
  return samePairing(a.home.name, a.away.name, b.home.name, b.away.name);
}

function fixtureQuality(f) {
  return (f.home.logo ? 1 : 0) + (f.away.logo ? 1 : 0) + (Array.isArray(f.odds) ? f.odds.length : 0) * 0.5 + (f.sources || []).length
    + (f.home.form ? 1 : 0) + (f.away.form ? 1 : 0) + (f.pick ? 3 : 0) + (/^League #/.test(f.league || '') ? -2 : 0);
}

// Merges real duplicates. The merged fixture keeps the Bzzoiro id when there is one, so its id (and the snapshot / frozen pick stored under it)
// does not flip between "bzz_123" and a football-data id depending on which side happens to have more logos that minute.
function dedupeFixtures(fixtures) {
  const result = [];
  const bzz = x => String(x.id).startsWith('bzz_');
  for (const f of fixtures) {
    const i = result.findIndex(r => sameMatch(r, f));
    if (i < 0) { result.push(f); continue; }
    const r = result[i], keep = fixtureQuality(f) > fixtureQuality(r) ? f : r, other = keep === f ? r : f;
    const seen = new Set((keep.odds || []).map(o => String(o.book).toLowerCase()));
    const odds = (keep.odds || []).concat((other.odds || []).filter(o => o && !seen.has(String(o.book).toLowerCase())));
    result[i] = Object.assign({}, keep, { id: bzz(keep) ? keep.id : bzz(other) ? other.id : keep.id, odds,
      home: Object.assign({}, keep.home, { logo: keep.home.logo || other.home.logo || null }),
      away: Object.assign({}, keep.away, { logo: keep.away.logo || other.away.logo || null }) });
  }
  return result;
}

module.exports = { TEAM_ALIASES, normalizeName, normalizeTeamKey, squadKey, teamsFuzzyMatch, teamsLooseMatch, teamsMatchAny, strictSame, samePairing, sameMatch, fixtureQuality, dedupeFixtures };
