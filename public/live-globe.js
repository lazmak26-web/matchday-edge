/* LuciBet live globe v2 (site-wide background, optimized)
 *  - Globe ...... cobe (jsDelivr), plain JS, no GSAP needed
 *  - Scrolling .. Lenis, desktop wheel only, driven by the SAME rAF loop as the globe
 *  - Presence ... heartbeat only (no polling, no markers, no counter)
 * If cobe fails to load the background is hidden and the page keeps working.
 */
(function () {
  'use strict';

  var CDN = {
    cobe: 'https://cdn.jsdelivr.net/npm/cobe@2.0.1/+esm',
    lenis: 'https://cdn.jsdelivr.net/npm/lenis@1.3.4/dist/lenis.min.js'
  };
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;

  function loadScript(src) {
    return new Promise(function (ok, no) {
      var s = document.createElement('script');
      s.src = src; s.async = true; s.onload = ok;
      s.onerror = function () { no(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ───────────── presence heartbeat (every visitor) ───────────── */
  var sid = (function () {
    try {
      var s = sessionStorage.getItem('mde:sid');
      if (!s) {
        var bytes = crypto.getRandomValues(new Uint8Array(12));
        s = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(36)).slice(-2); }).join('');
        sessionStorage.setItem('mde:sid', s);
      }
      return s;
    } catch (e) { return Math.random().toString(36).slice(2, 14) + 'x0x0'; }
  })();

  function ping() {
    if (document.hidden) return;
    fetch('/api/presence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sid }), keepalive: true
    }).catch(function () {});
  }
  ping();
  setInterval(ping, 45000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) ping(); });

  /* ───────────── globe ───────────── */
  var card = document.getElementById('globeCard');
  if (!card) return;
  var stage = document.getElementById('globeStage');
  var canvas = document.getElementById('globeCanvas');

  var globe = null, lenis = null;
  var SPEED = reduced ? 0 : 0.2;                 // rad / second
  var MIN_FRAME = coarse ? 1000 / 30 : 1000 / 60; // 30fps on phones: the idle spin does not need more
  var st = { phi: reduced ? 0.6 : 0.6 - 2.2, theta: 0.28 };
  var intro = reduced ? 0 : 2.2;                 // entrance spin that eases out
  var last = 0, running = false;

  function palette() {
    var t = document.documentElement.getAttribute('data-theme') || 'dark';
    if (t === 'light') return { dark: 0, diffuse: 0.5, mapBrightness: 1.3, baseColor: [1, 1, 1], glowColor: [0.93, 0.97, 0.95], markerColor: [0.06, 0.72, 0.5] };
    if (t === 'blue') return { dark: 0, diffuse: 0.5, mapBrightness: 1.3, baseColor: [0.93, 0.96, 1], glowColor: [0.75, 0.86, 1], markerColor: [0.06, 0.72, 0.5] };
    return { dark: 1, diffuse: 1.1, mapBrightness: 6, baseColor: [0.32, 0.28, 0.62], glowColor: [0.26, 0.22, 0.62], markerColor: [0.2, 0.83, 0.6] };
  }

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    if (lenis) lenis.raf(t);
    if (!globe) return;
    var dt = t - last;
    if (dt < MIN_FRAME - 1) return;
    last = t;
    dt = Math.min(dt, 100);
    if (intro > 0.0005) {                        // ease-out entrance
      var step = intro * (1 - Math.exp(-dt / 700));
      st.phi += step; intro -= step;
    }
    if (SPEED) st.phi += SPEED * dt / 1000;
    if (SPEED || intro > 0.0005) globe.update({ phi: st.phi, theta: st.theta });
  }

  function start() {
    var size = function () { return Math.round(stage.clientWidth) || 320; };
    var w = size();
    // keep the canvas pixel count bounded: the globe is huge, the GPU cost is w*w*dpr^2
    var maxPx = coarse ? 900 : 1500;
    var dpr = Math.max(0.6, Math.min(window.devicePixelRatio || 1, 1.5, maxPx / w));

    globe = window.__createGlobe(canvas, Object.assign({
      width: w, height: w, devicePixelRatio: dpr,
      phi: st.phi, theta: st.theta, mapSamples: coarse ? 9000 : 14000, markers: []
    }, palette()));
    if (canvas.parentElement && canvas.parentElement !== stage) canvas.parentElement.style.cssText = 'position:absolute;inset:0';

    new ResizeObserver(function () {
      var nw = size();
      if (nw !== w) { w = nw; globe.update({ width: nw, height: nw }); }
    }).observe(stage);

    new MutationObserver(function () { globe.update(palette()); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    globe.update({ phi: st.phi, theta: st.theta });
    card.classList.add('is-ready');
  }

  function boot() {
    if (!reduced && !coarse) {
      loadScript(CDN.lenis).then(function () {
        if (!window.Lenis) return;
        document.querySelectorAll('.modal-box, .side-menu, .profile-menu').forEach(function (el) { el.setAttribute('data-lenis-prevent', ''); });
        lenis = new window.Lenis({ lerp: 0.09, wheelMultiplier: 0.95 });
      }).catch(function () {});
    }
    import(CDN.cobe)
      .then(function (mod) { window.__createGlobe = mod.default; start(); })
      .catch(function () { card.classList.add('is-fallback'); });
    if (!running) { running = true; requestAnimationFrame(frame); }
  }

  // do not compete with first paint / hero animation
  if (window.requestIdleCallback) requestIdleCallback(boot, { timeout: 1500 });
  else setTimeout(boot, 400);
})();
