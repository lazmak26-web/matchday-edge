/* LuciBet motion helper: the small subset of GSAP the site used, on the browser's own Web Animations API.
   No library, ~2 KB. Every call is optional and a no-op when the user prefers reduced motion or the API is missing,
   so the page always ends in its normal, un-animated state. */
(function () {
  'use strict';
  var EASE = {
    'linear': 'linear',
    'power2.out': 'cubic-bezier(.25,.46,.45,.94)',
    'power3.out': 'cubic-bezier(.215,.61,.355,1)',
    'power3.inOut': 'cubic-bezier(.645,.045,.355,1)',
    'back.out': 'cubic-bezier(.34,1.56,.64,1)'
  };
  var reduce = function () { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion:reduce)').matches); };
  var can = function () { return !reduce() && typeof Element !== 'undefined' && !!Element.prototype.animate; };
  var ease = function (e) { return EASE[e] || e || EASE['power3.out']; };
  var list = function (t) {
    if (!t) return [];
    if (typeof t === 'string') return Array.prototype.slice.call(document.querySelectorAll(t));
    if (t.nodeType === 1) return [t];
    return Array.prototype.slice.call(t);
  };
  // GSAP-style stagger: a number, or { each, amount } where amount caps the total spread.
  var gap = function (stagger, n) {
    if (!stagger) return 0;
    if (typeof stagger === 'number') return stagger;
    var each = stagger.each || 0;
    return stagger.amount != null && n > 1 ? Math.min(each || Infinity, stagger.amount / (n - 1)) : each;
  };

  // Play keyframes on one element. The element's own (final) style must already be in place; 'backwards' fill holds
  // the first frame during any delay, then the animation drops away and leaves nothing inline behind.
  function tween(el, frames, o) {
    if (!el || !can()) return null;
    o = o || {};
    try {
      return el.animate(frames, {
        duration: (o.duration != null ? o.duration : .5) * 1000,
        delay: (o.delay || 0) * 1000,
        easing: ease(o.ease),
        fill: o.fill || 'backwards'
      });
    } catch (e) { return null; }
  }

  // Animate FROM the given state to wherever the element already is (opacity, x/y offset, scale).
  function from(targets, o) {
    var els = list(targets);
    if (!els.length || !can()) return;
    o = o || {};
    var step = gap(o.stagger, els.length);
    els.forEach(function (el, i) {
      var base = getComputedStyle(el).transform;
      base = base && base !== 'none' ? ' ' + base : '';
      var t0 = 'translate(' + (o.x || 0) + 'px,' + (o.y || 0) + 'px)' + (o.scale != null ? ' scale(' + o.scale + ')' : '') + base;
      var t1 = base ? base.trim() : 'none';
      var a = { transform: t0 }, b = { transform: t1 };
      if (o.opacity != null) { a.opacity = o.opacity; b.opacity = getComputedStyle(el).opacity || 1; }
      tween(el, [a, b], { duration: o.duration, delay: (o.delay || 0) + i * step, ease: o.ease });
    });
  }

  // Count a number up/down in an element's text. A new count on the same element replaces one still running.
  function count(el, fromV, toV, fmt, o) {
    if (!el) return;
    if (el.__count) cancelAnimationFrame(el.__count);
    if (!can() || !isFinite(toV)) { el.textContent = fmt(toV); return; }
    o = o || {};
    var dur = (o.duration || .9) * 1000, t0 = performance.now(), a = isFinite(fromV) ? fromV : 0;
    var out = function (p) { return 1 - Math.pow(1 - p, 2); };     // power2.out
    var tick = function (now) {
      var p = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(a + (toV - a) * out(p));
      el.__count = p < 1 ? requestAnimationFrame(tick) : 0;
      if (p >= 1) el.textContent = fmt(toV);
    };
    el.__count = requestAnimationFrame(tick);
  }

  // Magnetic pull towards the pointer, and a springy return. Uses a CSS transition so rapid moves just retarget.
  function magnet(el, dx, dy) {
    if (!el || !can()) return;
    el.style.transition = 'transform .25s ' + EASE['power2.out'];
    el.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
  }
  function release(el) {
    if (!el) return;
    el.style.transition = 'transform .5s ' + EASE['back.out'];
    el.style.transform = '';
    setTimeout(function () { if (!el.style.transform) el.style.transition = ''; }, 520);
  }

  window.Motion = { tween: tween, from: from, count: count, magnet: magnet, release: release, reduce: reduce, can: can };
})();
