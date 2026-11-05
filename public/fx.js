/* Matchday Edge: motion layer (GSAP). Value bets live inside each match card.
   Count-up / stagger / shiny ideas adapted from React Bits (reactbits.dev, David Haz), rebuilt in vanilla JS. */
(function () {
  'use strict';
  var reduce = function () { return matchMedia('(prefers-reduced-motion:reduce)').matches; };
  var G = function () { return (!reduce() && window.gsap) || null; };
  var sel = null, seen = {}, lastStat = {};

  function countTo(el, to, fmt, from) {
    var g = G(); if (!el) return;
    if (!g || !isFinite(to)) { el.textContent = fmt(to); return; }
    var o = { v: from == null ? 0 : from };
    g.to(o, { v: to, duration: .9, ease: 'power2.out', onUpdate: function () { el.textContent = fmt(o.v); }, onComplete: function () { el.textContent = fmt(to); } });
  }

  function mark() {
    var id = sel ? String(sel) : null;
    document.querySelectorAll('.match[data-fx]').forEach(function (n) { n.classList.toggle('is-selected', n.getAttribute('data-fx') === id); });
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
    document.querySelectorAll('#cards .match,#history-list .hc-card').forEach(function (n, i) {
      var k = (n.getAttribute('data-fx') || n.className) + '|' + (n.parentNode.id) + '|' + (n.querySelector('.pick-match,.t-name,.hc-header') || n).textContent.slice(0, 40);
      if (seen[k]) return; seen[k] = 1; fresh.push(n);
    });
    if (!fresh.length) return;
    // Only the cards the person can see are worth animating (up to 10). Animating all of them made the first render of a long list
    // the heaviest moment of the page for no visible gain.
    var vh = window.innerHeight || 800;
    fresh = fresh.filter(function (n) { var r = n.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; }).slice(0, 10);
    if (!fresh.length) return;
    g.from(fresh, { y: 22, opacity: 0, duration: .5, stagger: { each: .05, amount: .4 }, ease: 'power3.out', clearProps: 'transform,opacity' });
  }

  function after() {
    try { mark(); stats(); reveal(); } catch (e) { /* the page must never break because of an effect */ }
  }

  document.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('.match[data-fx]');
    if (!c || e.target.closest('button,a,input,[role="button"]')) return;
    var id = c.getAttribute('data-fx'); if (!id) return;
    sel = String(sel) === id ? null : id; mark();
  });

  window.MDEFX = { after: after, pop: function (id) {
    var g = G(); if (!g) return;
    var q = '[data-fx="' + id + '"] .vb';
    var n = document.querySelectorAll(q); if (n.length) g.from(n, { y: 10, opacity: 0, duration: .45, stagger: .06, ease: 'power3.out', clearProps: 'all' });
  } };
  document.addEventListener('DOMContentLoaded', function () { setTimeout(after, 0); });
  if (typeof renderSignals === 'function') {
    var base = renderSignals;
    renderSignals = function () { var out = base.apply(this, arguments); after(); return out; };
  }
})();
