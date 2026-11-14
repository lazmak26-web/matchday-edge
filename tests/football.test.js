const { test } = require('node:test');
const assert = require('node:assert');
const fb = require('../football');

const standings = {
  area: { name: 'England', flag: 'https://crests.football-data.org/770.svg' },
  competition: { code: 'PL', name: 'Premier League', emblem: 'https://crests.football-data.org/PL.png' },
  season: { startDate: '2026-08-15', endDate: '2027-05-23', currentMatchday: 12 },
  standings: [
    { stage: 'REGULAR_SEASON', type: 'TOTAL', group: null, table: [
      { position: 1, team: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS', crest: 'https://crests.football-data.org/57.png' },
        playedGames: 11, form: 'W,W,D,W,L', won: 8, draw: 2, lost: 1, points: 26, goalsFor: 22, goalsAgainst: 7, goalDifference: 15 },
      { position: 2, team: { id: 65, name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI', crest: 'javascript:alert(1)' },
        playedGames: 11, form: null, won: 7, draw: 2, lost: 2, points: 23, goalsFor: 24, goalsAgainst: 10, goalDifference: 14 }
    ] },
    { stage: 'REGULAR_SEASON', type: 'HOME', table: [{ position: 1, team: { id: 57, name: 'Arsenal FC' } }] }
  ]
};

test('parseStandings keeps only TOTAL tables and normalises rows', () => {
  const t = fb.parseStandings(standings);
  assert.equal(t.code, 'PL');
  assert.equal(t.season.matchday, 12);
  assert.equal(t.groups.length, 1);
  const [a, c] = t.groups[0].rows;
  assert.deepEqual([a.pos, a.team.short, a.pts, a.gd, a.p], [1, 'Arsenal', 26, 15, 11]);
  assert.deepEqual(a.form, ['W', 'W', 'D', 'W', 'L']);
  assert.deepEqual(c.form, []);
  assert.equal(c.team.crest, null, 'non-https crest URLs are dropped');
});

test('parseStandings handles group tables and empty input', () => {
  const t = fb.parseStandings({ standings: [
    { type: 'TOTAL', group: 'GROUP_A', table: [{ position: 1, team: { id: 1, name: 'A' }, points: 3 }] },
    { type: 'TOTAL', group: 'GROUP_B', table: [{ position: 1, team: { id: 2, name: 'B' }, points: 1 }] }
  ] });
  assert.deepEqual(t.groups.map(g => g.name), ['Group A', 'Group B']);
  assert.deepEqual(fb.parseStandings(null).groups, []);
});

test('parseScorers', () => {
  const s = fb.parseScorers({ competition: { code: 'PL', name: 'Premier League' }, scorers: [
    { player: { id: 1, name: 'Erling Haaland', nationality: 'Norway' }, team: { id: 65, name: 'Manchester City FC', shortName: 'Man City' }, goals: 14, assists: 2, penalties: 3, playedMatches: 11 },
    { player: { id: 2, name: '' }, goals: 5 }
  ] });
  assert.equal(s.scorers.length, 1);
  assert.deepEqual([s.scorers[0].player.name, s.scorers[0].goals, s.scorers[0].team.short], ['Erling Haaland', 14, 'Man City']);
});

test('parseTeam groups the squad, computes ages and filters links', () => {
  const t = fb.parseTeam({
    id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS', crest: 'https://crests.football-data.org/57.png',
    founded: 1886, venue: 'Emirates Stadium', clubColors: 'Red / White', website: 'javascript:alert(1)',
    area: { name: 'England' }, coach: { name: 'Mikel Arteta', nationality: 'Spain' },
    runningCompetitions: [{ code: 'PL', name: 'Premier League', emblem: 'https://crests.football-data.org/PL.png' }],
    squad: [
      { id: 1, name: 'David Raya', position: 'Goalkeeper', dateOfBirth: '1995-09-15', nationality: 'Spain' },
      { id: 2, name: 'Bukayo Saka', position: 'Right Winger', dateOfBirth: '2001-09-05', nationality: 'England' },
      { id: 3, name: 'William Saliba', position: 'Centre-Back', dateOfBirth: '2001-03-24', nationality: 'France' },
      { id: 4, name: 'Declan Rice', position: 'Defensive Midfield', dateOfBirth: '1999-01-14', nationality: 'England' }
    ]
  }, Date.parse('2026-11-14'));
  assert.deepEqual(t.squad.map(g => g.name), ['Goalkeeper', 'Defence', 'Midfield', 'Offence']);
  assert.equal(t.squadSize, 4);
  assert.equal(t.squad[0].players[0].age, 31);
  assert.equal(t.website, null);
  assert.equal(t.coach.name, 'Mikel Arteta');
  assert.equal(fb.parseTeam(null), null);
});

test('summary works before and after the table is loaded', () => {
  const pl = fb.LEAGUES.find(l => l.code === 'PL');
  assert.equal(fb.summary(pl, null).ready, false);
  const s = fb.summary(pl, fb.parseStandings(standings));
  assert.deepEqual([s.ready, s.teams, s.leader.name, s.leader.pts], [true, 2, 'Arsenal', 26]);
});

test('league list is the free-plan set, unique codes', () => {
  assert.equal(fb.LEAGUES.length, fb.LEAGUE_CODES.size);
  for (const c of ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL']) assert.ok(fb.LEAGUE_CODES.has(c));
});
