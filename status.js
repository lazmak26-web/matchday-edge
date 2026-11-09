/* Match status helpers (pure, no I/O): covered by tests/status.test.js.
   Statuses used everywhere else: 'notstarted' | 'started' (live) | 'finished' | 'canceled'. */

// Nothing in football lasts longer than this after kick-off (90 + half-time + extra time + penalties + delays).
// A match the feed still calls "live" after this long is OVER: the feed is stale, the site must not show LIVE forever.
const MAX_LIVE_MS = 3.5 * 60 * 60 * 1000;
const STARTED_GRACE_MS = 10 * 60 * 1000;   // a match with no status is treated as started 10 minutes after kick-off

const STATUS_FINISHED = new Set(['finished', 'ft', 'ended', 'full_time', 'fulltime', 'after_extra_time', 'after_penalties', 'aet', 'pen', 'ended_after_extra_time', 'ended_after_penalties', 'full-time', 'end', 'after_et', 'after_pen', 'ap', 'complete', 'completed', 'final', 'closed', 'match_finished', 'finished_after_extra_time', 'finished_after_penalties']);
const STATUS_CANCELED = new Set(['canceled', 'cancelled', 'abandoned', 'postponed', 'suspended', 'interrupted', 'called_off', 'cancelled_match']);
const STATUS_LIVE = new Set(['in_play', 'inplay', 'live', 'started', 'halftime', 'ht', 'in_progress', 'inprogress', '1h', '2h', '1st_half', '2nd_half', 'first_half', 'second_half', 'extra_time', 'et', '1st_extra', '2nd_extra', 'penalties', 'penalty_shootout', 'playing', 'paused', 'break', 'int', 'in-progress', 'half_time']);
const STATUS_NOTSTARTED = new Set(['not_started', 'notstarted', 'scheduled', 'timed', 'tbd', 'pre', 'upcoming', 'not-started']);

function kickoffMs(kickoff) {
  if (kickoff == null || kickoff === '') return NaN;
  return typeof kickoff === 'number' ? kickoff : new Date(kickoff).getTime();
}

function normalizeStatus(rawStatus, kickoffDate, now = Date.now()) {
  const s = String(rawStatus || '').toLowerCase().trim().replace(/[\s\-]+/g, '_');
  if (STATUS_FINISHED.has(s)) return 'finished';
  if (STATUS_CANCELED.has(s)) return 'canceled';
  const elapsed = now - kickoffMs(kickoffDate);
  const known = !isNaN(elapsed);
  // The feed says "live", but kick-off was hours ago: the feed is stuck, the match is over.
  if (STATUS_LIVE.has(s)) return known && elapsed > MAX_LIVE_MS ? 'finished' : 'started';
  // No / unknown status: decide from the clock.
  if (known) {
    if (elapsed > MAX_LIVE_MS) return 'finished';
    if (elapsed > STARTED_GRACE_MS) return 'started';
  }
  return 'notstarted';
}

function pickBetterStatus(a, b) {
  const o = { finished: 4, started: 3, canceled: 2, notstarted: 1 };
  return (o[a] || 0) >= (o[b] || 0) ? a : b;
}

const isScore = n => Number.isInteger(n) && n >= 0;

/* A fixture we still hold as 'started' whose kick-off is long past (a stale cached copy, a stuck provider) is finished.
   A score we only ever saw while "live" is NOT a verified final result (it may be the 0-0 of minute 1), so it is dropped:
   the site shows FT without a score, bets are not graded on it, and the real score is filled in as soon as the provider sends it
   (see refreshHistoryResults). Returns true when it changed the fixture. */
function expireStaleLive(f, now = Date.now()) {
  if (!f || f.status !== 'started') return false;
  // (V8's lenient Date parser turns junk like "xTy:00Z" into the year 2000, so the format is checked first.)
  const okFmt = /^\d{4}-\d{2}-\d{2}$/.test(String(f.date)) && /^\d{2}:\d{2}$/.test(String(f.kickoff));
  const t = okFmt ? kickoffMs(`${f.date}T${f.kickoff}:00Z`) : NaN;
  if (isNaN(t) || now - t <= MAX_LIVE_MS) return false;
  f.status = 'finished';
  f.homeScore = null; f.awayScore = null;
  f.resultPending = true;
  return true;
}

/* Events list when a later page of the provider failed: keep the fuller list we already know, but lay the events we DID just fetch over it
   (matched by id), so those matches get their fresh status and score instead of staying frozen on the old one. */
function mergeEvents(known, fresh) {
  const key = e => (e && e.id != null) ? 'id:' + e.id : `${e && e.home_team}|${e && e.away_team}|${e && e.event_date}`;
  const m = new Map((known || []).map(e => [key(e), e]));
  for (const e of fresh || []) m.set(key(e), e);
  return [...m.values()];
}

module.exports = { MAX_LIVE_MS, normalizeStatus, pickBetterStatus, expireStaleLive, mergeEvents, isScore };
