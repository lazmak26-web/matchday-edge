'use strict';
// End-to-end check of the live-status pipeline in the REAL server.js (express, multer, fetch and the clock are faked, so no network, no keys,
// no node_modules needed). Regression for "match finished hours ago but the site still shows LIVE 0-0".
const fs = require('fs'), path = require('path'), Module = require('module');
const test = require('node:test'), assert = require('node:assert');
const ROOT = path.join(__dirname, '..'), DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mde-feed-'));
Object.assign(process.env, { BZZOIRO_API_KEY: 'x', HISTORY_FILE: path.join(DATA, 'history.json'), STATS_FILE: path.join(DATA, 'stats.json'), PORT: '0', BZZ_DAILY_BUDGET: process.env.BZZ_DAILY_BUDGET || '5500' });
delete process.env.FOOTBALL_API_KEY;

// fake clock: starts Sun 2026-11-08 14:30 UTC
const RD = Date; let offset = RD.parse('2026-11-08T14:30:00Z') - RD.now();
global.Date = class extends RD { constructor(...a) { if (a.length === 0) super(RD.now() + offset); else super(...a); } static now() { return RD.now() + offset; } };
const advance = ms => { offset += ms; };

// fake express / multer
const noop = () => {}; const mw = () => (req, res, next) => next && next();
const app = new Proxy(function () {}, { get: (t, k) => k === 'listen' ? (p, cb) => { if (typeof cb === 'function') cb(); return { on() { return this; }, unref() { return this; }, close() {} }; } : () => app, apply: () => app });
const express = Object.assign(() => app, { json: mw, static: mw, urlencoded: mw, Router: () => app });
const multer = Object.assign(() => ({ single: mw, array: mw, any: mw, none: mw }), { diskStorage: () => ({}), memoryStorage: () => ({}), MulterError: class extends Error {} });
const orig = Module._load; Module._load = function (req, ...r) { if (req === 'express') return express; if (req === 'multer') return multer; return orig.call(this, req, ...r); };

// fake provider
let events = [], failPage2 = false, calls = 0;
const mk = (id, h, a, minsAgo, status, hs, as) => ({ id, home_team: h, away_team: a, league_id: 54, event_date: new RD(RD.now() + offset - minsAgo * 60000).toISOString(), status, home_score: hs, away_score: as });
global.fetch = async (url) => {
  url = String(url); calls++;
  if (/\/odds\//.test(url)) return { ok: true, status: 200, json: async () => ({ odds: null }) };
  if (/events\/\?/.test(url)) {
    const u = new URL(url), page = +(u.searchParams.get('page') || 1);
    if (page === 2 && failPage2) return { ok: false, status: 500, json: async () => ({}) };
    const per = 2, slice = events.slice((page - 1) * per, page * per);
    const next = page * per < events.length ? `${u.origin}${u.pathname}?${u.searchParams.has('page') ? '' : u.searchParams.toString() + '&'}page=${page + 1}` : null;
    return { ok: true, status: 200, json: async () => ({ results: slice, next }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
console.log = () => {}; console.error = () => {};   // quiet server logs (restored below)
const realLog = console.log;

const file = path.join(ROOT, 'server.js');
const src = fs.readFileSync(file, 'utf8') + '\nmodule.exports.__t = { getFixtures, refreshHistoryResults, snapshotStore, fixturesCache, eventsCache, historyCache, bzzUsage };';
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(ROOT); m._compile(src, file);
const T = m.exports.__t;


const find = (list, h) => list.find(f => f.home.name === h);
const fresh = () => { T.fixturesCache.data = null; T.eventsCache.ts = 0; T.eventsCache.retryAt = 0; };
const tick = async ms => { advance(ms); fresh(); return T.getFixtures(); };
const score = f => f.homeScore + '-' + f.awayScore;

test('a live match whose feed gets stuck is finished by the clock, with an unknown score (never LIVE for ever, never a made-up 0-0)', async () => {
  events = [mk(1, 'Viking FK', 'KFUM Oslo', 30, 'inprogress', 0, 0), mk(2, 'Bodo', 'Brann', -120, 'notstarted', null, null), mk(3, 'Rosenborg', 'Molde', -180, 'notstarted', null, null), mk(4, 'Lillestrom', 'Tromso', -240, 'notstarted', null, null)];
  let v = find(await tick(0), 'Viking FK');
  assert.deepStrictEqual([v.status, score(v)], ['started', '0-0']);
  failPage2 = true;
  v = find(await tick(2 * 3600000 + 60000), 'Viking FK');
  assert.strictEqual(v.status, 'started');                      // 2.5 h after kick-off: still plausibly live
  v = find(await tick(2 * 3600000), 'Viking FK');               // 4.5 h after kick-off
  assert.deepStrictEqual([v.status, v.homeScore, v.awayScore, v.resultPending], ['finished', null, null, true]);
});

test('when the provider recovers, the real final score replaces the pending one', async () => {
  failPage2 = false; events[0] = mk(1, 'Viking FK', 'KFUM Oslo', 270, 'finished', 2, 1);
  const v = find(await tick(3 * 60000), 'Viking FK');
  assert.deepStrictEqual([v.status, score(v)], ['finished', '2-1']);
  assert.strictEqual(v.resultPending, undefined);
});

test('finished without a score is FINISHED with an unknown score, not "LIVE 0-0"; the score is filled in when it arrives', async () => {
  events = [mk(5, 'Odd', 'Sandefjord', 200, 'finished', null, null)];
  let v = find(await tick(0), 'Odd');
  assert.deepStrictEqual([v.status, v.homeScore, v.awayScore, v.resultPending], ['finished', null, null, true]);
  events = [mk(5, 'Odd', 'Sandefjord', 200, 'finished', 3, 0)];
  v = find(await tick(70000), 'Odd');
  assert.deepStrictEqual([v.status, score(v)], ['finished', '3-0']);
});

test('a failing later page no longer freezes the matches of the pages that did load', async () => {
  events = [mk(6, 'Aalesund', 'Hamkam', 60, 'inprogress', 0, 0), mk(7, 'Fredrikstad', 'Kristiansund', 60, 'inprogress', 0, 0), mk(8, 'Valerenga', 'Sarpsborg', 60, 'inprogress', 0, 0)];
  await tick(0);
  events = [mk(6, 'Aalesund', 'Hamkam', 75, 'inprogress', 2, 0), mk(7, 'Fredrikstad', 'Kristiansund', 75, 'inprogress', 1, 1), mk(8, 'Valerenga', 'Sarpsborg', 75, 'inprogress', 0, 3)];
  failPage2 = true;
  const l = await tick(15 * 60000);
  assert.strictEqual(score(find(l, 'Aalesund')), '2-0');        // fresh page-1 data is kept
  assert.ok(find(l, 'Valerenga'), 'a match only known from the older fetch is not dropped');
  failPage2 = false;
});

test('result back-fill stops asking for matches the provider no longer lists, and ignores month-old unsettled snapshots', async () => {
  events = []; T.snapshotStore.clear();
  for (let i = 0; i < 3; i++) T.snapshotStore.set('bzz_' + (900 + i), { id: 'bzz_' + (900 + i), date: '2026-11-07', kickoff: '15:00', status: 'notstarted', home: { name: 'P' + i }, away: { name: 'Q' + i } });
  T.snapshotStore.set('bzz_950', { id: 'bzz_950', date: '2026-08-01', kickoff: '15:00', status: 'notstarted', home: { name: 'Old' }, away: { name: 'Old2' } });
  const calls0 = calls;
  for (let i = 0; i < 3; i++) { T.historyCache.ts = 0; await T.refreshHistoryResults(); }
  assert.strictEqual(calls - calls0, 3);                        // one request per scan: the old snapshot is never asked for
  const calls1 = calls; T.historyCache.ts = 0; await T.refreshHistoryResults();
  assert.strictEqual(calls - calls1, 0);                        // 3 empty scans: given up
});

test('provider back-fill settles a finished snapshot and marks a postponed one canceled', async () => {
  T.snapshotStore.clear();
  const snap = (id, extra) => T.snapshotStore.set('bzz_' + id, Object.assign({ id: 'bzz_' + id, date: '2026-11-08', kickoff: '10:00', status: 'started', homeScore: 0, awayScore: 0, home: { name: 'H' + id }, away: { name: 'A' + id } }, extra));
  snap(31); snap(32);
  events = [mk(31, 'H31', 'A31', 300, 'finished', 2, 2), mk(32, 'H32', 'A32', 300, 'postponed', null, null)];
  T.historyCache.ts = 0; await T.refreshHistoryResults();
  const a = T.snapshotStore.get('bzz_31'), b = T.snapshotStore.get('bzz_32');
  assert.deepStrictEqual([a.status, a.homeScore, a.awayScore], ['finished', 2, 2]);
  assert.strictEqual(b.status, 'canceled');
});

test.after(() => { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} });
