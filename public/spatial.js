/* LuciBet spatial layer, behaviour part. Pure decoration: if this file fails to load, the site works exactly as before.
   1. Panes catch the light where the pointer is (--px / --py) and the featured ones tilt a few degrees.
   2. The background light sources drift slightly against the pointer, which is what makes the panes feel like they hover.
   Needs a fine pointer (mouse / trackpad). Does nothing on touch screens or when the user asked for reduced motion. */
(function () {
  'use strict';
  var mqFine = window.matchMedia('(hover:hover) and (pointer:fine)');
  var mqCalm = window.matchMedia('(prefers-reduced-motion:reduce)');
  if (!mqFine.matches || mqCalm.matches) return;

  var LIT = '.feature-card,.chart-card,.match,.perf-card,.plan-card,.pick,.hc-card,.stat-item,.bv,.pf-card,.pf-day';
  var TILT = '.feature-card,.plan-card,.bv,.perf-card'; // few, large panes only. Lists of match cards stay still.
  var MAX_DEG = 3.2;
  var root = document.documentElement;
  var raf = 0, px = 0, py = 0, target = null, last = null;

  function paint() {
    raf = 0;
    root.style.setProperty('--sp-x', px.toFixed(3));
    root.style.setProperty('--sp-y', py.toFixed(3));
    if (last && last !== target) release(last);
    last = target;
    if (!target) return;
    var r = target.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var x = (px_client - r.left) / r.width, y = (py_client - r.top) / r.height;
    target.style.setProperty('--px', (x * 100).toFixed(1) + '%');
    target.style.setProperty('--py', (y * 100).toFixed(1) + '%');
    if (target.matches(TILT)) {
      target.classList.add('sp-live', 'sp-hot');
      target.style.setProperty('--ry', ((x - .5) * 2 * MAX_DEG).toFixed(2) + 'deg');
      target.style.setProperty('--rx', ((.5 - y) * 2 * MAX_DEG).toFixed(2) + 'deg');
    }
  }
  function release(el) {
    el.classList.remove('sp-hot');
    el.style.removeProperty('--rx'); el.style.removeProperty('--ry');
    el.style.removeProperty('--px'); el.style.removeProperty('--py');
  }

  var px_client = 0, py_client = 0;
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    px_client = e.clientX; py_client = e.clientY;
    px = e.clientX / window.innerWidth - .5;
    py = e.clientY / window.innerHeight - .5;
    target = e.target && e.target.closest ? e.target.closest(LIT) : null;
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: true });

  document.addEventListener('pointerleave', function () {
    target = null;
    if (!raf) raf = requestAnimationFrame(paint);
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden) { target = null; if (last) release(last); } });
})();
