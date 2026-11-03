/* Matchday Edge: motion layer (GSAP). Best Value spotlight follows the match the user picks.
   Count-up / stagger / shiny ideas adapted from React Bits (reactbits.dev, David Haz), rebuilt in vanilla JS. */
(function () {
  'use strict';
  var reduce = function () { return matchMedia('(prefers-reduced-motion:reduce)').matches; };
  var G = function () { return (!reduce() && window.gsap) || null; };
  var sel = null, seen = {}, lastStat = {}, spot = null;

  function best(list) { return list.filter(function (r) { return r.v && r.v.bet; }).sort(function (a, b) { return b.v.bet.ev - a.v.bet.ev; })[0] || null; }
  function pool() { return (st.results || []).filter(function (r) { return r.fx.status !== 'finished' && r.fx.status !== 'canceled'; }); }
  function current() {
    var p = pool(), s = sel && p.filter(function (r) { return String(r.fx.id) === String(sel); })[0];
    return s || best(p.filter(function (r) { return !r.v.started; })) || null;
  }

  function countTo(el, to, fmt, from) {
    var g = G(); if (!el) return;
    if (!g || !isFinite(to)) { el.textContent = fmt(to); return; }
    var o = { v: from == null ? 0 : from };
    g.to(o, { v: to, duration: .9, ease: 'power2.out', onUpdate: function () { el.textContent = fmt(o.v); }, onComplete: function () { el.textContent = fmt(to); } });
  }

  function spotHTML(r) {
    var t = (translations[localStorage.getItem('mde:lang') || 'en'] || translations.en);
    if (!r) return '';
    var b = r.json.best_bet_value, none = !b;
    if (b && !(window.MDE_REV && MDE_REV.has(r.fx.id))) {
      return '<div class="bv-top"><span class="bv-tag">' + (t.value_bet || 'Value Bet') + '</span><span class="bv-hint">' + esc(r.fx.league) + '</span></div>' +
        '<div class="bv-main"><div><div class="bv-match">' + crestHTML(r.fx.home) + crestHTML(r.fx.away) + '<span>' + esc(r.json.match) + '</span></div></div>' +
        '<div class="bv-nums"><button class="ev-gate-btn lg" type="button" data-reveal="' + esc(r.fx.id) + '">' + (t.show_ev || 'Show') + '</button></div></div>';
    }
    return '<div class="bv-shine"></div>' +
      '<div class="bv-top"><span class="bv-tag">★ ' + (t.value_bet || 'Value Bet') + '</span><span class="bv-hint">' + esc(r.fx.league) + '</span></div>' +
      '<div class="bv-main"><div>' +
        '<div class="bv-match">' + crestHTML(r.fx.home) + crestHTML(r.fx.away) + '<span>' + esc(r.json.match) + '</span></div>' +
        '<div class="bv-sel">' + (none ? esc(t.no_value || 'No value') : esc(b.selection)) + '</div></div>' +
      '<div class="bv-nums"><div class="bv-num"><b class="ev" data-ev>' + (none ? '—' : esc(b.expected_value)) + '</b><i>EV</i></div>' +
        '<div class="bv-num"><b data-odds>' + (none ? '—' : b.bookmaker_odds.toFixed(2)) + '</b><i>Odds</i></div></div></div>' +
      (none ? '' : '<div class="bv-meta"><span>' + (t.kelly || 'Kelly') + ': ' + esc(b.quarter_kelly) + '</span><span class="pill ' + riskClass(b.risk_level) + '">' + esc(b.risk_level) + '</span></div>');
  }

  function renderSpot(animate) {
    var host = document.getElementById('board'); if (!host) return;
    var r = current();
    if (!spot || !spot.isConnected) { spot = document.createElement('div'); spot.id = 'bvSpot'; host.parentNode.insertBefore(spot, host); }
    if (!r) { spot.className = ''; spot.innerHTML = ''; return; }
    var b = r.json.best_bet_value, key = String(r.fx.id) + '|' + (b ? b.expected_value + b.bookmaker_odds : '-') + (window.MDE_REV && MDE_REV.has(r.fx.id) ? '|o' : '|c');
    if (spot.dataset.key === key && !animate) return;
    var first = !spot.dataset.key;
    spot.dataset.key = key;
    spot.className = 'bv' + (b ? '' : ' is-none');
    spot.innerHTML = spotHTML(r);
    var g = G(); if (!g) return;
    var ev = spot.querySelector('[data-ev]'), od = spot.querySelector('[data-odds]');
    g.fromTo(spot, { y: first ? 14 : 22, opacity: 0, scale: .97 }, { y: 0, opacity: 1, scale: 1, duration: .6, ease: 'power3.out', clearProps: 'transform,opacity' });
    g.from(spot.querySelectorAll('.bv-match>*,.bv-sel,.bv-num,.bv-meta>*'), { y: 14, opacity: 0, duration: .5, stagger: .05, delay: .08, ease: 'power3.out', clearProps: 'all' });
    g.fromTo(spot.querySelector('.bv-shine'), { left: '-40%', opacity: 1 }, { left: '120%', duration: 1.1, delay: .15, ease: 'power2.inOut', onComplete: function () { spot.querySelector('.bv-shine').style.opacity = 0; } });
    if (b) {
      var evN = parseFloat(b.expected_value);
      countTo(ev, evN, function (v) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; });
      countTo(od, b.bookmaker_odds, function (v) { return v.toFixed(2); }, 1);
    }
  }

  function mark() {
    var cur = current(), id = cur ? String(cur.fx.id) : null;
    document.querySelectorAll('.match[data-fx],.pick[data-fx]').forEach(function (n) { n.classList.toggle('is-selected', n.getAttribute('data-fx') === id); });
  }

  function stats() {
    var g = G(); if (!g) return;
    document.querySelectorAll('#stats .stat-value').forEach(function (el, i) {
      var txt = el.textContent.trim(), n = parseFloat(txt.replace('+', ''));
      
      if (!isFinite(n) || lastStat[i] === txt) return;
      var fmt = /%/.test(txt) ? function (v) { return (txt[0] === '+' ? '+' : '') + v.toFixed(2) + '%'; } : function (v) { return String(Math.round(v)); };
      countTo(el, n, fmt, lastStat[i] ? parseFloat(lastStat[i].replace('+', '')) : 0);
      lastStat[i] = txt;
    });
  }

  function reveal() {
    var g = G(); if (!g) return;
    var fresh = [];
    document.querySelectorAll('#board .pick,#cards .match,#history-list .hc-card').forEach(function (n, i) {
      var k = (n.getAttribute('data-fx') || n.className) + '|' + (n.parentNode.id) + '|' + (n.querySelector('.pick-match,.t-name,.hc-header') || n).textContent.slice(0, 40);
      if (seen[k]) return; seen[k] = 1; fresh.push(n);
    });
    if (!fresh.length) return;
    if (fresh.length > 60) fresh = fresh.slice(0, 60);
    g.from(fresh, { y: 26, opacity: 0, duration: .55, stagger: { each: .045, amount: .6 }, ease: 'power3.out', clearProps: 'transform,opacity' });
  }

  function after() {
    try { renderSpot(false); mark(); stats(); reveal(); } catch (e) { /* the page must never break because of an effect */ }
  }

  document.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('.match[data-fx],.pick[data-fx]');
    if (!c || e.target.closest('button,a,input,[role="button"]')) return;
    var id = c.getAttribute('data-fx'); if (!id || String(sel) === id) return;
    sel = id; renderSpot(true); mark();
    var top = spot && spot.getBoundingClientRect().top;
    if (top != null && (top < 70 || top > innerHeight * .6)) window.scrollTo({ top: scrollY + top - 84, behavior: reduce() ? 'auto' : 'smooth' });
  });

  /* spotlight glow follows the pointer on the new card too */
  document.addEventListener('pointermove', function (e) {
    var c = e.target.closest && e.target.closest('.bv'); if (!c) return;
    var r = c.getBoundingClientRect(); c.style.setProperty('--mx', (e.clientX - r.left) + 'px'); c.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });

  window.MDEFX = { after: after, pop: function (id) {
    var g = G(); if (!g) return;
    var q = id === '*' ? '#board .pick' : '[data-fx="' + id + '"] .vb, #bvSpot .bv-num';
    var n = document.querySelectorAll(q); if (n.length) g.from(n, { y: 10, opacity: 0, duration: .45, stagger: .06, ease: 'power3.out', clearProps: 'all' });
  } };
  document.addEventListener('DOMContentLoaded', function () { setTimeout(after, 0); });
  if (typeof renderSignals === 'function') {
    var base = renderSignals;
    renderSignals = function () { var out = base.apply(this, arguments); after(); return out; };
  }
})();
