'use strict';
// Regression tests for the "match list shrinks" bug: two DIFFERENT matches that kick off at the same time were merged into one
// as soon as one team name looked similar (Manchester City / Manchester United, Bristol City / Bristol Rovers, ...).
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../matching');

const mk = (id, home, away, kickoff = '15:00', extra = {}) => Object.assign({
  id, date: '2026-11-07', kickoff, league: 'L', home: { name: home, logo: null }, away: { name: away, logo: null }, odds: [], sources: ['bzz']
}, extra);

test('different matches at the same kick-off are NOT merged', () => {
  const cases = [
    [mk(1, 'Manchester City', 'Everton'), mk(2, 'Manchester United', 'Fulham')],
    [mk(3, 'Bristol City', 'Hull City'), mk(4, 'Bristol Rovers', 'Wigan Athletic')],
    [mk(5, 'Sheffield Wednesday', 'Leeds United'), mk(6, 'Sheffield United', 'Burnley')],
    [mk(7, 'AS Roma', 'Lazio', '19:45'), mk(8, 'Romania', 'Kosovo', '19:45')],
    [mk(9, 'Inter', 'Milan', '19:45'), mk(10, 'Inter Miami', 'Orlando City', '19:45')],
    [mk(11, 'Real Madrid', 'Sevilla', '20:00'), mk(12, 'Real Madrid Castilla', 'Eldense', '20:00')],
    [mk(13, 'Arsenal', 'Chelsea'), mk(14, 'Liverpool', 'Brighton')],
    [mk(15, 'Spain', 'Norway', '20:45'), mk(16, 'Spain U21', 'Norway U21', '20:45')],
    [mk(17, 'Arsenal', 'Chelsea', '12:30'), mk(18, 'Arsenal Women', 'Chelsea Women', '12:30')]
  ];
  for (const [a, b] of cases) assert.strictEqual(m.dedupeFixtures([a, b]).length, 2, `${a.home.name} v ${a.away.name}  /  ${b.home.name} v ${b.away.name}`);
});

test('the same match seen by two sources IS merged (aliases, FC suffixes, accents)', () => {
  const pairs = [
    [mk('bzz_1', 'Man City', 'Everton'), mk('9001', 'Manchester City FC', 'Everton FC')],
    [mk('bzz_2', 'Wolves', 'Brighton'), mk('9002', 'Wolverhampton Wanderers FC', 'Brighton & Hove Albion FC')],
    [mk('bzz_3', 'Paris Saint-Germain', 'Olympique de Marseille'), mk('9003', 'Paris Saint-Germain FC', 'Marseille')],
    [mk('bzz_4', 'Atlético Madrid', 'Real Betis'), mk('9004', 'Club Atlético de Madrid', 'Real Betis Balompié')],
    [mk('bzz_5', 'Bayern München', 'Dortmund'), mk('9005', 'FC Bayern München', 'Borussia Dortmund')]
  ];
  for (const [a, b] of pairs) assert.strictEqual(m.dedupeFixtures([a, b]).length, 1, `${a.home.name} v ${a.away.name}`);
});

test('a team cannot play twice at once: one exactly-equal team is enough, even if the other name is spelled differently', () => {
  assert.ok(m.sameMatch(mk(1, 'Everton', 'Man City'), mk(2, 'Everton FC', 'Manchester City FC')));
  assert.ok(m.sameMatch(mk(1, 'Chelsea', 'Nott\'m Forest'), mk(2, 'Chelsea FC', 'Nottingham Forest FC')));
});

test('same pairing but kick-off more than 15 minutes apart is not the same match', () => {
  assert.ok(!m.sameMatch(mk(1, 'Arsenal', 'Chelsea', '15:00'), mk(2, 'Arsenal', 'Chelsea', '15:20')));
  assert.ok(m.sameMatch(mk(1, 'Arsenal', 'Chelsea', '15:00'), mk(2, 'Arsenal', 'Chelsea', '15:10')));
});

test('merged fixture keeps the Bzzoiro id and the union of odds + logos, whichever side had more data', () => {
  const bzz = mk('bzz_77', 'Man City', 'Everton', '15:00', { odds: [{ book: 'Bzzoiro', home: 1.5, draw: 4, away: 6 }] });
  const fd = mk('4242', 'Manchester City FC', 'Everton FC', '15:00', {
    sources: ['fd', 'bzz'], odds: [{ book: 'Pinnacle', home: 1.52, draw: 4.1, away: 6.2 }, { book: 'bet365', home: 1.5, draw: 4, away: 6.5 }],
    home: { name: 'Manchester City FC', logo: 'h.png' }, away: { name: 'Everton FC', logo: 'a.png' }
  });
  for (const order of [[bzz, fd], [fd, bzz]]) {
    const out = m.dedupeFixtures(order);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'bzz_77', 'id must not flip depending on which side has more logos');
    assert.strictEqual(out[0].odds.length, 3);
    assert.strictEqual(out[0].home.logo, 'h.png');
  }
});

test('normalizeTeamKey: odds keys agree across sources (accents, "&", hyphens, FC suffix)', () => {
  assert.strictEqual(m.normalizeTeamKey('Brighton & Hove Albion FC', 'Brentford FC'), m.normalizeTeamKey('Brighton & Hove Albion', 'Brentford'));
  assert.strictEqual(m.normalizeTeamKey('Paris Saint-Germain FC', 'Olympique de Marseille'), m.normalizeTeamKey('Paris Saint-Germain', 'Marseille'));
  assert.strictEqual(m.normalizeTeamKey('Man Utd', 'Spurs'), m.normalizeTeamKey('Manchester United FC', 'Tottenham Hotspur FC'));
  assert.notStrictEqual(m.normalizeTeamKey('Manchester City', 'X'), m.normalizeTeamKey('Manchester United', 'X'));
});

test('teamsFuzzyMatch / teamsLooseMatch never equate senior, women and youth sides', () => {
  assert.ok(!m.teamsMatchAny('Arsenal', 'Arsenal Women'));
  assert.ok(!m.teamsMatchAny('Barcelona', 'Barcelona B'));
  assert.ok(!m.teamsMatchAny('France', 'France U21'));
  assert.ok(m.teamsMatchAny('Deportivo de A Coruña', 'RC Deportivo La Coruña'));
});

test('dedupeFixtures stays fast on 60 days of history and matches the all-pairs result', () => {
  const teams = ['Real Madrid', 'Barcelona', 'Arsenal', 'Chelsea', 'Liverpool', 'Manchester City', 'Juventus', 'Inter', 'Napoli', 'Roma'];
  const list = [];
  for (let d = 0; d < 60; d++) for (let i = 0; i < 100; i++) {
    const date = new Date(Date.UTC(2026, 8, 1) + d * 86400000).toISOString().slice(0, 10), kickoff = String(12 + (i % 10)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00');
    const f = { id: `bzz_${d}_${i}`, date, kickoff, league: 'L', home: { name: teams[i % 10] + ' ' + i, logo: null }, away: { name: teams[(i + 3) % 10] + ' ' + i, logo: null }, odds: [] };
    list.push(f);
    if (i % 7 === 0) list.push(Object.assign({}, f, { id: `fd_${d}_${i}`, kickoff: kickoff.slice(0, 3) + (i % 2 ? '40' : '10'), odds: [{ book: 'X', home: 2, draw: 3, away: 4 }] }));   // same match from a 2nd source
  }
  const naive = arr => {   // the original all-pairs algorithm
    const out = [];
    for (const f of arr) {
      const i = out.findIndex(r => m.sameMatch(r, f));
      if (i < 0) { out.push(f); continue; }
      const r = out[i], keep = m.fixtureQuality(f) > m.fixtureQuality(r) ? f : r, other = keep === f ? r : f, bz = x => String(x.id).startsWith('bzz_');
      const seen = new Set((keep.odds || []).map(o => String(o.book).toLowerCase()));
      out[i] = Object.assign({}, keep, { id: bz(keep) ? keep.id : bz(other) ? other.id : keep.id, odds: (keep.odds || []).concat((other.odds || []).filter(o => o && !seen.has(String(o.book).toLowerCase()))),
        home: Object.assign({}, keep.home, { logo: keep.home.logo || other.home.logo || null }), away: Object.assign({}, keep.away, { logo: keep.away.logo || other.away.logo || null }) });
    }
    return out;
  };
  const t0 = Date.now(), fast = m.dedupeFixtures(list), ms = Date.now() - t0;
  assert.ok(ms < 3000, `dedupe of ${list.length} fixtures took ${ms} ms`);
  assert.deepStrictEqual(m.dedupeFixtures(list.slice(0, 1500)), naive(list.slice(0, 1500)));
});
