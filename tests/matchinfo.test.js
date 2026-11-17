'use strict';
// Match info panel: pure parsers + getMatchInfo() end-to-end against a local mock of API-Football.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

let srv, calls = [];
const KO = new Date(Date.now() + 30 * 60e3);              // kick-off in 30 min: inside the line-up window
const DAY = KO.toISOString().slice(0, 10);
const P = (id, name, number, pos, grid) => ({ player: { id, name, number, pos, grid } });
const XI = (base, n = 11) => Array.from({ length: n }, (_, i) => P(base + i, 'Player ' + (base + i), i + 1, i === 0 ? 'G' : i < 5 ? 'D' : i < 8 ? 'M' : 'F', i === 0 ? '1:1' : i < 5 ? `2:${i}` : i < 8 ? `3:${i - 4}` : `4:${i - 7}`));
const fxRow = (id, h, a, date, extra = {}) => Object.assign({
  fixture: { id, date, status: { short: extra.short || 'NS' }, venue: { name: 'Stadionul Ilie Oană' }, referee: 'I. Kovacs' },
  league: { id: 667, season: 2026, name: 'Friendlies Clubs', country: 'World', round: 'Club Friendlies 3' },
  teams: { home: { id: h[0], name: h[1], logo: 'https://media.api-sports.io/football/teams/1.png' }, away: { id: a[0], name: a[1], logo: 'https://media.api-sports.io/football/teams/2.png' } },
  goals: extra.goals || { home: null, away: null }, score: {}
}, extra.raw || {});
const ROUTES = {
  [`/fixtures?date=${DAY}`]: () => ({ response: [fxRow(900, [10, 'Chindia Targoviste'], [20, 'FCSB'], KO.toISOString()), fxRow(901, [30, 'X'], [40, 'Y'], KO.toISOString())] }),
  '/fixtures?id=900': () => ({ response: [Object.assign(fxRow(900, [10, 'Chindia Targoviste'], [20, 'FCSB'], KO.toISOString()), { lineups: [
    { team: { id: 10 }, formation: '4-3-3', coach: { name: 'Coach H' }, startXI: XI(100), substitutes: XI(200, 3) },
    { team: { id: 20 }, formation: '4-2-3-1', coach: { name: 'Coach A' }, startXI: XI(300), substitutes: [] }
  ] })] }),
  '/injuries?fixture=900': () => ({ response: [
    { player: { id: 301, name: 'Star Striker', type: 'Missing Fixture', reason: 'Knee Injury' }, team: { id: 20 } },
    { player: { id: 302, name: 'Wing Back', type: 'Questionable', reason: 'Knock' }, team: { id: 20 } },
    { player: { id: 302, name: 'Wing Back', type: 'Questionable', reason: 'Knock' }, team: { id: 20 } }
  ] }),
  '/fixtures/headtohead?h2h=10-20&last=10': () => ({ response: [
    fxRow(1, [10, 'Chindia'], [20, 'FCSB'], '2024-03-01T18:00:00Z', { short: 'FT', goals: { home: 1, away: 2 } }),
    fxRow(2, [20, 'FCSB'], [10, 'Chindia'], '2023-10-01T18:00:00Z', { short: 'FT', goals: { home: 0, away: 1 } }),   // Chindia won away
    fxRow(3, [20, 'FCSB'], [10, 'Chindia'], '2023-05-01T18:00:00Z', { short: 'FT', goals: { home: 2, away: 2 } }),
    fxRow(4, [10, 'Chindia'], [20, 'FCSB'], '2026-12-01T18:00:00Z', { short: 'NS' })                              // not played: ignored
  ] }),
  '/leagues?team=10&current=true': () => ({ response: [{ league: { id: 284, name: 'Liga II', type: 'League' }, seasons: [{ year: 2026, current: true }] }, { league: { id: 285, name: 'Cupa Romaniei', type: 'Cup' }, seasons: [{ year: 2026, current: true }] }] }),
  '/leagues?team=20&current=true': () => ({ response: [{ league: { id: 283, name: 'Liga I', type: 'League' }, seasons: [{ year: 2026, current: true }] }] }),
  '/standings?league=283&season=2026': () => ({ response: [{ league: { name: 'Liga I', country: 'Romania', season: 2026, standings: [[
    { rank: 1, team: { id: 20, name: 'FCSB' }, points: 40, goalsDiff: 20, form: 'WWDWW', all: { played: 17, win: 12, draw: 4, lose: 1, goals: { for: 35, against: 15 } } },
    { rank: 2, team: { id: 21, name: 'CFR' }, points: 35, goalsDiff: 10, form: 'WLWDW', all: { played: 17, win: 10, draw: 5, lose: 2, goals: { for: 30, against: 20 } } }
  ]] } }] }),
  '/standings?league=284&season=2026': () => ({ response: [{ league: { name: 'Liga II', country: 'Romania', season: 2026, standings: [[
    { rank: 4, team: { id: 10, name: 'Chindia' }, points: 28, goalsDiff: 6, form: 'LWWDW', all: { played: 15, win: 8, draw: 4, lose: 3, goals: { for: 22, against: 16 } } }
  ]] } }] }),
  '/fixtures?team=10&last=2': () => ({ response: [fxRow(800, [10, 'Chindia'], [50, 'Otelul'], new Date(Date.now() - 4 * 864e5).toISOString(), { short: 'FT' })] }),
  '/fixtures?team=20&last=2': () => ({ response: [fxRow(801, [60, 'Rapid'], [20, 'FCSB'], new Date(Date.now() - 3 * 864e5).toISOString(), { short: 'FT' })] }),
  '/fixtures/lineups?fixture=800': () => ({ response: [{ team: { id: 10 }, formation: '4-3-3', startXI: XI(100) }] }),                         // same XI
  '/fixtures/lineups?fixture=801': () => ({ response: [{ team: { id: 20 }, formation: '4-2-3-1', startXI: XI(300, 6).concat(XI(400, 5)) }] })  // 5 changes now
};

let af, mi;
before(async () => {
  srv = http.createServer((req, res) => {
    calls.push(req.url);
    const f = ROUTES[req.url];
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-ratelimit-requests-remaining', '80');
    res.end(JSON.stringify(f ? f() : { response: [] }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.NODE_ENV = 'test';
  process.env.APIFOOTBALL_KEY = 'test-key';
  process.env.APIFOOTBALL_BASE = 'http://127.0.0.1:' + srv.address().port;
  delete require.cache[require.resolve('../apifootball')]; delete require.cache[require.resolve('../matchinfo')];
  af = require('../apifootball'); mi = require('../matchinfo');
});
after(() => { srv.close(); delete process.env.APIFOOTBALL_KEY; delete process.env.APIFOOTBALL_BASE; });

const { teamsMatchAny } = require('../matching');
const fx = { id: 'bzz_1', date: DAY, kickoff: KO.toISOString().slice(11, 16), status: 'notstarted', home: { name: 'Chindia Târgoviște', logo: null }, away: { name: 'FCSB', logo: null } };

test('parseH2H counts from the CURRENT home team, whatever the venue', () => {
  const h = mi.parseH2H(ROUTES['/fixtures/headtohead?h2h=10-20&last=10']().response, 10, 20);
  assert.deepStrictEqual([h.total, h.homeWins, h.draws, h.awayWins, h.homeGoals, h.awayGoals], [3, 1, 1, 1, 4, 4]);
  assert.strictEqual(h.last[0].date, '2024-03-01');
  assert.ok(!('homeId' in h.last[0]) && !('ts' in h.last[0]));
});

test('parseInjuries dedupes and sorts OUT before DOUBT', () => {
  const m = mi.parseInjuries(ROUTES['/injuries?fixture=900']().response);
  assert.deepStrictEqual(m.get('20').map(a => a.type), ['out', 'doubt']);
});

test('strength verdicts', () => {
  assert.strictEqual(mi.strength([], { count: 0 }, true).level, 'full');
  assert.strictEqual(mi.strength([{ type: 'out' }], null, false).level, 'mostly');
  assert.strictEqual(mi.strength([{ type: 'out' }, { type: 'out' }, { type: 'out' }], null, false).level, 'weakened');
  assert.strictEqual(mi.strength([], { count: 5 }, true).level, 'rotated');
  assert.strictEqual(mi.strength(null, null, false).level, 'unknown');
});

test('pickTeamLeague skips cups and friendlies', () => {
  assert.deepStrictEqual(mi.pickTeamLeague(ROUTES['/leagues?team=10&current=true']().response), { id: 284, season: 2026 });
  assert.strictEqual(mi.pickTeamLeague([{ league: { id: 1, name: 'Club Friendlies', type: 'League' }, seasons: [{ year: 2026, current: true }] }]), null);
});

test('getMatchInfo: friendly resolved by names, line-ups, absences, h2h, domestic tables, changes vs last match', async () => {
  const d = await mi.getMatchInfo(fx, { match: teamsMatchAny });
  assert.strictEqual(d.found, true);
  assert.strictEqual(d.lineups.status, 'confirmed');
  assert.strictEqual(d.lineups.home.formation, '4-3-3');
  assert.strictEqual(d.lineups.home.xi.length, 11);
  assert.strictEqual(d.lineups.home.subs.length, 3);
  assert.strictEqual(d.absences.away.length, 2);
  assert.deepStrictEqual(d.absences.home, []);
  assert.strictEqual(d.h2h.total, 3);
  assert.strictEqual(d.home.standing.rank, 4); assert.strictEqual(d.home.standing.league, 'Liga II');
  assert.strictEqual(d.away.standing.rank, 1); assert.strictEqual(d.away.standing.size, 2);
  assert.strictEqual(d.home.changes.count, 0); assert.strictEqual(d.home.strength.level, 'full');
  assert.strictEqual(d.away.changes.count, 5); assert.strictEqual(d.away.strength.level, 'rotated');
  assert.strictEqual(d.venue, 'Stadionul Ilie Oană');

  const n = calls.length;
  await mi.getMatchInfo(fx, { match: teamsMatchAny });
  assert.strictEqual(calls.length, n, 'second open is served from cache (no API call)');
});

test('far from kick-off: no match line-up call, falls back to a probable XI', async () => {
  const far = new Date(Date.now() + 50 * 3600e3), day = far.toISOString().slice(0, 10);
  ROUTES[`/fixtures?date=${day}`] = () => ({ response: [fxRow(950, [10, 'Chindia Targoviste'], [20, 'FCSB'], far.toISOString())] });
  ROUTES['/injuries?fixture=950'] = () => ({ response: [] });
  const from = calls.length;
  const d = await mi.getMatchInfo(Object.assign({}, fx, { id: 'af_950', date: day, kickoff: far.toISOString().slice(11, 16) }), { match: teamsMatchAny });
  assert.strictEqual(d.found, true);
  assert.strictEqual(d.lineups.status, 'probable', 'shows a probable XI built from the team\'s last real line-up');
  assert.strictEqual(d.lineups.home.xi.length, 11);
  assert.strictEqual(d.lineups.home.probableFrom.vs, 'Otelul');
  assert.ok(d.lineups.home.probableFrom.date);
  assert.ok(!calls.slice(from).includes('/fixtures?id=950'), 'the match\'s own line-up endpoint is not called 50 h before kick-off');
  assert.deepStrictEqual(d.absences.home, []);
});

test('far from kick-off with no prior line-up: says when line-ups come', async () => {
  const far = new Date(Date.now() + 6 * 864e5), day = far.toISOString().slice(0, 10);   // distinct day → own day-feed cache
  ROUTES[`/fixtures?date=${day}`] = () => ({ response: [fxRow(952, [70, 'Newcomer A'], [71, 'Newcomer B'], far.toISOString())] });
  ROUTES['/injuries?fixture=952'] = () => ({ response: [] });
  const d = await mi.getMatchInfo(Object.assign({}, fx, { id: 'af_952', date: day, kickoff: far.toISOString().slice(11, 16), home: { name: 'Newcomer A', logo: null }, away: { name: 'Newcomer B', logo: null } }), { match: teamsMatchAny });
  assert.strictEqual(d.lineups.status, 'not_yet');
  assert.ok(d.lineups.expectedFrom);
});

test('no API line-up but a curated team → projected XI from the seed', async () => {
  const far = new Date(Date.now() + 5 * 864e5), day = far.toISOString().slice(0, 10);
  ROUTES[`/fixtures?date=${day}`] = () => ({ response: [fxRow(960, [5000, 'Argentina'], [5001, 'Random FC'], far.toISOString())] });
  ROUTES['/injuries?fixture=960'] = () => ({ response: [] });
  const d = await mi.getMatchInfo(Object.assign({}, fx, { id: 'af_960', date: day, kickoff: far.toISOString().slice(11, 16), home: { name: 'Argentina', logo: null }, away: { name: 'Random FC', logo: null } }), { match: teamsMatchAny });
  assert.strictEqual(d.lineups.status, 'projected');
  assert.strictEqual(d.lineups.home.formation, '4-3-3');
  assert.strictEqual(d.lineups.home.xi.length, 11);
  assert.strictEqual(d.lineups.home.projectedFrom.editorial, true);
});

test('dump/load round-trips the Map-based line-ups', () => {
  const arr = JSON.parse(JSON.stringify(mi.dump()));
  mi._cache.clear();
  assert.ok(mi.load(arr) > 0);
  const det = mi._cache.get('fx:900');
  assert.ok(det && det.data.lineups instanceof Map && det.data.lineups.get('10').xi.length === 11);
});
