'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MAX_LIVE_MS, normalizeStatus, pickBetterStatus, expireStaleLive, mergeEvents } = require('../status');

const H = 60 * 60 * 1000, MIN = 60 * 1000, NOW = Date.parse('2026-11-08T18:35:00Z');
const ko = msAgo => new Date(NOW - msAgo).toISOString();

test('provider statuses map to our four states', () => {
  assert.strictEqual(normalizeStatus('finished', ko(2 * H), NOW), 'finished');
  assert.strictEqual(normalizeStatus('FT', ko(2 * H), NOW), 'finished');
  assert.strictEqual(normalizeStatus('inprogress', ko(30 * MIN), NOW), 'started');
  assert.strictEqual(normalizeStatus('1st half', ko(30 * MIN), NOW), 'started');
  assert.strictEqual(normalizeStatus('notstarted', ko(-H), NOW), 'notstarted');
  assert.strictEqual(normalizeStatus('postponed', ko(2 * H), NOW), 'canceled');
});

test('a feed that still says "live" 3.5h+ after kick-off is stuck: the match is finished (the Viking v KFUM bug)', () => {
  assert.strictEqual(normalizeStatus('inprogress', ko(MAX_LIVE_MS - MIN), NOW), 'started');
  assert.strictEqual(normalizeStatus('inprogress', ko(MAX_LIVE_MS + MIN), NOW), 'finished');
  assert.strictEqual(normalizeStatus('live', ko(5 * H), NOW), 'finished');
  assert.strictEqual(normalizeStatus('some-new-status', ko(5 * H), NOW), 'finished');
});

test('no status: decided from the clock', () => {
  assert.strictEqual(normalizeStatus('', ko(-H), NOW), 'notstarted');
  assert.strictEqual(normalizeStatus('', ko(5 * MIN), NOW), 'notstarted');
  assert.strictEqual(normalizeStatus('', ko(30 * MIN), NOW), 'started');
  assert.strictEqual(normalizeStatus('', ko(4 * H), NOW), 'finished');
  assert.strictEqual(normalizeStatus('live', null, NOW), 'started');       // no kick-off known: trust the feed
  assert.strictEqual(normalizeStatus('inprogress', 'garbage', NOW), 'started');
});

test('pickBetterStatus prefers the most advanced state', () => {
  assert.strictEqual(pickBetterStatus('started', 'finished'), 'finished');
  assert.strictEqual(pickBetterStatus('notstarted', 'started'), 'started');
});

test('expireStaleLive: a "started" copy long after kick-off becomes finished with an UNKNOWN score, never 0-0', () => {
  const fx = (agoMs, extra) => Object.assign({ date: new Date(NOW - agoMs).toISOString().slice(0, 10), kickoff: new Date(NOW - agoMs).toISOString().slice(11, 16), status: 'started', homeScore: 0, awayScore: 0 }, extra);
  const stale = fx(4.5 * H);
  assert.strictEqual(expireStaleLive(stale, NOW), true);
  assert.deepStrictEqual([stale.status, stale.homeScore, stale.awayScore, stale.resultPending], ['finished', null, null, true]);
  const live = fx(1 * H);
  assert.strictEqual(expireStaleLive(live, NOW), false);
  assert.deepStrictEqual([live.status, live.homeScore], ['started', 0]);
  const done = fx(6 * H, { status: 'finished', homeScore: 2, awayScore: 1 });
  assert.strictEqual(expireStaleLive(done, NOW), false);          // a real final score is never touched
  assert.deepStrictEqual([done.homeScore, done.awayScore], [2, 1]);
  assert.strictEqual(expireStaleLive({ status: 'started', date: 'x', kickoff: 'y' }, NOW), false);   // unparseable kick-off: leave alone
});

test('mergeEvents: fresh events replace old ones by id, matches only in the old list are kept', () => {
  const known = [{ id: 1, status: 'inprogress', home_score: 0 }, { id: 2, status: 'notstarted' }, { id: 3, status: 'notstarted' }];
  const fresh = [{ id: 1, status: 'finished', home_score: 2 }, { id: 4, status: 'notstarted' }];
  const out = mergeEvents(known, fresh);
  assert.deepStrictEqual(out.map(e => e.id).sort(), [1, 2, 3, 4]);
  assert.strictEqual(out.find(e => e.id === 1).status, 'finished');
  assert.strictEqual(out.find(e => e.id === 1).home_score, 2);
  assert.deepStrictEqual(mergeEvents(null, null), []);
});
