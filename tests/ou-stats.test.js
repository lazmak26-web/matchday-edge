'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { actualOu, summarize } = require('../engine/ou-stats');

let n = 0;
const row = (date, hs, as, ou, extra = {}) => Object.assign({ id: 'r' + (++n), date, kickoff: '15:00', status: 'finished', homeScore: hs, awayScore: as, pick: ou === undefined ? null : { key: 'home', p: 0.5, ou } }, extra);

test('actualOu: 3+ goals is over, 2 or fewer is under, no score is null', () => {
  assert.strictEqual(actualOu({ homeScore: 2, awayScore: 1 }), 'over');
  assert.strictEqual(actualOu({ homeScore: 1, awayScore: 1 }), 'under');
  assert.strictEqual(actualOu({ homeScore: 0, awayScore: 0 }), 'under');
  assert.strictEqual(actualOu({ homeScore: 4, awayScore: 0 }), 'over');
  assert.strictEqual(actualOu({ homeScore: null, awayScore: 1 }), null);
  assert.strictEqual(actualOu({ homeScore: '2', awayScore: 1 }), null);
  assert.strictEqual(actualOu({ homeScore: -1, awayScore: 2 }), null);
  assert.strictEqual(actualOu(null), null);
});

test('wins, losses, win rate, and the split by Over picks / Under picks', () => {
  const rows = [
    row('2026-11-01', 2, 1, 'over'),   // win  (3 goals)
    row('2026-11-01', 1, 0, 'over'),   // loss (1 goal)
    row('2026-11-02', 0, 0, 'under'),  // win
    row('2026-11-02', 3, 2, 'under'),  // loss
    row('2026-11-03', 1, 1, 'under'),  // win
    row('2026-11-03', 2, 2, 'over')    // win
  ];
  const s = summarize(rows);
  assert.deepStrictEqual([s.overall.n, s.overall.wins, s.overall.losses], [6, 4, 2]);
  assert.ok(Math.abs(s.overall.winRate - 4 / 6) < 1e-12);
  assert.deepStrictEqual([s.over.n, s.over.wins, s.over.losses], [3, 2, 1]);
  assert.deepStrictEqual([s.under.n, s.under.wins, s.under.losses], [3, 2, 1]);
  assert.deepStrictEqual(s.byDay, [{ date: '2026-11-01', wins: 1, losses: 1 }, { date: '2026-11-02', wins: 1, losses: 1 }, { date: '2026-11-03', wins: 2, losses: 0 }]);
});

test('only finished matches with a real score AND a frozen O/U pick are counted; coverage says how many were skipped', () => {
  const rows = [
    row('2026-11-01', 2, 1, 'over'),
    row('2026-11-01', 2, 1, undefined),                              // finished, no pick (legacy row / no real inputs)
    row('2026-11-01', 2, 1, null, { pick: { key: 'home', p: .5, ou: null } }), // pick without an O/U part
    row('2026-11-01', null, null, 'over'),                            // finished but no score
    row('2026-11-01', 0, 0, 'under', { status: 'started' }),         // not finished
    row('2026-11-01', 0, 0, 'under', { status: 'notstarted' })
  ];
  const s = summarize(rows);
  assert.strictEqual(s.overall.n, 1);
  assert.deepStrictEqual(s.coverage, { finished: 3, counted: 1 });
});

test('nothing to count: win rate is null, never NaN or 0%', () => {
  const s = summarize([]);
  assert.strictEqual(s.overall.n, 0);
  assert.strictEqual(s.overall.winRate, null);
  assert.strictEqual(s.over.winRate, null);
  assert.deepStrictEqual(s.byDay, []);
  assert.doesNotThrow(() => summarize(null));
});

test('since: by match date, inclusive', () => {
  const rows = [row('2026-10-30', 2, 1, 'over'), row('2026-11-01', 2, 1, 'over'), row('2026-11-02', 0, 0, 'over')];
  assert.strictEqual(summarize(rows, { since: '2026-11-01' }).overall.n, 2);
  assert.strictEqual(summarize(rows, { since: '2026-11-02' }).overall.n, 1);
  assert.strictEqual(summarize(rows).overall.n, 3);
});

test('last N: the N most recent matches that had a pick (not the N most recent finished matches)', () => {
  const rows = [
    row('2026-11-01', 2, 1, 'over', { kickoff: '12:00' }),    // oldest, win
    row('2026-11-02', 0, 0, 'over', { kickoff: '12:00' }),    // loss
    row('2026-11-03', 3, 0, undefined, { kickoff: '12:00' }), // newest finished, but no pick: must not use up a slot
    row('2026-11-02', 1, 0, 'under', { kickoff: '18:00' })    // win, most recent counted
  ];
  const s = summarize(rows, { last: 2 });
  assert.deepStrictEqual([s.overall.n, s.overall.wins, s.overall.losses], [2, 1, 1]);
  assert.deepStrictEqual(s.byDay.map(d => d.date), ['2026-11-02']);
  assert.strictEqual(summarize(rows, { last: 10 }).overall.n, 3);
  assert.strictEqual(summarize(rows, { last: 0 }).overall.n, 3, 'last=0 means no limit');
});

test('the goals line is 2.5: exactly 2 goals is Under, exactly 3 is Over', () => {
  assert.strictEqual(summarize([row('2026-11-01', 1, 1, 'under')]).overall.wins, 1);
  assert.strictEqual(summarize([row('2026-11-01', 2, 1, 'over')]).overall.wins, 1);
  assert.strictEqual(summarize([row('2026-11-01', 1, 1, 'over')]).overall.losses, 1);
});
