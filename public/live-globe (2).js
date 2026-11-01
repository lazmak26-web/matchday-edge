/* LuciBet live globe v3 (site-wide background, optimized + self-healing)
 *  - Globe ...... cobe (jsDelivr), plain JS
 *  - Scrolling .. Lenis, desktop wheel only, same rAF loop as the globe
 *  - Presence ... heartbeat only
 *  - Pauses drawing while scrolling / switching tabs; rebuilds itself if the GPU drops the WebGL context
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

  /* ───────────── presence heartbeat ───────────── */
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

  var globe = null, lenis = null, curW = 0, running = false, observersBound = false, retries = 0;
  var SPEED = reduced ? 0 : 0.2;                  // rad / second
  var MIN_FRAME = coarse ? 1000 / 30 : 1000 / 60;
  var st = { phi: reduced ? 0.6 : 0.6 - 2.2, theta: 0.28 };
  var intro = reduced ? 0 : 2.2;
  var last = 0, busyUntil = 0;

  /* freeze globe drawing while the page is scrolling / tabs are swapping: frees the GPU for compositing */
  function pause(ms) { busyUntil = performance.now() + ms; }
  window.__globePause = pause;
  addEventListener('scroll', function () { pause(160); }, { passive: true });

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
    if (performance.now() < busyUntil) return;
    dt = Math.min(dt, 100);
    if (intro > 0.0005) {
      var step = intro * (1 - Math.exp(-dt / 700));
      st.phi += step; intro -= step;
    }
    if (SPEED) st.phi += SPEED * dt / 1000;
    if (SPEED || intro > 0.0005) globe.update({ phi: st.phi, theta: st.theta });
  }

  function size() { return Math.round(stage.clientWidth) || 320; }

  function start() {
    curW = size();
    var maxPx = coarse ? 900 : 1500;
    var dpr = Math.max(0.6, Math.min(window.devicePixelRatio || 1, 1.5, maxPx / curW));

    globe = window.__createGlobe(canvas, Object.assign({
      width: curW, height: curW, devicePixelRatio: dpr,
      phi: st.phi, theta: st.theta, mapSamples: coarse ? 9000 : 14000, markers: []
    }, palette()));
    if (canvas.parentElement && canvas.parentElement !== stage) canvas.parentElement.style.cssText = 'position:absolute;inset:0';

    canvas.addEventListener('webglcontextlost', onLost, false);

    if (!observersBound) {
      observersBound = true;
      new ResizeObserver(function () {
        var nw = size();
        if (globe && nw !== curW) { curW = nw; globe.update({ width: nw, height: nw }); }
      }).observe(stage);
      new MutationObserver(function () { if (globe) globe.update(palette()); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    globe.update({ phi: st.phi, theta: st.theta });
    card.classList.add('is-ready');
  }

  /* mobile GPUs sometimes drop the WebGL context under memory pressure: rebuild on a fresh canvas */
  function onLost(e) {
    if (e && e.preventDefault) e.preventDefault();
    card.classList.remove('is-ready');
    try { if (globe) globe.destroy(); } catch (err) {}
    globe = null;
    if (retries++ < 3) setTimeout(rebuild, 500 * retries);
    else card.classList.add('is-fallback');
  }
  function rebuild() {
    var c = document.createElement('canvas');
    c.className = 'globe-canvas'; c.id = 'globeCanvas';
    stage.innerHTML = '';
    stage.appendChild(c);
    canvas = c;
    try { start(); } catch (err) { card.classList.add('is-fallback'); }
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

  if (window.requestIdleCallback) requestIdleCallback(boot, { timeout: 1500 });
  else setTimeout(boot, 400);
})();
