'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
   DEMO ARENA — virtual-credit sports prediction simulator.

   Everything here uses VIRTUAL credits (shown as DH / MAD) for entertainment and learning. There are no deposits,
   no real-money stakes, no withdrawals and no cash-out of any kind. The server is the only source of truth:
   balances, odds, Pro status and match results are never taken from the browser.

   Layout
     - DemoStore  : pure, synchronous wallet / prediction / settlement logic (no I/O, injectable clock) -> unit-tested.
     - create()   : wires the store to Express routes, the sports feed already used by the site, JSON persistence,
                    per-user rate limits, audit log and the settlement scheduler.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;
const MIN_MATCH_MS = 100 * 60 * 1000;           // a result is never trusted earlier than this after kickoff
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const toC = dh => Math.round(dh * 100);         // all money is kept as integer cents internally
const toDH = c => Math.round(c) / 100;

/* ─────────────────────────────── configuration (admin-editable) ─────────────────────────────── */
const DEFAULT_CONFIG = Object.freeze({
  initialBalance: 2000,        // virtual DH given to every new wallet and restored by a recovery
  freeRecoveryDays: 30,        // Free plan: one recovery per this many days
  proRecoveryEnabled: true,    // Pro plan: recover whenever wanted
  minStake: 10,
  maxStake: 1000,
  maxOpenPredictions: 25,
  voidAfterHours: 72,          // unresolved / postponed matches are voided (stake refunded) this long after kickoff
  settleDelayMin: 3,           // a final score must stay unchanged this long before it is trusted
  dataMode: 'auto'             // auto | sample | off
});
const RULES = {
  initialBalance: { type: 'int', min: 100, max: 100000 },
  freeRecoveryDays: { type: 'int', min: 1, max: 365 },
  proRecoveryEnabled: { type: 'bool' },
  minStake: { type: 'int', min: 1, max: 10000 },
  maxStake: { type: 'int', min: 1, max: 100000 },
  maxOpenPredictions: { type: 'int', min: 1, max: 200 },
  voidAfterHours: { type: 'int', min: 6, max: 720 },
  settleDelayMin: { type: 'int', min: 0, max: 60 },
  dataMode: { type: 'enum', values: ['auto', 'sample', 'off'] }
};
function sanitizeConfig(input, base) {
  const out = Object.assign({}, base), errors = [];
  for (const k of Object.keys(RULES)) {
    if (!input || input[k] === undefined) continue;
    const r = RULES[k], v = input[k];
    if (r.type === 'bool') {
      if (typeof v !== 'boolean') errors.push(`${k} must be true or false`); else out[k] = v;
    } else if (r.type === 'enum') {
      if (!r.values.includes(v)) errors.push(`${k} must be one of: ${r.values.join(', ')}`); else out[k] = v;
    } else {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (!Number.isInteger(n) || n < r.min || n > r.max) errors.push(`${k} must be a whole number between ${r.min} and ${r.max}`); else out[k] = n;
    }
  }
  if (out.minStake > out.maxStake) errors.push('minStake cannot be above maxStake');
  return { config: errors.length ? Object.assign({}, base) : out, errors };
}

/* ─────────────────────────────── odds & match helpers ─────────────────────────────── */
const sane = x => typeof x === 'number' && isFinite(x) && x > 1 && x <= 100;
const r2 = x => Math.round(x * 100) / 100;
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Demo odds = the market median across the bookmakers the data provider returned for the match. A market only exists
// when the provider really supplies it (1X2 and Over/Under 2.5 here; Both-Teams-To-Score is not supplied, so it is not offered).
function consensusOdds(books) {
  const list = Array.isArray(books) ? books : [];
  const pick = key => { const v = list.map(b => b && Number(b[key])).filter(sane); return v.length ? r2(median(v)) : null; };
  const home = pick('home'), draw = pick('draw'), away = pick('away'), over = pick('over25'), under = pick('under25');
  return { x12: home && draw && away ? { home, draw, away } : null, ou25: over && under ? { over, under } : null, books: list.length };
}
function oddsFor(fx, market, sel) {
  const c = consensusOdds(fx && fx.odds);
  if (market === '1x2' && c.x12 && (sel === 'home' || sel === 'draw' || sel === 'away')) return c.x12[sel];
  if (market === 'ou25' && c.ou25 && (sel === 'over' || sel === 'under')) return c.ou25[sel];
  return null;
}
const startMs = fx => Date.parse(`${fx.date}T${fx.kickoff || '00:00'}:00Z`);
const MARKET_LABEL = { '1x2': 'Match Result', ou25: 'Over/Under 2.5 Goals' };
function selLabel(p) {
  if (p.market === '1x2') return p.sel === 'home' ? `${p.match.home.name} Win` : p.sel === 'away' ? `${p.match.away.name} Win` : 'Draw';
  return p.sel === 'over' ? 'Over 2.5 Goals' : 'Under 2.5 Goals';
}
function outcomeOf(market, h, a) {
  if (market === '1x2') return h > a ? 'home' : h < a ? 'away' : 'draw';
  return h + a > 2.5 ? 'over' : 'under';
}

// Public card of a real match. `bettable` is true only when the match has not started and the provider gave real odds.
function toCard(fx, nowMs) {
  const c = consensusOdds(fx.odds), st = startMs(fx);
  const bettable = fx.status === 'notstarted' && st > nowMs && !!(c.x12 || c.ou25);
  const showScore = fx.status === 'started' || fx.status === 'finished';
  return {
    id: String(fx.id), sport: 'football', league: String(fx.league || 'Football'), date: fx.date, kickoff: fx.kickoff,
    startsAt: isNaN(st) ? null : new Date(st).toISOString(), status: fx.status,
    live: fx.status === 'started',
    homeScore: showScore ? fx.homeScore : null, awayScore: showScore ? fx.awayScore : null,
    home: { name: String(fx.home.name), logo: fx.home.logo || null }, away: { name: String(fx.away.name), logo: fx.away.logo || null },
    markets: { x12: c.x12, ou25: c.ou25 }, books: c.books, bettable, featured: (fx.big || 0) >= 1 && bettable, big: fx.big || 0, sample: false
  };
}
// Clearly labelled sample matches (fictional teams) used only when no sports data provider is configured.
function sampleCards(nowMs) {
  const rows = [
    ['Atlas City', 'Northgate Rovers', 3, [2.10, 3.40, 3.30], [1.85, 1.95]],
    ['Harbor United', 'Redwood Athletic', 6, [1.75, 3.80, 4.40], [1.70, 2.10]],
    ['Solaris FC', 'Eastbridge Town', 27, [2.60, 3.10, 2.75], [2.05, 1.76]],
    ['Ironvale SC', 'Crescent Park', 30, [1.55, 4.20, 5.60], [1.62, 2.25]],
    ['Lakeside Wanderers', 'Summit Albion', 52, [2.35, 3.25, 3.00], [1.92, 1.88]],
    ['Granite Athletic', 'Oakfield Dynamo', 55, [3.10, 3.30, 2.25], [1.80, 2.00]]
  ];
  return rows.map((r, i) => {
    const t = new Date(nowMs + r[2] * 3600000);
    return {
      id: 'sample_' + (i + 1), sport: 'football', league: 'Sample League (demo data)', date: t.toISOString().slice(0, 10), kickoff: t.toISOString().slice(11, 16),
      startsAt: t.toISOString(), status: 'notstarted', live: false, homeScore: null, awayScore: null,
      home: { name: r[0], logo: null }, away: { name: r[1], logo: null },
      markets: { x12: { home: r[3][0], draw: r[3][1], away: r[3][2] }, ou25: { over: r[4][0], under: r[4][1] } }, books: 0,
      bettable: false, featured: i < 3, big: 0, sample: true
    };
  });
}

const fail = (status, code, error, extra) => Object.assign({ ok: false, status, code, error }, extra || {});

/* ─────────────────────────────── the store ─────────────────────────────── */
class DemoStore {
  constructor({ now = Date.now, state } = {}) {
    this.now = now;
    this.onChange = null;
    this.s = state || {};
    const s = this.s;
    s.v = 1;
    s.config = Object.assign({}, DEFAULT_CONFIG, s.config || {});
    s.wallets = s.wallets || {};
    s.predictions = s.predictions || {};
    s.audit = Array.isArray(s.audit) ? s.audit : [];
    s.errors = Array.isArray(s.errors) ? s.errors : [];
    s.failures = Array.isArray(s.failures) ? s.failures : [];
  }
  get config() { return this.s.config; }
  touch() { if (this.onChange) this.onChange(); }

  /* ----- logs ----- */
  audit(user, action, detail, ip) {
    const a = this.s.audit;
    a.push({ id: uid(5), at: this.now(), user: user || null, action, detail: detail || null, ip: ip || null });
    if (a.length > 5000) a.splice(0, a.length - 5000);
  }
  recordError(source, message) {
    const e = this.s.errors, last = e[e.length - 1], t = this.now();
    if (last && last.source === source && last.message === message && t - last.at < 60000) { last.n = (last.n || 1) + 1; last.at = t; return; }
    e.push({ at: t, source, message: String(message).slice(0, 300), n: 1 });
    if (e.length > 200) e.splice(0, e.length - 200);
    this.touch();
  }
  recordFailure(p, reason) {
    const f = this.s.failures;
    f.push({ at: this.now(), predictionId: p.id, matchId: p.matchId, user: p.user, reason });
    if (f.length > 200) f.splice(0, f.length - 200);
  }

  /* ----- wallets ----- */
  _tx(w, type, amountC, note, ref) {
    w.tx.push({ id: uid(6), at: this.now(), type, amountC, balanceC: w.balanceC, note: note || null, ref: ref || null });
    if (w.tx.length > 500) w.tx.splice(0, w.tx.length - 500);
  }
  ensureWallet(userKey, label) {
    let w = this.s.wallets[userKey];
    if (w) return w;
    const bal = toC(this.s.config.initialBalance);
    w = {
      user: userKey, label: String(label || '').slice(0, 80), createdAt: this.now(), balanceC: bal, lastRecoveryAt: null,
      recoveries: [], tx: [], idem: {}, predIds: [], openIds: [],
      stat: { stakedC: 0, returnedC: 0, wonStakeC: 0, lostStakeC: 0, won: 0, lost: 0, voided: 0, placed: 0 }
    };
    this.s.wallets[userKey] = w;
    this._tx(w, 'grant', bal, 'Welcome virtual credits');
    this.audit(userKey, 'wallet_created', { balance: toDH(bal) });
    this.touch();
    return w;
  }
  walletPublic(userKey, plan) {
    const w = this.ensureWallet(userKey), st = w.stat, settled = st.won + st.lost;
    const profitC = st.returnedC - st.wonStakeC - st.lostStakeC;
    return {
      balance: toDH(w.balanceC), initialBalance: this.s.config.initialBalance, used: toDH(st.stakedC), won: toDH(st.returnedC), lost: toDH(st.lostStakeC),
      profit: toDH(profitC), roi: st.wonStakeC + st.lostStakeC > 0 ? +(profitC / (st.wonStakeC + st.lostStakeC) * 100).toFixed(1) : null,
      predictions: st.placed, settled, wins: st.won, losses: st.lost, voided: st.voided, pending: w.openIds.length,
      winRate: settled ? +(st.won / settled * 100).toFixed(1) : null, plan: plan === 'pro' ? 'pro' : 'free', since: w.createdAt
    };
  }

  /* ----- recovery ----- */
  recoveryState(userKey, plan) {
    const cfg = this.s.config, w = this.s.wallets[userKey], now = this.now();
    const unlimited = plan === 'pro' && cfg.proRecoveryEnabled;
    const target = toC(cfg.initialBalance), bal = w ? w.balanceC : target;
    const availableAt = !unlimited && w && w.lastRecoveryAt ? w.lastRecoveryAt + cfg.freeRecoveryDays * DAY : null;
    const cooling = !!availableAt && now < availableAt;
    const needs = bal < target;
    return {
      unlimited, needs, cooling, allowed: needs && !cooling, reason: !needs ? 'balance_ok' : cooling ? 'cooldown' : null,
      nextAt: cooling ? availableAt : null, lastAt: w ? w.lastRecoveryAt : null, target: cfg.initialBalance, intervalDays: cfg.freeRecoveryDays
    };
  }
  recover(userKey, plan, ip) {
    const w = this.ensureWallet(userKey), st = this.recoveryState(userKey, plan), now = this.now();
    if (!st.needs) return fail(409, 'balance_ok', `Your balance is already at or above ${st.target} DH — there is nothing to recover.`, { recovery: st });
    if (st.cooling) return fail(429, 'cooldown', 'Your next free recovery is not available yet.', { recovery: st });
    const target = toC(this.s.config.initialBalance), before = w.balanceC;
    w.balanceC = target;
    w.lastRecoveryAt = now;
    this._tx(w, 'recovery', target - before, `Virtual balance recovered to ${toDH(target)} DH`);
    w.recoveries.unshift({ id: uid(5), at: now, plan: plan === 'pro' ? 'pro' : 'free', beforeC: before, afterC: target });
    if (w.recoveries.length > 100) w.recoveries.length = 100;
    this.audit(userKey, 'recovery', { plan, before: toDH(before), after: toDH(target) }, ip);
    this.touch();
    return { ok: true, recovery: this.recoveryState(userKey, plan) };
  }

  /* ----- predictions ----- */
  place(userKey, plan, req, fx, ip) {
    const cfg = this.s.config, now = this.now();
    const w = this.ensureWallet(userKey);
    req = req || {};
    // Idempotency keys are user input used as object keys: only the wallet's OWN entries count (never inherited ones such as
    // "constructor"), and the special "__proto__" key is refused outright.
    const rq = typeof req.requestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(req.requestId) && req.requestId !== '__proto__' ? req.requestId : null;
    const prevId = rq && Object.prototype.hasOwnProperty.call(w.idem, rq) ? w.idem[rq] : null;
    if (prevId && Object.prototype.hasOwnProperty.call(this.s.predictions, prevId)) return { ok: true, duplicate: true, prediction: this.s.predictions[prevId] };
    if (!fx) return fail(404, 'match_not_found', 'Match not found. Refresh the list and try again.');
    if (fx.status !== 'notstarted' || !(startMs(fx) > now)) return fail(409, 'closed', 'Predictions are closed for this match.');
    const market = req.market, sel = req.selection;
    const valid = (market === '1x2' && ['home', 'draw', 'away'].includes(sel)) || (market === 'ou25' && ['over', 'under'].includes(sel));
    if (!valid) return fail(400, 'bad_selection', 'Unknown market or selection.');
    const odds = oddsFor(fx, market, sel);
    if (!odds) return fail(422, 'market_unavailable', 'This market is not available for this match.');
    if (req.odds !== undefined && req.odds !== null) {
      const q = Number(req.odds);
      if (!isFinite(q) || Math.abs(q - odds) > 0.009) return fail(409, 'odds_changed', 'The odds changed. Review the new odds and confirm again.', { odds });
    }
    const stake = req.stake;
    if (!Number.isInteger(stake)) return fail(400, 'bad_stake', 'The virtual stake must be a whole number of DH.');
    if (stake < cfg.minStake || stake > cfg.maxStake) return fail(400, 'stake_range', `The virtual stake must be between ${cfg.minStake} and ${cfg.maxStake} DH.`);
    const stakeC = toC(stake);
    if (w.balanceC < stakeC) return fail(409, 'insufficient_balance', w.balanceC < toC(cfg.minStake) ? 'Your virtual balance is too low to place a prediction. Use a recovery to restore it.' : 'Not enough virtual balance for this stake.', { balance: toDH(w.balanceC) });
    if (w.openIds.length >= cfg.maxOpenPredictions) return fail(409, 'too_many_open', `You can have at most ${cfg.maxOpenPredictions} open predictions at the same time.`);

    // ---- everything below is synchronous: validate -> record -> deduct happen as one indivisible step ----
    const id = uid(8);
    const p = {
      id, user: userKey, requestId: rq, matchId: String(fx.id), kickoffMs: startMs(fx), market, sel, odds, stakeC, potentialC: Math.round(stakeC * odds),
      status: 'pending', createdAt: now, settledAt: null, payoutC: 0, result: null, voidReason: null, finalSeen: null,
      match: { league: String(fx.league || 'Football').slice(0, 80), date: fx.date, kickoff: fx.kickoff, home: { name: String(fx.home.name).slice(0, 60), logo: fx.home.logo || null }, away: { name: String(fx.away.name).slice(0, 60), logo: fx.away.logo || null } }
    };
    w.balanceC -= stakeC;
    w.stat.stakedC += stakeC; w.stat.placed++;
    this.s.predictions[id] = p;
    w.predIds.push(id); w.openIds.push(id);
    if (rq) { w.idem[rq] = id; const k = Object.keys(w.idem); if (k.length > 200) for (const old of k.slice(0, k.length - 200)) delete w.idem[old]; }
    this._tx(w, 'stake', -stakeC, `${selLabel(p)} @ ${odds.toFixed(2)}`, id);
    this._trim(w);
    this.audit(userKey, 'predict', { id, matchId: p.matchId, market, selection: sel, odds, stake }, ip);
    this.touch();
    return { ok: true, prediction: p };
  }
  _trim(w) {
    if (w.predIds.length <= 2000) return;
    const keep = [];
    let drop = w.predIds.length - 2000;
    for (const id of w.predIds) {
      const p = this.s.predictions[id];
      if (drop > 0 && p && p.status !== 'pending') { delete this.s.predictions[id]; drop--; } else keep.push(id);
    }
    w.predIds = keep;
  }

  _closeOpen(w, p) { const i = w.openIds.indexOf(p.id); if (i >= 0) w.openIds.splice(i, 1); }
  // Settlement is idempotent: it only ever runs on a prediction that is still 'pending', and flips it in the same synchronous step.
  _settle(w, p, h, a) {
    if (p.status !== 'pending') return false;
    const won = outcomeOf(p.market, h, a) === p.sel, now = this.now();
    p.status = won ? 'won' : 'lost'; p.settledAt = now; p.result = { h, a };
    this._closeOpen(w, p);
    if (won) {
      p.payoutC = Math.round(p.stakeC * p.odds);
      w.balanceC += p.payoutC;
      w.stat.won++; w.stat.returnedC += p.payoutC; w.stat.wonStakeC += p.stakeC;
      this._tx(w, 'win', p.payoutC, `${selLabel(p)} won (${h}-${a})`, p.id);
    } else {
      w.stat.lost++; w.stat.lostStakeC += p.stakeC;
      this._tx(w, 'loss', 0, `${selLabel(p)} lost (${h}-${a})`, p.id);
    }
    this.audit(p.user, 'settle', { id: p.id, status: p.status, score: `${h}-${a}`, payout: toDH(p.payoutC) });
    return true;
  }
  _void(w, p, reason) {
    if (p.status !== 'pending') return false;
    p.status = 'void'; p.settledAt = this.now(); p.voidReason = reason; p.payoutC = p.stakeC;
    this._closeOpen(w, p);
    w.balanceC += p.stakeC; w.stat.stakedC -= p.stakeC; w.stat.voided++;
    this._tx(w, 'refund', p.stakeC, `Stake refunded (${reason === 'match_canceled' ? 'match cancelled' : 'no verified result'})`, p.id);
    this.audit(p.user, 'void', { id: p.id, reason, refund: toDH(p.stakeC) });
    return true;
  }
  // lookup(matchId) -> { status, homeScore, awayScore } | null. Settles on a VERIFIED final result only; voids cancelled and unresolved matches.
  settleDue(lookup, nowMs) {
    const now = nowMs == null ? this.now() : nowMs, cfg = this.s.config, out = { settled: 0, voided: 0, waiting: 0 };
    let dirty = false;
    for (const w of Object.values(this.s.wallets)) {
      for (const id of [...w.openIds]) {
        const p = this.s.predictions[id];
        if (!p || p.status !== 'pending') { this._closeOpen(w, { id }); dirty = true; continue; }
        let m = null;
        try { m = lookup(p.matchId); } catch (e) { this.recordError('settlement', e.message); out.waiting++; continue; }
        if (m && m.status === 'canceled') { if (this._void(w, p, 'match_canceled')) { out.voided++; dirty = true; } continue; }
        if (m && m.status === 'finished' && Number.isInteger(m.homeScore) && Number.isInteger(m.awayScore) && now >= p.kickoffMs + MIN_MATCH_MS) {
          if (!p.finalSeen || p.finalSeen.h !== m.homeScore || p.finalSeen.a !== m.awayScore) {
            p.finalSeen = { h: m.homeScore, a: m.awayScore, at: now }; dirty = true;
          }
          if (now - p.finalSeen.at >= cfg.settleDelayMin * 60000) { if (this._settle(w, p, m.homeScore, m.awayScore)) { out.settled++; dirty = true; } }
          else out.waiting++;
          continue;
        }
        if (now > p.kickoffMs + cfg.voidAfterHours * 3600000) {
          if (this._void(w, p, 'unresolved')) { this.recordFailure(p, m ? `no verified final result (match status: ${m.status})` : 'match missing from every data source'); out.voided++; dirty = true; }
          continue;
        }
        out.waiting++;
      }
    }
    if (dirty) this.touch();
    return out;
  }

  /* ----- reads ----- */
  pub(p, nowMs) {
    const phase = p.status !== 'pending' ? p.status : (p.kickoffMs <= nowMs ? 'active' : 'pending');
    return {
      id: p.id, matchId: p.matchId, league: p.match.league, date: p.match.date, kickoff: p.match.kickoff, home: p.match.home, away: p.match.away,
      market: p.market, marketLabel: MARKET_LABEL[p.market], selection: p.sel, selectionLabel: selLabel(p), odds: p.odds,
      stake: toDH(p.stakeC), potential: toDH(p.potentialC), status: p.status, phase, createdAt: p.createdAt, settledAt: p.settledAt,
      payout: toDH(p.payoutC), score: p.result ? `${p.result.h}-${p.result.a}` : null, voidReason: p.voidReason
    };
  }
  static inFilter(p, filter, now) {
    if (filter === 'won' || filter === 'lost' || filter === 'void') return p.status === filter;
    if (filter === 'active') return p.status === 'pending' && p.kickoffMs <= now;
    if (filter === 'pending') return p.status === 'pending' && p.kickoffMs > now;
    return true;
  }
  // One pass over the wallet: the requested page, its total, and the per-filter counts (used by /api/demo/predictions).
  listPredictionsWithCounts(userKey, { filter = 'all', offset = 0, limit = 20 } = {}) {
    const counts = { all: 0, active: 0, pending: 0, won: 0, lost: 0, void: 0 };
    const w = this.s.wallets[userKey], now = this.now();
    if (!w) return { items: [], total: 0, counts };
    const all = w.predIds.map(id => this.s.predictions[id]).filter(Boolean).reverse();
    const picked = [];
    for (const p of all) {
      for (const k of Object.keys(counts)) if (this.constructor.inFilter(p, k, now)) counts[k]++;
      if (this.constructor.inFilter(p, filter, now)) picked.push(p);
    }
    return { items: picked.slice(offset, offset + limit).map(p => this.pub(p, now)), total: picked.length, counts };
  }
  listPredictions(userKey, opts = {}) {
    const { items, total } = this.listPredictionsWithCounts(userKey, opts);
    return { items, total };
  }
  listTransactions(userKey, { offset = 0, limit = 30 } = {}) {
    const w = this.s.wallets[userKey];
    if (!w) return { items: [], total: 0 };
    const all = [...w.tx].reverse();
    return { items: all.slice(offset, offset + limit).map(t => ({ id: t.id, at: t.at, type: t.type, amount: toDH(t.amountC), balance: toDH(t.balanceC), note: t.note })), total: all.length };
  }
  recoveries(userKey) {
    const w = this.s.wallets[userKey];
    return w ? w.recoveries.slice(0, 20).map(r => ({ id: r.id, at: r.at, plan: r.plan, before: toDH(r.beforeC), after: toDH(r.afterC) })) : [];
  }
  formGuide(userKey, n = 10) {
    const w = this.s.wallets[userKey];
    if (!w) return [];
    return w.predIds.map(id => this.s.predictions[id]).filter(p => p && (p.status === 'won' || p.status === 'lost')).slice(-n).map(p => p.status === 'won' ? 'W' : 'L');
  }
  analytics(userKey) {
    const w = this.s.wallets[userKey];
    const preds = w ? w.predIds.map(id => this.s.predictions[id]).filter(Boolean) : [];
    const settled = preds.filter(p => p.status === 'won' || p.status === 'lost').sort((a, b) => a.settledAt - b.settledAt);
    let cum = 0, best = 0, cur = 0, bestWinC = 0, oddsSum = 0, stakeSum = 0;
    const series = [], byMarket = {}, byLeague = {}, daily = {};
    for (const p of settled) {
      const pl = p.status === 'won' ? p.payoutC - p.stakeC : -p.stakeC;
      cum += pl; series.push({ t: p.settledAt, pl: toDH(pl), cum: toDH(cum) });
      if (p.status === 'won') { cur++; best = Math.max(best, cur); bestWinC = Math.max(bestWinC, pl); } else cur = 0;
      oddsSum += p.odds; stakeSum += p.stakeC;
      const add = (o, k) => { const e = o[k] || (o[k] = { n: 0, w: 0, plC: 0 }); e.n++; if (p.status === 'won') e.w++; e.plC += pl; };
      add(byMarket, MARKET_LABEL[p.market]); add(byLeague, p.match.league);
      const d = new Date(p.settledAt).toISOString().slice(0, 10); const e = daily[d] || (daily[d] = { date: d, wins: 0, losses: 0, plC: 0 });
      if (p.status === 'won') e.wins++; else e.losses++; e.plC += pl;
    }
    const fmt = o => Object.entries(o).map(([k, e]) => ({ name: k, n: e.n, wins: e.w, winRate: +(e.w / e.n * 100).toFixed(1), profit: toDH(e.plC) })).sort((a, b) => b.n - a.n);
    const n = settled.length, staked = settled.reduce((s, p) => s + p.stakeC, 0);
    return {
      settled: n, series: series.slice(-200), byMarket: fmt(byMarket), byLeague: fmt(byLeague).slice(0, 8),
      daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)).slice(-14).map(e => ({ date: e.date, wins: e.wins, losses: e.losses, profit: toDH(e.plC) })),
      avgOdds: n ? +(oddsSum / n).toFixed(2) : null, avgStake: n ? toDH(stakeSum / n) : null, bestStreak: best, currentStreak: cur,
      biggestWin: toDH(bestWinC), roi: staked ? +(cum / staked * 100).toFixed(1) : null, profit: toDH(cum)
    };
  }
  adminOverview(planOfKey) {
    const ws = Object.values(this.s.wallets), preds = Object.values(this.s.predictions);
    const sum = f => ws.reduce((a, w) => a + f(w), 0);
    const users = ws.map(w => {
      const st = w.stat, settled = st.won + st.lost;
      return { user: w.label || w.user, key: w.user, plan: planOfKey ? planOfKey(w.user) : null, balance: toDH(w.balanceC), predictions: st.placed, pending: w.openIds.length,
        winRate: settled ? +(st.won / settled * 100).toFixed(1) : null, profit: toDH(st.returnedC - st.wonStakeC - st.lostStakeC), recoveries: w.recoveries.length, lastRecoveryAt: w.lastRecoveryAt, since: w.createdAt };
    }).sort((a, b) => b.predictions - a.predictions).slice(0, 100);
    return {
      totals: {
        wallets: ws.length, predictions: preds.length, pending: preds.filter(p => p.status === 'pending').length,
        staked: toDH(sum(w => w.stat.stakedC)), paidOut: toDH(sum(w => w.stat.returnedC)), recoveries: sum(w => w.recoveries.length),
        won: sum(w => w.stat.won), lost: sum(w => w.stat.lost), voided: sum(w => w.stat.voided)
      },
      users, errors: this.s.errors.slice(-50).reverse(), failures: this.s.failures.slice(-50).reverse(),
      audit: this.s.audit.slice(-100).reverse(), config: this.s.config
    };
  }
  setConfig(input, actor, ip) {
    const r = sanitizeConfig(input, this.s.config);
    if (r.errors.length) return { ok: false, errors: r.errors };
    const changed = {};
    for (const k of Object.keys(r.config)) if (r.config[k] !== this.s.config[k]) changed[k] = { from: this.s.config[k], to: r.config[k] };
    this.s.config = r.config;
    if (Object.keys(changed).length) { this.audit(actor, 'config_change', changed, ip); this.touch(); }
    return { ok: true, config: this.s.config, changed };
  }
}

/* ─────────────────────────────── HTTP wiring ─────────────────────────────── */
function create(deps) {
  const { app, authMiddleware, requireAdmin, getSession, planOf, getFeed, lookupMatch, providerStatus, dataLimiter, writeAtomic, makeSaver, file, planOfUserKey } = deps;
  const clock = deps.now || Date.now;

  let state = null;
  try { const fs = require('fs'); if (fs.existsSync(file)) { state = JSON.parse(fs.readFileSync(file, 'utf8')); if (!state || typeof state !== 'object' || Array.isArray(state)) state = null; } }
  catch (e) { console.error('Demo Arena load error:', e.message); state = null; }
  const store = new DemoStore({ now: clock, state });
  store.s.config = sanitizeConfig(store.s.config, Object.assign({}, DEFAULT_CONFIG)).config;
  const saver = makeSaver('DemoArena', () => writeAtomic(file, JSON.stringify(store.s)), 400);
  store.onChange = saver.soon;
  console.log(`🎯 Demo Arena: ${Object.keys(store.s.wallets).length} wallets, ${Object.keys(store.s.predictions).length} predictions`);

  function ident(req, res, next) {
    const sess = getSession(req);
    if (!sess) return res.status(401).json({ error: 'Session expired' });
    req.demo = { key: `${sess.kind === 'keyauth' ? 'key' : 'email'}:${String(sess.username).toLowerCase()}`, label: String(sess.username), plan: planOf(sess), ip: req.ip || null };
    next();
  }
  function userLimiter(max, windowMs, message) {
    const hits = new Map();
    setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n - v.t > windowMs) hits.delete(k); }, Math.min(windowMs, 60000)).unref();
    return (req, res, next) => {
      const k = req.demo.key, n = Date.now();
      let e = hits.get(k);
      if (!e || n - e.t > windowMs) e = { n: 0, t: n };
      if (e.n >= max) { res.setHeader('Retry-After', String(Math.ceil((e.t + windowMs - n) / 1000))); return res.status(429).json({ error: message }); }
      e.n++; hits.set(k, e); next();
    };
  }
  const placeLimit = userLimiter(20, 60 * 1000, 'Too many predictions in a short time. Slow down.');
  const recoverLimit = userLimiter(6, 10 * 60 * 1000, 'Too many recovery attempts. Try again in a few minutes.');
  const readLimit = userLimiter(120, 60 * 1000, 'Too many requests. Slow down.');
  const base = [authMiddleware, ident];
  const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { store.recordError('route', `${req.method} ${req.path}: ${e && e.message}`); console.error('Demo Arena error:', e && e.stack); if (!res.headersSent) res.status(500).json({ error: 'Server error' }); } };

  const SPORTS = [
    { id: 'football', name: 'Football', available: true },
    { id: 'basketball', name: 'Basketball', available: false, reason: 'No basketball data provider is connected yet.' },
    { id: 'tennis', name: 'Tennis', available: false, reason: 'No tennis data provider is connected yet.' }
  ];

  async function dataState() {
    const cfg = store.config, prov = providerStatus();
    if (cfg.dataMode === 'off') return { mode: 'off', configured: prov.configured, fixtures: [], note: 'The sports feed is switched off by the administrator.' };
    if (cfg.dataMode === 'sample' || (cfg.dataMode === 'auto' && !prov.configured)) return { mode: 'sample', configured: prov.configured, fixtures: [], note: 'No sports data provider is connected: the matches below are labelled sample data and cannot be used for predictions.' };
    const feed = await getFeed();
    if (!feed.ok) { store.recordError('feed', feed.error || 'feed error'); return { mode: 'unavailable', configured: true, fixtures: [], note: 'Live sports data is temporarily unavailable. Existing predictions are kept and settle once results are verified.' }; }
    return { mode: 'live', configured: true, fixtures: feed.fixtures, note: null };
  }

  app.get('/api/demo/me', dataLimiter, ...base, readLimit, wrap(async (req, res) => {
    const d = req.demo, cfg = store.config;
    store.settleDue(lookupMatch);
    const wallet = store.walletPublic(d.key, d.plan);
    const prov = providerStatus();
    res.json({
      plan: d.plan, name: d.label.split('@')[0], isAdmin: !!(getSession(req) && deps.isAdminSession && deps.isAdminSession(getSession(req))),
      wallet, recovery: store.recoveryState(d.key, d.plan), recoveries: store.recoveries(d.key), form: store.formGuide(d.key),
      config: { initialBalance: cfg.initialBalance, freeRecoveryDays: cfg.freeRecoveryDays, proRecoveryEnabled: cfg.proRecoveryEnabled, minStake: cfg.minStake, maxStake: cfg.maxStake, maxOpenPredictions: cfg.maxOpenPredictions },
      sports: SPORTS, data: { mode: cfg.dataMode === 'auto' ? (prov.configured ? 'live' : 'sample') : cfg.dataMode, configured: prov.configured }, serverTime: clock()
    });
  }));

  app.get('/api/demo/matches', dataLimiter, ...base, readLimit, wrap(async (req, res) => {
    const sport = String(req.query.sport || 'football'), view = ['live', 'upcoming', 'finished'].includes(req.query.view) ? req.query.view : 'upcoming';
    const sp = SPORTS.find(s => s.id === sport);
    if (!sp) return res.status(400).json({ error: 'Unknown sport' });
    if (!sp.available) return res.json({ sport, view, available: false, reason: sp.reason, data: { mode: 'unavailable', note: sp.reason }, matches: [], serverTime: clock() });
    const ds = await dataState(), now = clock();
    let cards;
    if (ds.mode === 'sample') cards = view === 'upcoming' ? sampleCards(now) : [];
    else {
      cards = ds.fixtures.filter(f => f && f.home && f.away && f.date).map(f => toCard(f, now)).filter(c => c.status === (view === 'upcoming' ? 'notstarted' : view === 'live' ? 'started' : 'finished'));
      if (view === 'upcoming') {
        cards.sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || ''));
        let n = 0; for (const c of [...cards].sort((a, b) => b.big - a.big)) { if (c.featured && n < 6) n++; else c.featured = false; }
      } else cards.sort((a, b) => (b.startsAt || '').localeCompare(a.startsAt || ''));
      cards = cards.slice(0, view === 'upcoming' ? 80 : 60);
    }
    res.json({ sport, view, available: true, data: { mode: ds.mode, configured: ds.configured, note: ds.note }, matches: cards, serverTime: now });
  }));

  app.post('/api/demo/predict', dataLimiter, ...base, placeLimit, wrap(async (req, res) => {
    const d = req.demo, b = req.body || {};
    const ds = await dataState();
    if (ds.mode !== 'live') return res.status(503).json({ error: 'Predictions are only available while live sports data is connected.', code: 'no_live_data' });
    const fx = ds.fixtures.find(f => String(f.id) === String(b.matchId)) || null;
    const r = store.place(d.key, d.plan, { matchId: b.matchId, market: b.market, selection: b.selection, stake: b.stake, odds: b.odds, requestId: b.requestId }, fx, d.ip);
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code, odds: r.odds, balance: r.balance });
    res.json({ ok: true, duplicate: !!r.duplicate, prediction: store.pub(r.prediction, clock()), wallet: store.walletPublic(d.key, d.plan) });
  }));

  app.get('/api/demo/predictions', dataLimiter, ...base, readLimit, wrap(async (req, res) => {
    const d = req.demo, pro = d.plan === 'pro';
    store.settleDue(lookupMatch);
    const filter = ['all', 'active', 'pending', 'won', 'lost', 'void'].includes(req.query.filter) ? req.query.filter : 'all';
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20)), offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    // Free: the 20 most recent predictions. Pro: the full, paginated history.
    const FREE_CAP = 20;
    const r = store.listPredictionsWithCounts(d.key, { filter, offset: pro ? offset : 0, limit: pro ? limit : Math.min(limit, FREE_CAP) });
    const counts = r.counts;
    res.json({ items: r.items, total: r.total, counts, limited: !pro && r.total > FREE_CAP, freeCap: FREE_CAP, plan: d.plan, serverTime: clock() });
  }));

  app.get('/api/demo/transactions', dataLimiter, ...base, readLimit, wrap(async (req, res) => {
    const d = req.demo;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20)), offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    res.json(store.listTransactions(d.key, { offset, limit }));
  }));

  app.post('/api/demo/recover', dataLimiter, ...base, recoverLimit, wrap(async (req, res) => {
    const d = req.demo;
    if ((req.body || {}).confirm !== true) return res.status(400).json({ error: 'Please confirm the recovery.', code: 'confirm_required' });
    const r = store.recover(d.key, d.plan, d.ip);
    if (!r.ok) return res.status(r.status).json({ error: r.error, code: r.code, recovery: r.recovery });
    res.json({ ok: true, wallet: store.walletPublic(d.key, d.plan), recovery: r.recovery, recoveries: store.recoveries(d.key) });
  }));

  app.get('/api/demo/analytics', dataLimiter, ...base, readLimit, wrap(async (req, res) => {
    const d = req.demo;
    store.settleDue(lookupMatch);
    // Basic numbers are part of /api/demo/me for everybody; the detailed analytics are a Pro feature enforced here, on the server.
    if (d.plan !== 'pro') return res.status(403).json({ error: 'Advanced demo analytics are part of the Pro plan.', code: 'pro_required' });
    res.json(store.analytics(d.key));
  }));

  /* ----- administration (server-side role check: same admin rules as the rest of the site) ----- */
  app.get('/api/demo/admin/overview', dataLimiter, authMiddleware, requireAdmin, wrap(async (req, res) => {
    res.json(Object.assign(store.adminOverview(planOfUserKey), { providers: providerStatus(), serverTime: clock() }));
  }));
  app.post('/api/demo/admin/config', dataLimiter, authMiddleware, requireAdmin, wrap(async (req, res) => {
    const sess = getSession(req);
    const r = store.setConfig((req.body || {}).config, String(sess.username), req.ip);
    if (!r.ok) return res.status(400).json({ error: r.errors.join('. '), errors: r.errors });
    res.json({ ok: true, config: r.config, changed: r.changed });
  }));
  app.post('/api/demo/admin/settle', dataLimiter, authMiddleware, requireAdmin, wrap(async (req, res) => {
    await runSettlement();
    store.audit(String(getSession(req).username), 'settle_now', null, req.ip);
    res.json({ ok: true, totals: store.adminOverview(planOfUserKey).totals });
  }));

  /* ----- settlement scheduler ----- */
  let running = false;
  async function runSettlement() {
    if (running) return null;
    running = true;
    try {
      const f = await getFeed();                       // refreshes the shared fixtures cache
      if (!f.ok) store.recordError('feed', f.error || 'feed error');
      return store.settleDue(lookupMatch);
    } catch (e) { store.recordError('settlement', e.message); return null; }
    finally { running = false; }
  }
  setTimeout(runSettlement, 30 * 1000).unref();
  setInterval(runSettlement, 2 * 60 * 1000).unref();

  return { store, saver, runSettlement };
}

module.exports = { create, DemoStore, DEFAULT_CONFIG, sanitizeConfig, consensusOdds, oddsFor, toCard, sampleCards, outcomeOf, startMs, MIN_MATCH_MS };
