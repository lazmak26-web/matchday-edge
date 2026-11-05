'use strict';
// The "26 matches, then 20 after a refresh" bug: when page 2 of the events feed failed, the half list replaced the good cache.
const { test } = require('node:test');
const assert = require('node:assert');
const bz = require('../bzzoiro');

const BASE = 'https://sports.bzzoiro.com/api';
const ev = id => ({ id, home_team: 'H' + id, away_team: 'A' + id, event_date: '2026-11-04T15:00:00Z', status: 'notstarted' });

// A fake Bzzoiro: pageSizes [10, 10, 6] = 26 events over 3 pages. `o` is mutable so a test can break the API between two refreshes.
function setup(pageSizes, o = {}, extra = {}) {
  let id = 1;
  const pages = pageSizes.map(n => Array.from({ length: n }, () => ev(id++)));
  const calls = [], headers = [];
  let t = 1_000_000, day = '2026-11-04', requests = 0;
  const fetchImpl = async (url, opts) => {
    calls.push(url); headers.push(opts && opts.headers);
    const u = new URL(url), p = Number(u.searchParams.get('page') || 1);
    if (o.failPage && o.failPage(p)) return { ok: false, status: o.status || 500, json: async () => ({}) };
    if (o.garbage) return { ok: true, status: 200, json: async () => ({ detail: 'oops' }) };
    const results = o.empty ? [] : (pages[p - 1] || []).map(e => (o.patch ? o.patch(e) : e));
    const next = p < pages.length ? (o.nextUrl ? o.nextUrl(p) : `${o.nextScheme || 'https'}://sports.bzzoiro.com/api/v2/events/?date_from=${day}&date_to=${day}&page=${p + 1}`) : null;
    return { ok: true, status: 200, json: async () => ({ results, next }) };
  };
  const now = () => t;
  const client = bz.create({ base: BASE, key: 'k', fetchImpl, now, count: () => { requests++; } });
  const logs = [];
  const feed = bz.createEventsFeed(Object.assign({ client, now, today: () => day, log: m => logs.push(m), retryMs: 15000 }, extra));
  return { feed, client, calls, headers, logs, o, advance: ms => { t += ms; }, setDay: d => { day = d; }, requests: () => requests, ids: list => list.map(e => e.id) };
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('reads EVERY page, not just the first two', async () => {
  const s = setup([10, 10, 6]);
  const list = await s.feed.get();
  assert.deepStrictEqual(s.ids(list), range(1, 26));
  assert.strictEqual(s.calls.length, 3);
  assert.strictEqual(s.requests(), 3, 'every request is counted against the daily budget');
});

test('cached inside the TTL, refreshed after it', async () => {
  const s = setup([10, 10, 6]);
  await s.feed.get(); await s.feed.get();
  assert.strictEqual(s.calls.length, 3);
  s.advance(61000);
  await s.feed.get();
  assert.strictEqual(s.calls.length, 6);
});

test('REGRESSION 26 -> 20: a failed page 2 keeps the full list, retries soon, and recovers', async () => {
  const s = setup([10, 10, 6]);
  assert.strictEqual((await s.feed.get()).length, 26);
  s.advance(61000);
  s.o.failPage = p => p === 2;
  const during = await s.feed.get();
  assert.deepStrictEqual(s.ids(during), range(1, 26), 'must not shrink to the 10 events of page 1');
  assert.strictEqual(s.feed.state().partial, true);
  const callsAfterFailure = s.calls.length;
  await s.feed.get();
  assert.strictEqual(s.calls.length, callsAfterFailure, 'backs off: no new request right after a failure');
  s.advance(16000); s.o.failPage = null;
  const after = await s.feed.get();
  assert.deepStrictEqual(s.ids(after), range(1, 26));
  assert.strictEqual(s.feed.state().partial, false);
  assert.strictEqual(s.feed.state().lastError, null);
});

test('a partial refresh still updates the events it did get (fresh wins), and keeps the old ones for the rest', async () => {
  const s = setup([2, 2]);
  await s.feed.get();
  s.advance(61000);
  s.o.failPage = p => p === 2;
  s.o.patch = e => Object.assign({}, e, { status: 'finished' });   // the events of page 1 are now finished
  const list = await s.feed.get();
  assert.deepStrictEqual(list.map(e => [e.id, e.status]), [[1, 'finished'], [2, 'finished'], [3, 'notstarted'], [4, 'notstarted']]);
});

test('page 1 failing keeps the cached list and does not hammer the API', async () => {
  const s = setup([10, 10, 6]);
  await s.feed.get();
  s.advance(61000);
  s.o.failPage = () => true;
  assert.strictEqual((await s.feed.get()).length, 26);
  const n = s.calls.length;
  for (let i = 0; i < 5; i++) await s.feed.get();
  assert.strictEqual(s.calls.length, n, 'no retry storm');
  assert.strictEqual(s.logs.length, 1, 'the error is logged (once, not on every request)');
});

test('cold start with a failing API: [] now, no retry storm, recovers by itself', async () => {
  const s = setup([10, 10, 6], { failPage: () => true });
  assert.deepStrictEqual(await s.feed.get(), []);
  const n = s.calls.length;
  await s.feed.get(); await s.feed.get();
  assert.strictEqual(s.calls.length, n);
  s.advance(16000); s.o.failPage = null;
  assert.strictEqual((await s.feed.get()).length, 26);
});

test('an empty 200 does not wipe a day that already had events, but an empty first answer is accepted', async () => {
  const s = setup([10, 10, 6]);
  await s.feed.get();
  s.advance(61000); s.o.empty = true;
  assert.strictEqual((await s.feed.get()).length, 26);
  const e = setup([1], { empty: true });
  assert.deepStrictEqual(await e.feed.get(), []);
  assert.strictEqual(e.feed.state().partial, false, 'a genuinely empty day is a valid answer');
});

test('an error-shaped 200 is a failure, not an empty list', async () => {
  const s = setup([10, 10, 6]);
  await s.feed.get();
  s.advance(61000); s.o.garbage = true;
  assert.strictEqual((await s.feed.get()).length, 26);
  assert.match(s.feed.state().lastError, /unexpected response/);
});

test('HTTP 429 puts the client in a cool-down: no request at all until it ends', async () => {
  const s = setup([10, 10, 6]);
  await s.feed.get();
  s.advance(61000);
  s.o.failPage = () => true; s.o.status = 429;
  await s.feed.get();
  const n = s.calls.length, counted = s.requests();
  s.advance(16000); s.o.failPage = null;
  assert.strictEqual((await s.feed.get()).length, 26);
  assert.strictEqual(s.calls.length, n, 'still cooling down 16s after the 429');
  assert.strictEqual(s.requests(), counted, 'no budget spent while cooling down');
  s.advance(60000);
  await s.feed.get();
  assert.ok(s.calls.length > n, 'requests resume after the cool-down');
  assert.strictEqual(s.feed.state().partial, false);
});

test('yesterday\'s events are never served as today\'s', async () => {
  const s = setup([10, 10, 6]);
  await s.feed.get();
  s.setDay('2026-11-05'); s.advance(5000);
  s.o.failPage = () => true;
  assert.deepStrictEqual(await s.feed.get(), []);
  assert.deepStrictEqual(s.feed.peek(), []);
});

test('an exhausted daily budget serves the cache and makes no request', async () => {
  let ok = true;
  const s = setup([10, 10, 6], {}, { budgetOk: () => ok });
  await s.feed.get();
  const n = s.calls.length;
  s.advance(61000); ok = false;
  assert.strictEqual((await s.feed.get()).length, 26);
  assert.strictEqual(s.calls.length, n);
});

test('concurrent callers share one fetch', async () => {
  const s = setup([10, 10, 6]);
  const [a, b, c] = await Promise.all([s.feed.get(), s.feed.get(), s.feed.get()]);
  assert.strictEqual(s.calls.length, 3);
  assert.strictEqual(a, b); assert.strictEqual(b, c);
});

test('a next link to ANOTHER host is not followed and the API key never leaves the API host', async () => {
  const s = setup([10, 10], { nextUrl: () => 'https://evil.example/steal?page=2' });
  const list = await s.feed.get();
  assert.strictEqual(list.length, 10);
  assert.ok(s.calls.every(u => new URL(u).hostname === 'sports.bzzoiro.com'), s.calls.join(', '));
  assert.match(s.feed.state().lastError, /another host/);
});

test('a plain-http next link (some proxies hand those out) is upgraded to https', async () => {
  const s = setup([10, 10, 6], { nextScheme: 'http' });
  assert.strictEqual((await s.feed.get()).length, 26);
  assert.ok(s.calls.every(u => u.startsWith('https://')), s.calls.join(', '));
  assert.ok(s.headers.every(h => h && h.Authorization === 'Token k'));
});

test('maxPages cuts the list and says so (instead of looping forever)', async () => {
  const s = setup([10, 10, 6], {}, { maxPages: 2 });
  const list = await s.feed.get();
  assert.strictEqual(list.length, 20);
  assert.strictEqual(s.feed.state().truncated, true);
  assert.ok(s.logs.some(m => /BZZ_EVENTS_MAX_PAGES/.test(m)));
});

test('no API key: nothing is requested', async () => {
  const calls = [];
  const client = bz.create({ base: BASE, key: '', fetchImpl: async u => { calls.push(u); return { ok: true, status: 200, json: async () => ({ results: [] }) }; } });
  const feed = bz.createEventsFeed({ client });
  assert.deepStrictEqual(await feed.get(), []);
  assert.strictEqual(calls.length, 0);
});

test('client.follow: same host only, https enforced', () => {
  const c = bz.create({ base: BASE, key: 'k' });
  assert.strictEqual(c.follow('http://sports.bzzoiro.com/api/v2/events/?page=2'), 'https://sports.bzzoiro.com/api/v2/events/?page=2');
  assert.strictEqual(c.follow('/api/v2/events/?page=3'), 'https://sports.bzzoiro.com/api/v2/events/?page=3');
  assert.strictEqual(c.follow('https://evil.example/x'), null);
  assert.strictEqual(c.follow('//evil.example/x'), null);
});
