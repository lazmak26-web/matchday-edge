// A match card is a slip: it wins if ANY prediction wins, loses only if ALL lose; a winning slip lists only the winners.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const a = html.indexOf('function slipLegs'), b = html.indexOf('function pickWon');
const { slipLegs, slipVerdict, pickWon } = new Function(html.slice(a, html.indexOf('\n', b)) + '\nreturn { slipLegs, slipVerdict, pickWon };')();

const slip = (hs, as, key, ou, ou15) => ({
  fx: { homeScore: hs, awayScore: as },
  v: {
    main1x2: { sel: key === 'home' ? 'A Win' : key === 'away' ? 'B Win' : 'Draw', key, p: 0.5 },
    mainOU: ou ? { selection: ou + ' 2.5 Goals', p: 0.6 } : null,
    mainOU15: ou15 ? { selection: ou15 + ' 1.5 Goals', p: 0.8 } : null,
  },
});

test('team loses but Over 2.5 wins: slip WINS and lists only the Over 2.5', () => {
  const s = slipVerdict(slip(1, 3, 'home', 'Over', 'Over'));   // away won 1-3: team lost, 4 goals: both overs won
  assert.equal(s.won, true);
  assert.deepEqual(s.shown.map(l => l.kind), ['ou25', 'ou15']);
  const only25 = slipVerdict(slip(0, 3, 'home', 'Over', 'Under'));   // 3 goals: over 2.5 wins, under 1.5 loses, team loses
  assert.equal(only25.won, true); assert.deepEqual(only25.shown.map(l => l.kind), ['ou25']);
});
test('team wins and Over/Under 1.5 wins together: both are listed', () => {
  const s = slipVerdict(slip(2, 0, 'home', 'Over', 'Over'));   // 2 goals: team won, over 1.5 won, over 2.5 lost
  assert.equal(s.won, true); assert.deepEqual(s.shown.map(l => l.kind), ['x12', 'ou15']);
});
test('slip LOSES only when every prediction lost, and then all of them are listed', () => {
  const s = slipVerdict(slip(0, 0, 'home', 'Over', 'Over'));   // 0-0: all three lose
  assert.equal(s.won, false); assert.equal(s.shown.length, 3); assert.ok(s.shown.every(l => !l.won));
  assert.equal(pickWon(slip(0, 0, 'home', 'Over', 'Over')), false);
});
test('one winning prediction is enough', () => {
  assert.equal(pickWon(slip(1, 0, 'away', 'Over', 'Under')), true);   // only Under 1.5 wins (1 goal)
  assert.equal(pickWon(slip(1, 1, 'home', 'Over', 'Over')), true);    // draw: team lost, Over 1.5 wins
});
test('half lines: exactly 2 goals loses Over 2.5 and wins Over 1.5; 1 goal loses Over 1.5', () => {
  const two = slipLegs(slip(1, 1, 'draw', 'Over', 'Over')), one = slipLegs(slip(1, 0, 'draw', 'Over', 'Over'));
  assert.deepEqual(two.map(l => l.won), [true, false, true]);
  assert.deepEqual(one.map(l => l.won), [false, false, false]);
});
test('missing score = no verdict, never counted', () => {
  assert.equal(slipVerdict({ fx: { homeScore: null, awayScore: 1 }, v: slip(0, 0, 'home', 'Over', 'Over').v }), null);
  assert.equal(pickWon({ fx: {}, v: slip(0, 0, 'home').v }), null);
});
test('a pick without O/U legs (old frozen picks) is graded on the team alone', () => {
  assert.equal(pickWon(slip(2, 1, 'home')), true); assert.equal(pickWon(slip(0, 1, 'home')), false);
});
