/* ui-pro.js — progressive enhancement for ui-pro.css
   1. Cursor spotlight for landing/main cards (demo-arena has its own handler
      for .da-card/.da-pred, so we only cover the rest — no double binding).
   2. Scroll reveal: adds .is-in to .ui-reveal when it enters the viewport.
   Both are no-ops under prefers-reduced-motion. */
(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CARD_SEL = '.feature-card,.chart-card,.match,.perf-card,.plan-card,.pick,.hc-card';

  /* 1. Spotlight — one delegated, rAF-throttled pointermove on the document */
  if (!reduce && window.matchMedia('(hover:hover) and (pointer:fine)').matches) {
    var raf = 0, last = null;
    document.addEventListener('pointermove', function (e) {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var t = last.target.closest && last.target.closest(CARD_SEL);
        if (!t || t.closest('.da-card,.da-pred')) return; // leave demo-arena alone
        var r = t.getBoundingClientRect();
        t.style.setProperty('--mx', (last.clientX - r.left) + 'px');
        t.style.setProperty('--my', (last.clientY - r.top) + 'px');
      });
    }, { passive: true });
  }

  /* 2. Scroll reveal */
  function initReveal() {
    var nodes = document.querySelectorAll('.ui-reveal');
    if (!nodes.length) return;
    if (reduce || !('IntersectionObserver' in window)) {
      nodes.forEach(function (n) { n.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    nodes.forEach(function (n) { io.observe(n); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReveal);
  } else {
    initReveal();
  }
})();
