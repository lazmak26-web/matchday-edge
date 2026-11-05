'use strict';
// Bzzoiro API client + the "today's events" feed. Free of Express and of process state, so it can be unit-tested with a fake fetch.
//
// What was wrong with the old inline code in server.js (each point verified by reading it):
//  1. Only the first 2 pages of events were ever read, so a busy day was cut off after ~2 pages.
//  2. When page 2 failed, the loop just `break`ed and that half list REPLACED the good cache. The match list shrank on the next refresh
//     (e.g. 26 -> 20) and stayed small until the next successful refresh.
//  3. A failure on page 1 was swallowed silently and retried on every request (each retry spends daily budget).
//  4. No timeout: one hung request froze every caller waiting on it.
//  5. The `next` link from the API was followed blindly with the API key attached (any host, even plain http).
//  6. The cache was not keyed by day, so yesterday's events could be served after midnight UTC.

// ---------------------------------------------------------------------------------------------------------------------------------
// Client: base URL + auth + timeout + 429 cooldown + request counting
function create(cfg = {}) {
  const base = String(cfg.base || '').replace(/\/+$/, '');
  const key = cfg.key;
  const doFetch = cfg.fetchImpl || ((...a) => fetch(...a));
  const now = cfg.now || Date.now;
  const timeoutMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : 10000;
  const cooldownMs = cfg.cooldownMs > 0 ? cfg.cooldownMs : 60 * 1000;
  const count = cfg.count || (() => {});
  let blockedUntil = 0;

  const enabled = () => !!key;
  const cooling = () => now() < blockedUntil;

  // Same host + same scheme as `base`, or null. The API key is never sent to another host, and links handed out as http:// are upgraded.
  function follow(next) {
    try {
      const b = new URL(base), n = new URL(String(next), b);
      if (n.hostname !== b.hostname) return null;
      n.protocol = b.protocol; n.port = b.port;
      return n.toString();
    } catch (e) { return null; }
  }

  async function get(pathOrUrl) {
    if (cooling()) { const e = new Error('Bzzoiro cooling down after HTTP 429'); e.status = 429; e.cooling = true; throw e; }
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : base + pathOrUrl;
    count();
    const opts = { headers: { Authorization: `Token ${key}`, Accept: 'application/json' } };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeoutMs);
    const r = await doFetch(url, opts);
    if (r.status === 429) blockedUntil = now() + cooldownMs;
    if (!r.ok) { const e = new Error('Bzzoiro HTTP ' + r.status); e.status = r.status; throw e; }
    return r.json();
  }

  return { enabled, cooling, follow, get };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Feed: all of today's events, cached, never shrinking because of a failed refresh
const idOf = ev => (ev && ev.id != null ? String(ev.id) : null);
// Old list first (keeps the order stable), refreshed values from the new list win. Events without an id are unusable and dropped.
function mergeEvents(old, fresh) {
  const out = new Map();
  for (const ev of old || []) { const k = idOf(ev); if (k) out.set(k, ev); }
  for (const ev of fresh || []) { const k = idOf(ev); if (k) out.set(k, ev); }
  return [...out.values()];
}

function createEventsFeed(cfg = {}) {
  const client = cfg.client;
  const now = cfg.now || Date.now;
  const today = cfg.today || (() => new Date(now()).toISOString().slice(0, 10));
  const isActive = cfg.isActive || (() => true);
  const budgetOk = cfg.budgetOk || (() => true);
  const log = cfg.log || (m => console.error(m));
  const ttlActive = cfg.ttlActiveMs > 0 ? cfg.ttlActiveMs : 60 * 1000;
  const ttlIdle = cfg.ttlIdleMs > 0 ? cfg.ttlIdleMs : 10 * 60 * 1000;
  const retryMs = cfg.retryMs > 0 ? cfg.retryMs : 15 * 1000;
  const maxPages = cfg.maxPages > 0 ? cfg.maxPages : 10;
  const st = { data: null, day: null, nextAt: 0, pages: 0, partial: false, truncated: false, lastError: null, at: null, lastLogMsg: null, lastLogAt: 0 };
  let inFlight = null;

  const ttl = () => (isActive() ? ttlActive : ttlIdle);
  const stale = day => (st.day === day && st.data ? st.data : []);
  function logOnce(msg) { if (msg !== st.lastLogMsg || now() - st.lastLogAt > 60 * 1000) { st.lastLogMsg = msg; st.lastLogAt = now(); log(msg); } }

  async function load(day) {
    const fresh = [];
    let url = `/v2/events/?date_from=${day}&date_to=${day}`, pages = 0, failure = null, truncated = false;
    while (url) {
      if (pages >= maxPages) { truncated = true; break; }
      let data;
      try { data = await client.get(url); } catch (e) { failure = e; break; }
      const part = data && (Array.isArray(data.results) ? data.results : Array.isArray(data.data) ? data.data : null);
      if (!part) { failure = new Error('Bzzoiro events: unexpected response (no results list)'); break; }
      pages++;
      fresh.push(...part);
      const next = typeof data.next === 'string' && data.next ? data.next : null;
      if (!next) break;
      url = client.follow(next);
      if (!url) { failure = new Error('Bzzoiro events: refusing to follow a next link to another host'); break; }
    }
    st.pages = pages; st.at = new Date(now()).toISOString();
    const old = st.day === day && st.data ? st.data : null;

    if (failure) {
      st.lastError = failure.message; st.nextAt = now() + retryMs;
      if (fresh.length) {                                   // partial list: take what we got, KEEP everything we already knew about today
        st.data = mergeEvents(old, fresh); st.day = day; st.partial = true;
        logOnce(`${failure.message} - kept ${st.data.length} events (${fresh.length} refreshed), retrying soon`);
      } else {
        if (!old) { st.data = []; st.day = day; }
        st.partial = !!old;                                 // still serving an older list
        logOnce(`${failure.message} - serving ${(st.data || []).length} cached events, retrying soon`);
      }
      return st.data;
    }

    if (!fresh.length && old && old.length) {               // an empty 200 on a day that already had events: suspicious, keep the old list
      st.lastError = 'empty events response ignored'; st.nextAt = now() + retryMs; st.partial = true;
      logOnce('Bzzoiro events: empty response ignored, keeping ' + old.length + ' cached events');
      return st.data;
    }
    st.data = mergeEvents([], fresh); st.day = day; st.partial = false; st.lastError = null; st.nextAt = now() + ttl();
    if (truncated && !st.truncated) log(`Bzzoiro events: more than ${maxPages} pages for ${day}, list cut at ${maxPages} (raise BZZ_EVENTS_MAX_PAGES)`);
    st.truncated = truncated;
    return st.data;
  }

  function get() {
    if (!client.enabled()) return Promise.resolve([]);
    const day = today();
    if (st.day === day && st.data && now() < st.nextAt) return Promise.resolve(st.data);
    if (!budgetOk()) return Promise.resolve(stale(day));
    if (inFlight) return inFlight;
    inFlight = load(day).catch(e => { st.lastError = e.message; st.nextAt = now() + retryMs; return stale(day); }).finally(() => { inFlight = null; });
    return inFlight;
  }

  const peek = () => stale(today());
  const state = () => ({ day: st.day, events: (st.data || []).length, pages: st.pages, partial: st.partial, truncated: st.truncated, lastError: st.lastError, at: st.at });
  return { get, peek, state };
}

module.exports = { create, createEventsFeed, mergeEvents };
