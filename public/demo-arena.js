/* Demo Arena frontend. Virtual credits only: no deposits, no real-money stakes, no withdrawals.
   The browser only displays what the server says (balance, odds, plan, results) and sends intentions (stake, selection). */
(function () {
  'use strict';

  const $root = () => document.getElementById('view-demo');
  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const dh = n => nf.format(n) + ' DH';
  const sgn = n => (n > 0 ? '+' : n < 0 ? '−' : '') + nf.format(Math.abs(n));
  const pct = n => (n == null ? '–' : nf.format(n) + '%');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = ts => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = ts => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const I = (d, extra) => `<svg viewBox="0 0 24 24" aria-hidden="true"${extra || ''}>${d}</svg>`;
  const ICON = {
    trophy: I('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a4 4 0 0 1-4 4M7 5H4v2a4 4 0 0 0 4 4"/>'),
    football: I('<circle cx="12" cy="12" r="9"/><path d="M12 8l3.5 2.5-1.3 4.1H9.8L8.5 10.5z"/><path d="M12 3v5M20.5 9.5l-5-1M17.5 19l-3.3-4.4M6.5 19l3.3-4.4M3.5 9.5l5-1"/>'),
    basket: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8"/>'),
    tennis: I('<circle cx="12" cy="12" r="9"/><path d="M5.2 5.6c4 2.6 4 10.2 0 12.8M18.8 5.6c-4 2.6-4 10.2 0 12.8"/>'),
    info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    lock: I('<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>'),
    refresh: I('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
    bolt: I('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>')
  };
  const SPORT_ICON = { football: ICON.football, basketball: ICON.basket, tennis: ICON.tennis };

  const S = {
    built: false, me: null, section: 'arena', sport: 'football', view: 'upcoming',
    matches: null, matchesBusy: false, preds: null, predFilter: 'all', predMore: false, analytics: null, analyticsErr: null,
    tx: { items: [], total: 0 }, admin: null, adminErr: null, slip: null, shownBalance: null, seq: 0, lastLoad: 0, poll: 0, tick: 0
  };

  /* ---------------- network ---------------- */
  async function api(path, opts) {
    opts = opts || {};
    try {
      const r = await fetch('/api/demo' + path, {
        method: opts.method || 'GET', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authState.token },
        body: opts.body ? JSON.stringify(opts.body) : undefined
      });
      const json = await r.json().catch(() => null);
      return { ok: r.ok, status: r.status, json: json || {} };
    } catch (e) {
      return { ok: false, status: 0, json: { error: 'No connection. Check your internet and try again.' } };
    }
  }

  /* ---------------- small helpers ---------------- */
  function toast(msg, kind) {
    let box = document.getElementById('daToasts');
    if (!box) { box = document.createElement('div'); box.id = 'daToasts'; box.className = 'da da-toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'da-toast ' + (kind || ''); t.textContent = msg; box.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 4200);
  }
  function initials(n) { return String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase(); }
  function crest(t) {
    return `<span class="da-crest" data-ini="${esc(initials(t.name))}">${t.logo ? `<img src="${esc(t.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : esc(initials(t.name))}</span>`;
  }
  function countdown(ms) {
    if (ms <= 0) return 'now';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${String(m).padStart(2, '0')}m ${String(x).padStart(2, '0')}s`;
  }
  function animateNumber(el, from, to) {
    if (!el) return;
    if (reduce() || from == null || from === to) { el.textContent = nf.format(to); return; }
    const t0 = performance.now(), dur = 800;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = nf.format(Math.round((from + (to - from) * e) * 100) / 100);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ---------------- modal ---------------- */
  let modalEl = null, modalFrom = null;
  function openModal(html) {
    closeModal();
    modalFrom = document.activeElement;
    modalEl = document.createElement('div');
    modalEl.className = 'da da-ov'; modalEl.setAttribute('role', 'dialog'); modalEl.setAttribute('aria-modal', 'true');
    modalEl.innerHTML = `<div class="da-modal">${html}</div>`;
    modalEl.addEventListener('mousedown', e => { if (e.target === modalEl) closeModal(); });
    modalEl.addEventListener('click', onClick);
    modalEl.addEventListener('input', onInput);
    document.body.appendChild(modalEl);
    const f = modalEl.querySelector('input,button.da-btn'); if (f) f.focus();
    return modalEl.querySelector('.da-modal');
  }
  function closeModal() {
    if (!modalEl) return;
    modalEl.remove(); modalEl = null; S.slip = null;
    if (modalFrom && modalFrom.focus) { try { modalFrom.focus(); } catch (e) {} }
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && modalEl) closeModal(); });

  /* ---------------- shell ---------------- */
  function build() {
    $root().innerHTML = `<div class="da"><div class="da-stage">
      <div id="daHero"></div>
      <div class="da-tabs" id="daTabs" role="tablist" aria-label="Demo Arena sections"></div>
      <div id="daBody"></div>
      <p class="da-legal">Demo Arena uses virtual credits only. No deposits, no real-money stakes and no withdrawals. Virtual credits have no cash value and cannot be exchanged for money or prizes.</p>
    </div></div>`;
    const r = $root();
    r.addEventListener('click', onClick);
    r.addEventListener('input', onInput);
    r.addEventListener('error', e => {
      const t = e.target;
      if (t && t.tagName === 'IMG' && t.parentElement && t.parentElement.classList.contains('da-crest')) t.parentElement.textContent = t.parentElement.dataset.ini || '';
    }, true);
    S.built = true;
  }

  function planChip() { return S.me && S.me.plan === 'pro' ? '<span class="da-chip pro">Pro</span>' : '<span class="da-chip free">Free</span>'; }

  function pitch() {
    return `<svg class="da-pitch" viewBox="0 0 800 400" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="20" y="20" width="760" height="360" rx="10"/><path d="M400 20v360"/><circle cx="400" cy="200" r="62"/><circle cx="400" cy="200" r="3.5" fill="currentColor"/>
      <rect x="20" y="105" width="118" height="190"/><rect x="662" y="105" width="118" height="190"/><rect x="20" y="152" width="48" height="96"/><rect x="732" y="152" width="48" height="96"/>
      <path d="M138 165a52 52 0 0 1 0 70M662 165a52 52 0 0 0 0 70"/></svg>`;
  }

  function recoveryBlock() {
    const r = S.me.recovery, pro = S.me.plan === 'pro', c = S.me.config;
    let body = '';
    if (r.allowed) {
      body = `<p>${r.unlimited ? 'Pro members can restore their balance whenever they need to.' : 'Your free recovery is ready to use.'}</p>
        <button class="da-btn block" data-act="recover">${ICON.refresh}Recover to ${dh(r.target)}</button>`;
    } else if (r.cooling) {
      body = `<p>Your next free recovery opens in</p><div class="da-count" data-countdown="${r.nextAt}">${countdown(r.nextAt - Date.now())}</div>
        <p class="da-muted">Available on ${esc(when(r.nextAt))}</p>
        ${pro ? '' : `<button class="da-btn ghost sm" data-act="unlock">Recover anytime with Pro</button>`}`;
    } else {
      body = `<p>Your balance is at ${dh(r.target)} or more. Recovery opens when it drops below that.</p>
        ${r.unlimited ? '<p class="da-muted">As a Pro member you can recover at any time after that.</p>' : `<p class="da-muted">Free plan: one recovery every ${r.intervalDays} days.</p>`}`;
    }
    return `<div class="da-glass da-recov"><h3>Balance recovery ${planChip()}</h3>${body}</div>`;
  }

  function renderHero() {
    const el = document.getElementById('daHero'); if (!el || !S.me) return;
    const w = S.me.wallet;
    el.innerHTML = `<section class="da-hero" aria-label="Your demo wallet">${pitch()}
      <div>
        <div class="da-brand"><span class="ic">${ICON.trophy}</span><div>Demo Arena<small>Virtual Sports Predictions</small></div></div>
        <h1>Welcome back, ${esc(S.me.name)}</h1>
        <div class="da-bal-l">Available demo balance</div>
        <div class="da-balrow"><div class="da-bal"><b id="daBal">${nf.format(S.shownBalance == null ? w.balance : S.shownBalance)}</b><span>DH</span></div>
        <div class="da-mini">
          <div><small>Win rate</small><b>${pct(w.winRate)}</b></div>
          <div><small>Profit / loss</small><b class="${w.profit > 0 ? 'da-pos' : w.profit < 0 ? 'da-neg' : ''}">${sgn(w.profit)} DH</b></div>
          <div><small>Open</small><b>${w.pending}</b></div>
        </div></div>
      </div>
      ${recoveryBlock()}</section>`;
    animateNumber(document.getElementById('daBal'), S.shownBalance, w.balance);
    S.shownBalance = w.balance;
  }

  function renderTabs() {
    const el = document.getElementById('daTabs'); if (!el || !S.me) return;
    const tabs = [['arena', 'Arena'], ['predictions', 'My predictions'], ['analytics', 'Analytics'], ['wallet', 'Wallet']];
    if (S.me.isAdmin) tabs.push(['admin', 'Admin']);
    el.innerHTML = tabs.map(([k, l]) => `<button class="da-tab ${S.section === k ? 'on' : ''}" role="tab" aria-selected="${S.section === k}" data-act="section" data-k="${k}">${l}${k === 'predictions' && S.me.wallet.pending ? `<span class="n">${S.me.wallet.pending}</span>` : ''}</button>`).join('');
  }

  function renderBody() {
    const el = document.getElementById('daBody'); if (!el) return;
    if (!S.me) { el.innerHTML = '<div class="da-skel"></div>'; return; }
    ({ arena: renderArena, predictions: renderPreds, analytics: renderAnalytics, wallet: renderWallet, admin: renderAdmin }[S.section] || renderArena)(el);
  }
  function renderAll() { renderHero(); renderTabs(); renderBody(); }

  /* ---------------- arena ---------------- */
  function dataNote(d) {
    if (!d) return '';
    if (d.mode === 'sample') return `<div class="da-note">${ICON.info}<div><b>Sample data.</b> No sports data provider is connected, so these matches are examples and cannot take predictions. Real fixtures and odds appear automatically once a provider is configured.</div></div>`;
    if (d.mode === 'unavailable') return `<div class="da-note warn">${ICON.info}<div><b>Live data is unavailable right now.</b> ${esc(d.note || '')}</div></div>`;
    if (d.mode === 'off') return `<div class="da-note warn">${ICON.info}<div><b>The sports feed is switched off.</b> Your existing predictions are kept.</div></div>`;
    return '';
  }

  function oddBtn(m, market, sel, label, odds) {
    if (m.sample || !m.bettable) return `<div class="da-odd"><small>${esc(label)}</small><b>${odds.toFixed(2)}</b></div>`;
    return `<button class="da-odd" data-act="odd" data-id="${esc(m.id)}" data-market="${market}" data-sel="${sel}" aria-label="${esc(label)}, odds ${odds.toFixed(2)}"><small>${esc(label)}</small><b>${odds.toFixed(2)}</b></button>`;
  }
  function matchCard(m, feat) {
    const chip = m.live ? '<span class="da-chip live"><i></i>Live</span>' : m.status === 'finished' ? '<span class="da-chip">Final</span>' : `<span class="da-chip soon">${esc(m.startsAt ? clock(m.startsAt) : 'Scheduled')}</span>`;
    const mid = m.live || m.status === 'finished'
      ? `<b>${m.homeScore == null ? '-' : m.homeScore} - ${m.awayScore == null ? '-' : m.awayScore}</b><small>${m.live ? 'In play' : 'Full time'}</small>`
      : `<b>${esc(m.startsAt ? clock(m.startsAt) : '--:--')}</b><small>${esc(m.startsAt ? day(m.startsAt) : '')}</small>`;
    const x = m.markets.x12, o = m.markets.ou25;
    let mk = '';
    if (x) mk += `<div class="da-mkl">Match result</div><div class="da-row c3">${oddBtn(m, '1x2', 'home', m.home.name, x.home)}${oddBtn(m, '1x2', 'draw', 'Draw', x.draw)}${oddBtn(m, '1x2', 'away', m.away.name, x.away)}</div>`;
    if (o) mk += `<div class="da-mkl">Goals</div><div class="da-row c2">${oddBtn(m, 'ou25', 'over', 'Over 2.5', o.over)}${oddBtn(m, 'ou25', 'under', 'Under 2.5', o.under)}</div>`;
    if (!x && !o) mk = '<div class="da-mkl">Odds are not available for this match.</div>';
    const foot = m.sample ? '<span class="da-chip sample">Sample data</span>'
      : m.bettable ? `<span>Demo odds from the market median${m.books > 1 ? ` of ${m.books} bookmakers` : ''}</span>`
      : m.status === 'notstarted' ? '<span>Predictions are not open for this match.</span>' : '<span>Predictions are closed.</span>';
    return `<article class="da-card ${feat ? 'feat' : ''}">
      <div class="da-mh"><span>${esc(m.league)}</span>${chip}</div>
      <div class="da-teams"><div class="da-team">${crest(m.home)}<span>${esc(m.home.name)}</span></div><div class="da-mid">${mid}</div><div class="da-team">${crest(m.away)}<span>${esc(m.away.name)}</span></div></div>
      <div class="da-mk">${mk}</div><div class="da-foot">${foot}</div></article>`;
  }

  function renderArena(el) {
    const sports = (S.me.sports || []).map(s => `<button class="da-pill ${S.sport === s.id ? 'on' : ''}" data-act="sport" data-k="${s.id}">${SPORT_ICON[s.id] || ''}${esc(s.name)}</button>`).join('');
    const views = [['live', 'Live'], ['upcoming', 'Upcoming'], ['finished', 'Finished']].map(([k, l]) => `<button class="da-pill ${S.view === k ? 'on' : ''}" data-act="view" data-k="${k}">${k === 'live' ? '<span class="da-chip live" style="padding:0;background:none"><i></i></span>' : ''}${l}</button>`).join('');
    let content;
    const M = S.matches;
    if (!M || S.matchesBusy && !M.matches) content = '<div class="da-grid"><div class="da-skel"></div><div class="da-skel"></div><div class="da-skel"></div></div>';
    else if (M.available === false) content = `<div class="da-empty"><b>${esc((S.me.sports.find(s => s.id === S.sport) || {}).name || 'This sport')} is not available yet</b>${esc(M.reason || 'No data provider is connected for this sport.')}<br>Football predictions are open now.<br><button class="da-btn ghost sm" data-act="sport" data-k="football">Go to football</button></div>`;
    else {
      const list = M.matches || [], feats = S.view === 'upcoming' ? list.filter(m => m.featured && !m.sample) : [];
      const rest = feats.length ? list.filter(m => !feats.includes(m)) : list;
      content = dataNote(M.data);
      if (feats.length) content += `<div class="da-sec-h"><h2>Featured matches</h2><p>Big teams with open predictions</p></div><div class="da-feats">${feats.map(m => matchCard(m, true)).join('')}</div>`;
      if (rest.length || !feats.length) content += `<div class="da-sec-h"><h2>${S.view === 'live' ? 'Live matches' : S.view === 'finished' ? 'Finished matches' : feats.length ? 'More upcoming matches' : 'Upcoming matches'}</h2><p>${rest.length} match${rest.length === 1 ? '' : 'es'}</p></div>`;
      if (!rest.length && !feats.length) {
        const msg = S.view === 'live' ? ['No live matches right now', 'Matches show here while they are being played.'] : S.view === 'finished' ? ['No finished matches yet', 'Results from the last 3 days appear here.'] : ['No upcoming matches', 'New fixtures appear here as soon as they are published.'];
        content += `<div class="da-empty"><b>${msg[0]}</b>${msg[1]}</div>`;
      } else if (rest.length) content += `<div class="da-grid">${rest.map(m => matchCard(m, false)).join('')}</div>`;
    }
    el.innerHTML = `<div class="da-bar"><div class="da-pills" role="group" aria-label="Sport">${sports}</div><div class="da-pills" role="group" aria-label="Matches">${views}</div></div>${content}`;
  }

  /* ---------------- prediction slip ---------------- */
  function slipHTML() {
    const s = S.slip, w = S.me.wallet, c = S.me.config, max = Math.max(0, Math.min(c.maxStake, Math.floor(w.balance)));
    const chips = [10, 50, 100, 250, 500].filter(v => v >= c.minStake && v <= max).map(v => `<button type="button" class="da-pill" data-act="chip" data-v="${v}">${v}</button>`).join('') + (max >= c.minStake ? `<button type="button" class="da-pill" data-act="chip" data-v="${max}">Max ${max}</button>` : '');
    return `<h3>Virtual prediction</h3>
      <p class="sub">${esc(s.m.home.name)} vs ${esc(s.m.away.name)}<br>${esc(s.m.league)}</p>
      <div class="da-sel"><div><small class="da-muted">${s.market === '1x2' ? 'Match result' : 'Total goals'}</small><br><b>${esc(s.label)}</b></div><div class="o" id="daSlipOdds">${s.odds.toFixed(2)}</div></div>
      <label for="daStake" class="da-mkl">Virtual stake (DH)</label>
      <input id="daStake" class="da-input" type="number" inputmode="numeric" min="${c.minStake}" max="${max}" step="1" value="${s.stake}" autocomplete="off">
      <div class="da-chips">${chips}</div>
      <div class="da-sum"><div><span class="da-muted">Potential virtual return</span><b id="daSlipRet">-</b></div><div><span class="da-muted">Balance after stake</span><b id="daSlipBal">-</b></div></div>
      <div class="da-err" id="daSlipErr" role="alert">${esc(s.err || '')}</div>
      <div class="acts"><button class="da-btn ghost" data-act="close">Cancel</button><button class="da-btn" id="daSlipGo" data-act="place">Place prediction</button></div>
      <p class="da-legal" style="margin-top:12px">Virtual credits only. No real money is used.</p>`;
  }
  function slipRefresh() {
    const s = S.slip; if (!s || !modalEl) return;
    const w = S.me.wallet, c = S.me.config, max = Math.min(c.maxStake, Math.floor(w.balance));
    const v = Number(document.getElementById('daStake').value);
    const ok = Number.isInteger(v) && v >= c.minStake && v <= max;
    s.stake = v;
    document.getElementById('daSlipRet').textContent = ok ? dh(Math.round(v * s.odds * 100) / 100) : '-';
    document.getElementById('daSlipBal').textContent = ok ? dh(w.balance - v) : dh(w.balance);
    document.getElementById('daSlipOdds').textContent = s.odds.toFixed(2);
    const err = document.getElementById('daSlipErr');
    if (!s.err) err.textContent = ok ? '' : max < c.minStake ? 'Your balance is too low to place a prediction. Use a recovery to restore it.' : `Enter a whole number between ${c.minStake} and ${max} DH.`;
    document.getElementById('daSlipGo').disabled = !ok || s.busy;
  }
  function openSlip(id, market, sel, odds) {
    const m = ((S.matches && S.matches.matches) || []).find(x => x.id === id); if (!m) return;
    const label = market === '1x2' ? (sel === 'home' ? m.home.name + ' Win' : sel === 'away' ? m.away.name + ' Win' : 'Draw') : (sel === 'over' ? 'Over 2.5 Goals' : 'Under 2.5 Goals');
    const w = S.me.wallet, c = S.me.config;
    const rid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40).padEnd(8, '0');
    S.slip = { m, market, sel, label, odds, requestId: rid, stake: Math.max(c.minStake, Math.min(100, c.maxStake, Math.floor(w.balance))), busy: false, err: '' };
    openModal(slipHTML()); slipRefresh();
  }
  async function placeSlip() {
    const s = S.slip; if (!s || s.busy) return;
    s.busy = true; s.err = ''; slipRefresh();
    const btn = document.getElementById('daSlipGo'); if (btn) btn.textContent = 'Placing…';
    const r = await api('/predict', { method: 'POST', body: { matchId: s.m.id, market: s.market, selection: s.sel, stake: s.stake, odds: s.odds, requestId: s.requestId } });
    if (!S.slip) return;
    s.busy = false;
    if (r.ok) {
      S.me.wallet = r.json.wallet; S.preds = null; closeModal();
      toast(`Prediction placed: ${s.label} at ${s.odds.toFixed(2)}, stake ${dh(s.stake)}`, 'ok');
      renderAll(); loadMe(true);
      return;
    }
    if (r.json.code === 'odds_changed' && r.json.odds) { s.odds = r.json.odds; s.err = `The odds changed to ${r.json.odds.toFixed(2)}. Check the return and confirm again.`; }
    else { s.err = r.json.error || 'Could not place the prediction. Try again.'; if (r.json.code === 'closed' || r.json.code === 'match_not_found') loadMatches(); }
    if (r.json.balance != null) S.me.wallet.balance = r.json.balance;
    if (btn) btn.textContent = 'Place prediction';
    document.getElementById('daSlipErr').textContent = s.err; slipRefresh();
  }

  /* ---------------- recovery ---------------- */
  function openRecovery() {
    const r = S.me.recovery, pro = S.me.plan === 'pro';
    openModal(`<h3>Recover your virtual balance?</h3>
      <p class="sub">Your balance will be set to <b>${dh(r.target)}</b>. Virtual credits have no cash value.</p>
      <div class="da-sum"><div><span class="da-muted">Balance now</span><b>${dh(S.me.wallet.balance)}</b></div><div><span class="da-muted">Balance after</span><b>${dh(r.target)}</b></div></div>
      <p class="da-legal">${pro && r.unlimited ? 'Pro: you can recover again whenever you need to.' : `Free plan: you can recover again in ${r.intervalDays} days.`} Predictions you already placed stay open.</p>
      <div class="da-err" id="daRecErr" role="alert"></div>
      <div class="acts"><button class="da-btn ghost" data-act="close">Not now</button><button class="da-btn" id="daRecGo" data-act="recover-confirm">Recover balance</button></div>`);
  }
  async function confirmRecovery() {
    const b = document.getElementById('daRecGo'); if (b) { b.disabled = true; b.textContent = 'Recovering…'; }
    const r = await api('/recover', { method: 'POST', body: { confirm: true } });
    if (r.ok) { S.me.wallet = r.json.wallet; S.me.recovery = r.json.recovery; S.me.recoveries = r.json.recoveries; S.tx = { items: [], total: 0 }; closeModal(); toast(`Balance recovered to ${dh(r.json.wallet.balance)}`, 'ok'); renderAll(); return; }
    if (r.json.recovery) S.me.recovery = r.json.recovery;
    const e = document.getElementById('daRecErr'); if (e) e.textContent = r.json.error || 'Recovery failed. Try again.';
    if (b) { b.disabled = false; b.textContent = 'Recover balance'; }
    renderHero();
  }

  /* ---------------- predictions ---------------- */
  const REASON = { match_canceled: 'Match cancelled', unresolved: 'No verified result' };
  function predCard(p) {
    const chip = p.phase === 'won' ? '<span class="da-chip won">Won</span>' : p.phase === 'lost' ? '<span class="da-chip lost">Lost</span>' : p.phase === 'void' ? '<span class="da-chip void">Refunded</span>' : p.phase === 'active' ? '<span class="da-chip act">In play</span>' : '<span class="da-chip soon">Pending</span>';
    let line;
    if (p.status === 'won') line = `Returned ${dh(p.payout)}${p.score ? ', final score ' + esc(p.score) : ''}`;
    else if (p.status === 'lost') line = `Lost ${dh(p.stake)}${p.score ? ', final score ' + esc(p.score) : ''}`;
    else if (p.status === 'void') line = `${dh(p.stake)} refunded: ${esc(REASON[p.voidReason] || 'match void')}`;
    else line = `Potential return ${dh(p.potential)}`;
    return `<article class="da-pred"><div><div class="t">${esc(p.selectionLabel)}</div><div class="s">${esc(p.home.name)} vs ${esc(p.away.name)}</div><div class="s">${esc(p.league)}, ${esc(p.marketLabel)}</div></div>
      <div class="r"><b>${dh(p.stake)}</b><small>at ${p.odds.toFixed(2)}</small></div><div class="f">${chip}<span>${line}</span></div></article>`;
  }
  function renderPreds(el) {
    const P = S.preds;
    const f = [['all', 'All'], ['active', 'In play'], ['pending', 'Pending'], ['won', 'Won'], ['lost', 'Lost'], ['void', 'Refunded']];
    const bar = f.map(([k, l]) => `<button class="da-pill ${S.predFilter === k ? 'on' : ''}" data-act="pfilter" data-k="${k}">${l}${P && P.counts ? `<span class="n">${P.counts[k]}</span>` : ''}</button>`).join('');
    let list;
    if (!P) list = '<div class="da-list"><div class="da-skel" style="height:88px"></div><div class="da-skel" style="height:88px"></div></div>';
    else if (!P.items.length) list = `<div class="da-empty"><b>${P.counts.all ? 'Nothing in this list' : 'No predictions yet'}</b>${P.counts.all ? 'Try another filter.' : 'Pick a match in the Arena and place your first virtual prediction.'}${P.counts.all ? '' : '<br><button class="da-btn sm" data-act="section" data-k="arena">Browse matches</button>'}</div>`;
    else list = `<div class="da-list">${P.items.map(predCard).join('')}</div>` + (S.me.plan === 'pro' && P.items.length < P.total ? '<div style="text-align:center;margin-top:14px"><button class="da-btn ghost" data-act="pmore">Load more</button></div>' : '');
    const lim = P && P.limited ? `<div class="da-note">${ICON.lock}<div>You are seeing your latest ${P.freeCap} predictions. <b>Pro</b> unlocks your full, searchable history. <a href="#" data-act="unlock" style="color:#fff;font-weight:700">See Pro</a></div></div>` : '';
    el.innerHTML = `<div class="da-bar"><div class="da-pills" role="group" aria-label="Filter predictions">${bar}</div></div><div style="margin-top:14px">${lim}${list}</div>`;
  }

  /* ---------------- analytics ---------------- */
  function ring(rate) {
    const r = 46, c = 2 * Math.PI * r, v = rate == null ? 0 : Math.max(0, Math.min(100, rate));
    return `<div class="da-ring"><svg viewBox="0 0 120 120" width="130" height="130" aria-hidden="true"><defs><linearGradient id="daRg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3D7BFF"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs><circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="10"/><circle cx="60" cy="60" r="${r}" fill="none" stroke="url(#daRg)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/></svg><b>${rate == null ? '–' : Math.round(rate) + '%'}</b></div>`;
  }
  function lineChart(series) {
    if (!series.length) return '<div class="da-empty"><b>No settled predictions yet</b>Your profit curve appears after your first result.</div>';
    const W = 640, H = 220, pad = 28, pts = [{ cum: 0 }].concat(series), vals = pts.map(p => p.cum);
    const min = Math.min(0, ...vals), max = Math.max(0, ...vals), span = (max - min) || 1;
    const X = i => pad + (W - pad * 2) * (pts.length === 1 ? 0 : i / (pts.length - 1)), Y = v => H - pad - (H - pad * 2) * ((v - min) / span);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.cum).toFixed(1)).join(' ');
    const area = d + ` L${X(pts.length - 1).toFixed(1)} ${Y(min).toFixed(1)} L${X(0).toFixed(1)} ${Y(min).toFixed(1)}Z`;
    const last = pts[pts.length - 1];
    return `<svg class="da-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative profit and loss in virtual credits"><defs><linearGradient id="daAr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6D7BFF" stop-opacity=".45"/><stop offset="1" stop-color="#6D7BFF" stop-opacity="0"/></linearGradient><linearGradient id="daLn" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3D7BFF"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient></defs>
      <line x1="${pad}" x2="${W - pad}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="rgba(255,255,255,.18)" stroke-dasharray="4 5"/>
      <path d="${area}" fill="url(#daAr)"/><path d="${d}" fill="none" stroke="url(#daLn)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(last.cum).toFixed(1)}" r="5" fill="#fff"/>
      <text x="${pad}" y="14">${sgn(max)} DH</text><text x="${pad}" y="${H - 6}">${sgn(min)} DH</text><text x="${W - pad}" y="14" text-anchor="end">Now ${sgn(last.cum)} DH</text></svg>`;
  }
  function dailyBars(days) {
    if (!days.length) return '';
    const W = 640, H = 170, pad = 24, mx = Math.max(1, ...days.map(d => d.wins + d.losses)), bw = (W - pad * 2) / days.length;
    return `<svg class="da-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wins and losses per day">${days.map((d, i) => {
      const x = pad + i * bw + bw * .2, w = bw * .6, hw = (H - pad * 2) * d.wins / mx, hl = (H - pad * 2) * d.losses / mx;
      return `<rect x="${x.toFixed(1)}" y="${(H - pad - hw).toFixed(1)}" width="${w.toFixed(1)}" height="${hw.toFixed(1)}" rx="4" fill="#34D399"/><rect x="${x.toFixed(1)}" y="${(H - pad - hw - hl - (hw && hl ? 2 : 0)).toFixed(1)}" width="${w.toFixed(1)}" height="${hl.toFixed(1)}" rx="4" fill="#FB7185"/><text x="${(x + w / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(d.date.slice(5).replace('-', '/'))}</text>`;
    }).join('')}</svg>`;
  }
  function breakdown(rows, title) {
    if (!rows.length) return '';
    return `<div class="da-panel"><h3>${title}</h3><div class="da-scroll"><table class="da-table"><thead><tr><th>Name</th><th>Predictions</th><th>Win rate</th><th>Profit</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.name)}</td><td>${r.n}</td><td>${pct(r.winRate)}</td><td class="${r.profit >= 0 ? 'da-pos' : 'da-neg'}">${sgn(r.profit)} DH</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  function renderAnalytics(el) {
    const w = S.me.wallet, pro = S.me.plan === 'pro', A = S.analytics;
    const basic = `<div class="da-tiles" style="margin-top:14px">
      <div class="da-tile"><small>Win rate</small>${ring(w.winRate)}</div>
      <div class="da-tile"><small>Profit / loss</small><b class="${w.profit > 0 ? 'da-pos' : w.profit < 0 ? 'da-neg' : ''}">${sgn(w.profit)} DH</b></div>
      <div class="da-tile"><small>Return on stakes</small><b>${w.roi == null ? '–' : sgn(w.roi) + '%'}</b></div>
      <div class="da-tile"><small>Predictions</small><b>${w.predictions}</b><small>${w.wins} won, ${w.losses} lost, ${w.pending} open</small></div></div>
      <div class="da-panel" style="margin-top:14px"><h3>Last 10 results</h3>${(S.me.form || []).length ? `<div class="da-form">${S.me.form.map(f => `<i class="${f}" title="${f === 'W' ? 'Won' : 'Lost'}">${f}</i>`).join('')}</div>` : '<p class="da-muted">Results appear once your predictions are settled.</p>'}</div>`;
    let adv;
    if (!pro) {
      adv = `<div class="da-lock" style="margin-top:14px"><div class="blur"><div class="da-two"><div class="da-panel"><h3>Profit curve</h3><div class="da-skel" style="height:170px"></div></div><div class="da-panel"><h3>By market</h3><div class="da-skel" style="height:170px"></div></div></div></div>
        <div class="cta">${ICON.lock.replace('<svg', '<svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"')}<b>Advanced demo analytics are part of Pro</b><span class="da-muted">Profit curve, daily results, market and league breakdown, streaks and full prediction history.</span><button class="da-btn" data-act="unlock">See Pro</button></div></div>`;
    } else if (S.analyticsErr) adv = `<div class="da-empty"><b>Could not load analytics</b>${esc(S.analyticsErr)}<br><button class="da-btn ghost sm" data-act="retry">Try again</button></div>`;
    else if (!A) adv = '<div class="da-skel" style="height:240px;margin-top:14px"></div>';
    else adv = `<div class="da-two" style="margin-top:14px"><div class="da-panel"><h3>Profit curve</h3>${lineChart(A.series)}</div><div class="da-panel"><h3>Results per day</h3>${dailyBars(A.daily) || '<p class="da-muted">No settled predictions yet.</p>'}</div></div>
      <div class="da-tiles" style="margin-top:14px"><div class="da-tile"><small>Average odds</small><b>${A.avgOdds == null ? '–' : A.avgOdds.toFixed(2)}</b></div><div class="da-tile"><small>Average stake</small><b>${A.avgStake == null ? '–' : dh(A.avgStake)}</b></div><div class="da-tile"><small>Best winning streak</small><b>${A.bestStreak}</b></div><div class="da-tile"><small>Current streak</small><b>${A.currentStreak}</b></div><div class="da-tile"><small>Biggest win</small><b>${dh(A.biggestWin)}</b></div></div>
      <div class="da-two" style="margin-top:14px">${breakdown(A.byMarket, 'By market')}${breakdown(A.byLeague, 'By league')}</div>`;
    el.innerHTML = `<div class="da-sec-h"><h2>Performance</h2><p>All numbers use virtual credits</p></div>${basic}${adv}`;
  }

  /* ---------------- wallet ---------------- */
  const TXN = { grant: 'Welcome credits', stake: 'Prediction placed', win: 'Prediction won', loss: 'Prediction lost', refund: 'Stake refunded', recovery: 'Balance recovery' };
  function renderWallet(el) {
    const w = S.me.wallet, c = S.me.config;
    const rec = (S.me.recoveries || []).map(r => `<div class="da-tx"><div><b>Recovered to ${dh(r.after)}</b><br><small>From ${dh(r.before)}, ${esc(r.plan === 'pro' ? 'Pro' : 'Free')} plan</small></div><div class="a">${esc(when(r.at))}</div></div>`).join('') || '<p class="da-muted">No recoveries yet.</p>';
    const tx = S.tx.items.map(t => `<div class="da-tx"><div><b>${esc(TXN[t.type] || t.type)}</b><br><small>${esc(t.note || '')}</small><br><small>${esc(when(t.at))}</small></div><div class="a ${t.amount > 0 ? 'da-pos' : t.amount < 0 ? 'da-neg' : 'da-muted'}">${t.amount === 0 ? '0' : sgn(t.amount)} DH<br><small class="da-muted" style="font-weight:600">Balance ${dh(t.balance)}</small></div></div>`).join('');
    el.innerHTML = `<div class="da-sec-h"><h2>Virtual wallet</h2><p>Credits for entertainment and learning only</p></div>
      <div class="da-tiles"><div class="da-tile"><small>Available demo balance</small><b>${dh(w.balance)}</b></div><div class="da-tile"><small>Virtual credits used</small><b>${dh(w.used)}</b></div><div class="da-tile"><small>Virtual credits won</small><b class="da-pos">${dh(w.won)}</b></div><div class="da-tile"><small>Virtual credits lost</small><b class="da-neg">${dh(w.lost)}</b></div><div class="da-tile"><small>Predictions</small><b>${w.predictions}</b></div><div class="da-tile"><small>Win rate</small><b>${pct(w.winRate)}</b></div></div>
      <div class="da-wal" style="margin-top:14px"><div>${recoveryBlock()}
        <div class="da-panel" style="margin-top:14px"><h3>How recovery works</h3><ul class="da-rules"><li>Everyone starts with ${dh(c.initialBalance)} of virtual credits.</li><li>Free plan: one recovery every ${c.freeRecoveryDays} days, back to ${dh(c.initialBalance)}.</li><li>Pro plan: recover whenever you want.</li><li>You can recover when your balance is below ${dh(c.initialBalance)}.</li><li>Virtual credits cannot be cashed out.</li></ul></div>
        <div class="da-panel" style="margin-top:14px"><h3>Recovery history</h3>${rec}</div></div>
        <div class="da-panel"><h3>Transaction history</h3>${tx || '<div class="da-skel" style="height:90px"></div>'}${S.tx.items.length < S.tx.total ? '<div style="text-align:center;margin-top:12px"><button class="da-btn ghost sm" data-act="txmore">Load more</button></div>' : ''}</div></div>`;
  }

  /* ---------------- admin ---------------- */
  const FIELDS = [
    ['initialBalance', 'Starting demo balance (DH)', 'number', 'Given to new wallets and restored by a recovery.'],
    ['freeRecoveryDays', 'Free recovery interval (days)', 'number', 'How long a Free user waits between recoveries.'],
    ['proRecoveryEnabled', 'Pro can recover any time', 'check', 'When off, Pro follows the Free interval.'],
    ['minStake', 'Minimum stake (DH)', 'number', ''], ['maxStake', 'Maximum stake (DH)', 'number', ''],
    ['maxOpenPredictions', 'Open predictions per user', 'number', ''],
    ['voidAfterHours', 'Void unresolved matches after (hours)', 'number', 'Stakes are refunded when no verified result arrives.'],
    ['settleDelayMin', 'Result must stay unchanged for (minutes)', 'number', 'Protects against score corrections.'],
    ['dataMode', 'Sports data mode', 'select', 'Auto uses the configured provider, Sample shows labelled examples, Off hides matches.']
  ];
  function renderAdmin(el) {
    const A = S.admin;
    if (S.adminErr) { el.innerHTML = `<div class="da-empty"><b>Could not load the admin overview</b>${esc(S.adminErr)}<br><button class="da-btn ghost sm" data-act="retry">Try again</button></div>`; return; }
    if (!A) { el.innerHTML = '<div class="da-skel" style="height:260px;margin-top:14px"></div>'; return; }
    const t = A.totals, c = A.config, p = A.providers || {};
    const f = FIELDS.map(([k, l, ty, h]) => `<div class="da-field">${ty === 'check' ? `<label class="da-check"><input type="checkbox" data-cfg="${k}" ${c[k] ? 'checked' : ''}>${l}</label>` : `<label for="cfg_${k}">${l}</label>${ty === 'select' ? `<select class="da-select" id="cfg_${k}" data-cfg="${k}">${['auto', 'sample', 'off'].map(v => `<option value="${v}" ${c[k] === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select>` : `<input class="da-input" id="cfg_${k}" data-cfg="${k}" type="number" step="1" value="${esc(c[k])}">`}`}${h ? `<small>${h}</small>` : ''}</div>`).join('');
    const prov = p.providers ? Object.entries(p.providers).map(([k, v]) => `<span class="da-chip ${v ? 'won' : 'void'}">${esc(k)}: ${v ? 'connected' : 'not set'}</span>`).join(' ') : '';
    el.innerHTML = `<div class="da-sec-h"><h2>Administration</h2><p>Visible to administrators only. Every change is recorded in the audit log.</p></div>
      <div class="da-tiles"><div class="da-tile"><small>Wallets</small><b>${t.wallets}</b></div><div class="da-tile"><small>Predictions</small><b>${t.predictions}</b><small>${t.pending} open</small></div><div class="da-tile"><small>Virtual credits staked</small><b>${dh(t.staked)}</b></div><div class="da-tile"><small>Virtual credits paid out</small><b>${dh(t.paidOut)}</b></div><div class="da-tile"><small>Recoveries</small><b>${t.recoveries}</b></div><div class="da-tile"><small>Won / lost / refunded</small><b>${t.won} / ${t.lost} / ${t.voided}</b></div></div>
      <div class="da-panel" style="margin-top:14px"><h3>Settings</h3><div class="da-fields">${f}</div><div class="da-err" id="daCfgErr" role="alert" style="margin-top:10px"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px"><button class="da-btn" data-act="cfg-save">Save settings</button><button class="da-btn ghost" data-act="settle-now">Run settlement now</button><button class="da-btn ghost" data-act="retry">Refresh</button></div></div>
      <div class="da-panel" style="margin-top:14px"><h3>Sports data provider</h3><div class="da-form" style="gap:8px">${prov || '<span class="da-muted">No provider information.</span>'}</div>
        <p class="da-muted" style="margin-top:10px;font-size:13px">API keys are set as server environment variables (BZZOIRO_API_KEY, FOOTBALL_API_KEY, APIFOOTBALL_KEY) and are never shown or stored here. ${p.bzzoiroDailyBudget ? `Bzzoiro usage today: ${p.bzzoiroRequestsToday} of ${p.bzzoiroDailyBudget} requests.` : ''}</p></div>
      <div class="da-two" style="margin-top:14px"><div class="da-panel"><h3>API errors</h3>${A.errors.length ? A.errors.map(e => `<div class="da-tx"><div><b>${esc(e.source)}</b><br><small>${esc(e.message)}${e.n > 1 ? ' (x' + e.n + ')' : ''}</small></div><div class="a"><small>${esc(when(e.at))}</small></div></div>`).join('') : '<p class="da-muted">No errors recorded.</p>'}</div>
        <div class="da-panel"><h3>Settlement failures</h3>${A.failures.length ? A.failures.map(e => `<div class="da-tx"><div><b>${esc(e.matchId)}</b><br><small>${esc(e.reason)}</small></div><div class="a"><small>${esc(when(e.at))}</small></div></div>`).join('') : '<p class="da-muted">No failures recorded.</p>'}</div></div>
      <div class="da-panel" style="margin-top:14px"><h3>User activity</h3><div class="da-scroll"><table class="da-table"><thead><tr><th>User</th><th>Plan</th><th>Balance</th><th>Predictions</th><th>Open</th><th>Win rate</th><th>Profit</th><th>Recoveries</th></tr></thead><tbody>${A.users.map(u => `<tr><td>${esc(u.user)}</td><td>${esc(u.plan || '-')}</td><td>${dh(u.balance)}</td><td>${u.predictions}</td><td>${u.pending}</td><td>${pct(u.winRate)}</td><td class="${u.profit >= 0 ? 'da-pos' : 'da-neg'}">${sgn(u.profit)}</td><td>${u.recoveries}</td></tr>`).join('') || '<tr><td colspan="8" class="da-muted">No wallets yet.</td></tr>'}</tbody></table></div></div>
      <div class="da-panel" style="margin-top:14px"><h3>Audit log</h3><div class="da-scroll"><table class="da-table"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead><tbody>${A.audit.map(a => `<tr><td>${esc(when(a.at))}</td><td>${esc(a.user || '-')}</td><td>${esc(a.action)}</td><td style="white-space:normal;max-width:360px">${esc(a.detail ? JSON.stringify(a.detail) : '')}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  async function saveConfig() {
    const cfg = {};
    document.querySelectorAll('#daBody [data-cfg]').forEach(i => { const k = i.dataset.cfg; cfg[k] = i.type === 'checkbox' ? i.checked : i.tagName === 'SELECT' ? i.value : (i.value === '' ? undefined : Number(i.value)); });
    const e = document.getElementById('daCfgErr');
    const r = await api('/admin/config', { method: 'POST', body: { config: cfg } });
    if (!r.ok) { if (e) e.textContent = r.json.error || 'Could not save the settings.'; return; }
    toast('Settings saved', 'ok'); loadAdmin(); loadMe(true); S.matches = null; if (S.section === 'arena') loadMatches();
  }

  /* ---------------- data loading ---------------- */
  async function loadMe(quiet) {
    const r = await api('/me');
    if (!r.ok) { if (!quiet && !S.me) $root().querySelector('#daBody').innerHTML = `<div class="da-empty"><b>Demo Arena could not load</b>${esc(r.json.error || 'Try again in a moment.')}<br><button class="da-btn ghost sm" data-act="retry">Try again</button></div>`; return false; }
    S.me = r.json; S.lastLoad = Date.now();
    if (!S.me.isAdmin && S.section === 'admin') S.section = 'arena';
    if (modalEl && !S.slip) { /* recovery modal open: keep it */ } else if (!modalEl) renderAll(); else renderHero();
    return true;
  }
  async function loadMatches() {
    const seq = ++S.seq; S.matchesBusy = true;
    const r = await api(`/matches?sport=${encodeURIComponent(S.sport)}&view=${encodeURIComponent(S.view)}`);
    if (seq !== S.seq) return;
    S.matchesBusy = false;
    if (r.ok) S.matches = r.json; else if (!S.matches) S.matches = { available: true, matches: [], data: { mode: 'unavailable', note: r.json.error } };
    if (S.section === 'arena' && !modalEl) renderBody();
  }
  async function loadPreds(more) {
    const off = more && S.preds ? S.preds.items.length : 0;
    const r = await api(`/predictions?filter=${S.predFilter}&offset=${off}&limit=20`);
    if (!r.ok) { toast(r.json.error || 'Could not load your predictions.', 'bad'); return; }
    if (more && S.preds) { r.json.items = S.preds.items.concat(r.json.items); }
    S.preds = r.json;
    if (S.section === 'predictions') renderBody();
  }
  async function loadTx(more) {
    const off = more ? S.tx.items.length : 0;
    const r = await api(`/transactions?offset=${off}&limit=20`);
    if (!r.ok) return;
    S.tx = { items: more ? S.tx.items.concat(r.json.items) : r.json.items, total: r.json.total };
    if (S.section === 'wallet') renderBody();
  }
  async function loadAnalytics() {
    S.analyticsErr = null;
    if (S.me.plan !== 'pro') { renderBody(); return; }
    const r = await api('/analytics');
    if (r.ok) S.analytics = r.json; else S.analyticsErr = r.json.error || 'Try again in a moment.';
    if (S.section === 'analytics') renderBody();
  }
  async function loadAdmin() {
    S.adminErr = null;
    const r = await api('/admin/overview');
    if (r.ok) S.admin = r.json; else S.adminErr = r.status === 404 ? 'You do not have access to this section.' : (r.json.error || 'Try again in a moment.');
    if (S.section === 'admin') renderBody();
  }
  function loadSection() {
    if (S.section === 'arena') loadMatches();
    else if (S.section === 'predictions') loadPreds(false);
    else if (S.section === 'analytics') { S.analytics = null; loadAnalytics(); }
    else if (S.section === 'wallet') loadTx(false);
    else if (S.section === 'admin') loadAdmin();
  }

  /* ---------------- events ---------------- */
  function setSection(k) {
    S.section = k; renderTabs(); renderBody(); loadSection();
  }
  function onClick(e) {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const a = t.dataset.act;
    if (a === 'unlock') { e.preventDefault(); closeModal(); if (window.switchTab) window.switchTab('unlock'); return; }
    if (a === 'close') return closeModal();
    if (a === 'section') return setSection(t.dataset.k);
    if (a === 'sport') { S.sport = t.dataset.k; S.matches = null; renderBody(); loadMatches(); return; }
    if (a === 'view') { S.view = t.dataset.k; S.matches = null; renderBody(); loadMatches(); return; }
    if (a === 'odd') return openSlip(t.dataset.id, t.dataset.market, t.dataset.sel, parseFloat(t.querySelector('b').textContent));
    if (a === 'chip') { document.getElementById('daStake').value = t.dataset.v; slipRefresh(); return; }
    if (a === 'place') return placeSlip();
    if (a === 'recover') return openRecovery();
    if (a === 'recover-confirm') return confirmRecovery();
    if (a === 'pfilter') { S.predFilter = t.dataset.k; S.preds = null; renderBody(); loadPreds(false); return; }
    if (a === 'pmore') return loadPreds(true);
    if (a === 'txmore') return loadTx(true);
    if (a === 'retry') { if (!S.me) return loadMe().then(ok => ok && loadSection()); return loadSection(); }
    if (a === 'cfg-save') return saveConfig();
    if (a === 'settle-now') { t.disabled = true; api('/admin/settle', { method: 'POST' }).then(r => { t.disabled = false; toast(r.ok ? 'Settlement run finished' : (r.json.error || 'Settlement failed'), r.ok ? 'ok' : 'bad'); loadAdmin(); loadMe(true); }); }
  }
  function onInput(e) { if (e.target && e.target.id === 'daStake' && S.slip) { S.slip.err = ''; slipRefresh(); } }

  function isActive() { const v = $root(); return !!(v && v.classList.contains('active') && authState.loggedIn); }
  function startTimers() {
    if (!S.poll) S.poll = setInterval(() => {
      if (document.hidden || !isActive() || modalEl) return;
      loadMe(true); if (S.section !== 'admin') loadSection();
    }, 30000);
    if (!S.tick) S.tick = setInterval(() => {
      if (!isActive()) return;
      document.querySelectorAll('#view-demo [data-countdown]').forEach(el => {
        const left = Number(el.dataset.countdown) - Date.now();
        if (left <= 0) { el.removeAttribute('data-countdown'); loadMe(true); } else el.textContent = countdown(left);
      });
    }, 1000);
  }

  /* ---------------- public api ---------------- */
  window.DemoArena = {
    open() {
      if (!authState.loggedIn) return;
      if (!S.built) build();
      startTimers();
      if (S.me) renderAll(); else renderBody();
      if (!S.me || Date.now() - S.lastLoad > 15000) loadMe().then(ok => { if (ok) loadSection(); });
      else loadSection();
    },
    reset() {
      closeModal(); clearInterval(S.poll); clearInterval(S.tick);
      Object.assign(S, { built: false, me: null, section: 'arena', matches: null, preds: null, analytics: null, admin: null, tx: { items: [], total: 0 }, shownBalance: null, poll: 0, tick: 0, lastLoad: 0 });
      const r = $root(); if (r) r.innerHTML = '';
    }
  };
})();
