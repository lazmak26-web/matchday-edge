/* gooey-nav.js — gooey active pill for an existing tab bar, after React Bits "GooeyNav".
   The active pill is a blob drawn behind the tabs through an SVG "goo" filter: when the tab
   changes, its leading edge springs ahead and the trailing edge follows, so it stretches and
   flows to the new tab, and a burst of droplets splashes out and merges back into it.
   Hovering a tab makes the pill lean towards it. The page's own code still decides which tab
   is active (it toggles .active); this file only watches that.

   API:  var g = GooeyNav.attach(navEl, { itemSelector: '.nav-item', ... });   g.destroy();
*/
(function (global) {
  'use strict';

  var DEFAULTS = {
    itemSelector: '.nav-item', activeClass: 'active',
    particleCount: 15, spread: 56, animationTime: 600, timeVariance: 300,
    gooeyness: 0.5, wobble: 0.5, hoverEffect: true
  };
  var SVGNS = 'http://www.w3.org/2000/svg';
  var uid = 0;

  function makeFilter(id, goo) {
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'gooey-nav__defs');
    var blur = (3 + 9 * goo).toFixed(1);
    svg.innerHTML = '<defs><filter id="' + id + '" x="-20%" y="-60%" width="140%" height="220%" color-interpolation-filters="sRGB">'
      + '<feGaussianBlur in="SourceGraphic" stdDeviation="' + blur + '" result="b"/>'
      + '<feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" result="g"/>'
      + '<feComposite in="SourceGraphic" in2="g" operator="atop"/></filter></defs>';
    document.body.appendChild(svg);
    return svg;
  }

  // critically-damped-ish spring on one number
  function Spring(k, zeta) { this.x = 0; this.v = 0; this.t = 0; this.k = k; this.c = 2 * Math.sqrt(k) * zeta; }
  Spring.prototype.step = function (dt) {
    var a = this.k * (this.t - this.x) - this.c * this.v;
    this.v += a * dt; this.x += this.v * dt;
  };
  Spring.prototype.settled = function () { return Math.abs(this.t - this.x) < 0.2 && Math.abs(this.v) < 2; };
  Spring.prototype.jump = function (v) { this.x = this.t = v; this.v = 0; };

  function attach(nav, userOpts) {
    if (nav.__gooeyNav) return nav.__gooeyNav;
    var o = Object.assign({}, DEFAULTS, userOpts || {});
    var mq = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = function () { return !!(mq && mq.matches); };
    var goo = Math.min(1, Math.max(0, o.gooeyness)), wob = Math.min(1, Math.max(0, o.wobble));

    var id = 'gooey-nav-filter-' + (++uid);
    var defs = makeFilter(id, goo);
    var layer = document.createElement('div');
    layer.className = 'gooey-nav__layer';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.filter = 'url(#' + id + ')';
    var pill = document.createElement('div');
    pill.className = 'gooey-nav__pill';
    layer.appendChild(pill);
    nav.insertBefore(layer, nav.firstChild);
    nav.classList.add('gooey-nav');

    var zeta = 1 - 0.55 * wob;                 // more wobble = less damping
    var lead = 420, trail = 150;               // the edge moving forward is quicker, so the pill stretches
    var L = new Spring(trail, zeta), R = new Spring(trail, zeta), T = new Spring(lead, 0.9), H = new Spring(lead, 0.9);
    var items = [], active = -1, hover = -1, raf = 0, last = 0, busyUntil = 0, placed = false, alive = true;

    function list() { items = Array.prototype.slice.call(nav.querySelectorAll(o.itemSelector)); }
    function findActive() { for (var i = 0; i < items.length; i++) if (items[i].classList.contains(o.activeClass)) return i; return -1; }

    function targetFor(i) {
      var nr = nav.getBoundingClientRect(), r = items[i].getBoundingClientRect();
      return { l: r.left - nr.left - nav.clientLeft, r: r.right - nr.left - nav.clientLeft, t: r.top - nr.top - nav.clientTop, h: r.height };
    }
    function aim() {
      if (active < 0 || !items[active]) return false;
      var g = targetFor(active);
      if (g.r - g.l < 1) return false;            // nav hidden (display:none)
      var lean = 0;
      if (o.hoverEffect && hover >= 0 && hover !== active && !reduced()) lean = 6 + 8 * wob;
      L.t = g.l - (hover >= 0 && hover < active ? lean : 0);
      R.t = g.r + (hover > active ? lean : 0);
      T.t = g.t; H.t = g.h;
      if (!placed || reduced()) { L.jump(L.t); R.jump(R.t); T.jump(T.t); H.jump(H.t); placed = true; }
      return true;
    }
    function paint() {
      var w = Math.max(0, R.x - L.x);
      pill.style.transform = 'translate3d(' + L.x.toFixed(2) + 'px,' + T.x.toFixed(2) + 'px,0)';
      pill.style.width = w.toFixed(2) + 'px';
      pill.style.height = Math.max(0, H.x).toFixed(2) + 'px';
      pill.style.opacity = placed ? '1' : '0';
    }

    function frame(now) {
      raf = 0;
      if (!alive) return;
      var dt = last ? Math.min(0.033, (now - last) / 1000) : 1 / 60;
      last = now;
      var ok = aim();                               // re-aim every frame: the tabs' own widths animate too
      var n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
      for (var s = 0; s < n; s++) { L.step(h); R.step(h); T.step(h); H.step(h); }
      paint();
      var moving = !(L.settled() && R.settled() && T.settled() && H.settled());
      if (ok && (moving || now < busyUntil)) raf = requestAnimationFrame(frame); else last = 0;
    }
    function wake(ms) {
      if (ms) busyUntil = Math.max(busyUntil, performance.now() + ms);
      if (!raf && alive) raf = requestAnimationFrame(frame);
    }

    function splash(i) {
      if (reduced() || !o.particleCount) return;
      var g = targetFor(i), cx = (g.l + g.r) / 2, cy = g.t + g.h / 2;
      for (var p = 0; p < o.particleCount; p++) {
        var d = document.createElement('i');
        d.className = 'gooey-nav__drop';
        var size = 7 + Math.random() * 9;
        var ang = Math.random() * Math.PI * 2;
        var dist = o.spread * (0.45 + Math.random() * 0.55);
        var dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist * 0.55;   // flatter burst: the bar is wide, not tall
        var t = Math.max(200, o.animationTime + (Math.random() - 0.5) * o.timeVariance);
        d.style.width = d.style.height = size.toFixed(1) + 'px';
        d.style.left = (cx - size / 2).toFixed(1) + 'px';
        d.style.top = (cy - size / 2).toFixed(1) + 'px';
        layer.appendChild(d);
        if (d.animate) {
          var a = d.animate([
            { transform: 'translate(0,0) scale(.2)' },
            { transform: 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(1)', offset: 0.42 },
            { transform: 'translate(0,0) scale(0)' }
          ], { duration: t, easing: 'cubic-bezier(.33,1,.68,1)', delay: Math.random() * 60 });
          a.onfinish = (function (el) { return function () { el.remove(); }; })(d);
        } else d.remove();
      }
    }

    function sync() {
      list();
      var next = findActive();
      if (next === active) { wake(); return; }
      var prev = active;
      active = next;
      if (next < 0) { placed = false; paint(); return; }   // no tab is active (e.g. a page from the side menu): hide the pill
      if (prev >= 0 && next >= 0 && placed) {
        // the edge on the side we travel to gets the quick spring, the other one lags behind
        var right = next > prev;
        (right ? R : L).k = lead; (right ? L : R).k = trail;
        (right ? R : L).c = 2 * Math.sqrt(lead) * zeta; (right ? L : R).c = 2 * Math.sqrt(trail) * zeta;
        splash(next);
      }
      wake(600);
    }

    function onOver(e) {
      if (!o.hoverEffect || e.pointerType === 'touch') return;
      var it = e.target.closest && e.target.closest(o.itemSelector);
      var i = it ? items.indexOf(it) : -1;
      if (i !== hover) { hover = i; L.k = R.k = trail; L.c = R.c = 2 * Math.sqrt(trail) * zeta; wake(); }
    }
    function onLeave() { if (hover !== -1) { hover = -1; wake(); } }

    var mo = new MutationObserver(sync);
    mo.observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });
    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { wake(400); }) : null;
    if (ro) ro.observe(nav);
    nav.addEventListener('pointerover', onOver);
    nav.addEventListener('pointerleave', onLeave);
    global.addEventListener('resize', function () { wake(200); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { wake(200); });

    list(); active = findActive(); wake(300);

    var api = {
      el: nav,
      destroy: function () {
        alive = false; cancelAnimationFrame(raf); mo.disconnect(); if (ro) ro.disconnect();
        nav.removeEventListener('pointerover', onOver); nav.removeEventListener('pointerleave', onLeave);
        layer.remove(); defs.remove(); nav.classList.remove('gooey-nav'); nav.__gooeyNav = null;
      }
    };
    nav.__gooeyNav = api;
    return api;
  }

  global.GooeyNav = { attach: attach };
})(window);
