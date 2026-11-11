/* LuciBet live globe v3 (site-wide background, optimized + self-healing)
 *  - Globe ...... cobe (self-hosted in /vendor), plain JS
 *  - Scrolling .. Lenis, desktop wheel only, same rAF loop as the globe
 *  - Presence ... heartbeat only
 *  - Short pause only while switching tabs (not on scroll); rebuilds itself if the GPU drops the WebGL context
 */
(function () {
  'use strict';

  var CDN = {
    cobe: '/vendor/cobe.esm.js',          // cobe 2.0.1, pinned and self-hosted
    lenis: '/vendor/lenis.min.js'
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

  function hasConsent() { try { return localStorage.getItem('mde:consent') === 'all'; } catch (e) { return false; } }
  function ping() {
    if (document.hidden || !hasConsent()) return; // live-visitor counting only after the visitor accepted it
    fetch('/api/presence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid: sid }), keepalive: true
    }).catch(function () {});
  }
  window.__mdePing = ping;
  ping();
  setInterval(ping, 45000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) ping(); });

  /* ───────────── overlay watcher ─────────────
     While a modal or the side menu is open the page behind it is hidden under a scrim, so the globe stops drawing and the
     header/nav blur is dropped (html.ui-overlay). Without this the globe repaints a full-screen canvas under the open animation. */
  var overlayOpen = false;
  (function watchOverlays() {
    var root = document.documentElement;
    var els = document.querySelectorAll('.modal-overlay, .side-menu');
    function sync() {
      var open = !!document.querySelector('.modal-overlay:not(.hidden), .side-menu.open');
      if (open === overlayOpen) return;
      overlayOpen = open;
      root.classList.toggle('ui-overlay', open);
    }
    if (!els.length || !window.MutationObserver) return;
    var mo = new MutationObserver(sync);
    for (var i = 0; i < els.length; i++) mo.observe(els[i], { attributes: true, attributeFilter: ['class'] });
    sync();
  })();

  /* ───────────── globe ───────────── */
  var card = document.getElementById('globeCard');
  if (!card) return;
  var stage = document.getElementById('globeStage');
  var canvas = document.getElementById('globeCanvas');

  var globe = null, lenis = null, curW = 0, running = false, observersBound = false, retries = 0;
  /* Performance budget. The globe is a full-screen WebGL background drawn at ~55% opacity and mostly off-screen (it sits low and
     wider than the viewport), so it does not need a high resolution or 60 fps: it spins slowly. Drawing it at 1500 px / 60 fps
     was the main source of UI lag (measured: 7 fps with the globe, 60 fps without). Low-power devices get a still globe. */
  var lowPower = coarse && ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4);
  var SPEED = reduced || lowPower ? 0 : 0.2;      // rad / second
  var MIN_FRAME = coarse ? 1000 / 24 : 1000 / 30;
  var st = { phi: reduced ? 0.6 : 0.6 - 2.2, theta: 0.28 };
  var intro = reduced || lowPower ? 0 : 2.2;
  var last = 0, busyUntil = 0;

  /* brief freeze ONLY while tabs swap (never while scrolling): the globe keeps spinning during scroll */
  function pause(ms) { busyUntil = performance.now() + ms; }
  window.__globePause = pause;

  /* every theme gets its own globe colours; light themes get a bright globe, dark ones a tinted dark globe */
  var LIGHT = {
    light: [[1, 1, 1], [0.93, 0.97, 0.95]], blue: [[0.93, 0.96, 1], [0.75, 0.86, 1]], mono: [[1, 1, 1], [0.92, 0.92, 0.95]],
    mist: [[0.93, 0.95, 0.98], [0.8, 0.86, 0.95]], sand: [[1, 0.97, 0.92], [0.93, 0.86, 0.74]], rose: [[1, 0.94, 0.96], [0.96, 0.8, 0.87]],
    lavender: [[0.95, 0.93, 1], [0.82, 0.76, 0.96]], arctic: [[0.92, 0.97, 1], [0.7, 0.86, 0.96]], mint: [[0.93, 1, 0.96], [0.72, 0.92, 0.82]],
    peach: [[1, 0.95, 0.92], [0.97, 0.8, 0.68]], sky: [[0.92, 0.96, 1], [0.7, 0.84, 0.98]], lemon: [[1, 0.98, 0.88], [0.95, 0.9, 0.55]],
    sage: [[0.94, 0.96, 0.92], [0.78, 0.87, 0.72]], paper: [[0.97, 0.96, 0.94], [0.85, 0.83, 0.78]], cotton: [[1, 0.94, 0.97], [0.96, 0.78, 0.9]]
  };
  var DARK = { // [base, glow, marker]
    aurora: [[0.3, 0.26, 0.66], [0.28, 0.22, 0.7], [0.2, 0.83, 0.6]],
    crimson: [[0.55, 0.14, 0.2], [0.55, 0.12, 0.18], [1, 0.4, 0.45]],
    neon: [[0.06, 0.4, 0.22], [0.05, 0.5, 0.25], [0.22, 1, 0.53]],
    gold: [[0.5, 0.38, 0.1], [0.55, 0.42, 0.1], [0.96, 0.76, 0.26]],
    coffee: [[0.45, 0.3, 0.2], [0.5, 0.33, 0.2], [0.83, 0.6, 0.42]],
    ocean: [[0.08, 0.4, 0.4], [0.08, 0.45, 0.45], [0.2, 0.83, 0.75]],
    sunset: [[0.55, 0.28, 0.14], [0.6, 0.3, 0.12], [1, 0.54, 0.3]],
    graphite: [[0.35, 0.35, 0.35], [0.4, 0.4, 0.4], [0.93, 0.93, 0.93]],
    forest: [[0.1, 0.4, 0.28], [0.1, 0.45, 0.3], [0.33, 0.72, 0.56]],
    slate: [[0.28, 0.38, 0.65], [0.3, 0.4, 0.7], [0.5, 0.64, 0.96]],
    nord: [[0.3, 0.4, 0.5], [0.35, 0.5, 0.6], [0.53, 0.75, 0.82]],
    dracula: [[0.4, 0.3, 0.6], [0.45, 0.33, 0.7], [0.74, 0.58, 0.98]],
    tokyo: [[0.25, 0.35, 0.65], [0.28, 0.4, 0.72], [0.48, 0.64, 0.97]],
    ember: [[0.55, 0.22, 0.08], [0.6, 0.25, 0.08], [1, 0.42, 0.1]],
    royal: [[0.2, 0.3, 0.7], [0.22, 0.35, 0.78], [0.31, 0.49, 1]],
    emerald: [[0.05, 0.45, 0.3], [0.05, 0.5, 0.33], [0.06, 0.84, 0.55]],
    cyber: [[0.4, 0.15, 0.55], [0.3, 0.3, 0.75], [0, 0.9, 1]],
    wine: [[0.5, 0.12, 0.25], [0.55, 0.14, 0.28], [0.88, 0.32, 0.49]]
  };
  /* the globe follows the site's accent colour (--brand), so a black page with a blue accent gets a blue globe */
  function brandRGB() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
      var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
      if (!m) return null;
      var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
    } catch (e) { return null; }
  }
  function mixTo(c, to, k) { return [c[0] + (to[0] - c[0]) * k, c[1] + (to[1] - c[1]) * k, c[2] + (to[2] - c[2]) * k]; }
  function palette() {
    var t = document.documentElement.getAttribute('data-theme') || 'midnight';
    var b = brandRGB();
    if (b) {
      var W = [1, 1, 1], K = [0, 0, 0];
      if (LIGHT[t]) return { dark: 0, diffuse: 0.5, mapBrightness: 1.3, baseColor: mixTo(b, W, 0.88), glowColor: mixTo(b, W, 0.6), markerColor: b };
      return { dark: 1, diffuse: 1.1, mapBrightness: 6, baseColor: mixTo(b, K, 0.4), glowColor: mixTo(b, K, 0.45), markerColor: mixTo(b, W, 0.35) };
    }
    if (LIGHT[t]) return { dark: 0, diffuse: 0.5, mapBrightness: 1.3, baseColor: LIGHT[t][0], glowColor: LIGHT[t][1], markerColor: [0.06, 0.72, 0.5] };
    var d = DARK[t] || [[0.32, 0.28, 0.62], [0.26, 0.22, 0.62], [0.2, 0.83, 0.6]];
    return { dark: 1, diffuse: 1.1, mapBrightness: 6, baseColor: d[0], glowColor: d[1], markerColor: d[2] };
  }

  /* Self-healing: if the device cannot keep up (frames much slower than the budget, e.g. software WebGL or an old phone),
     the globe stops spinning and stays as a still image, so the rest of the page stays smooth. */
  var slow = 0, prevT = 0;
  function watchSpeed(t) {
    var gap = prevT ? t - prevT : 0; prevT = t;
    if (!SPEED || !gap || gap > 250) return;          // 250+ ms = tab switch / pause, not slowness
    slow = gap > 45 ? slow + 1 : Math.max(0, slow - 1);
    if (slow > 40) { SPEED = 0; intro = 0; }
  }

  /* ───────────── adaptive text colour ─────────────
     Text marked .adapt-ink (hero subtitle, CTA note) is split into words, and every word picks a light or dark colour from
     what is really behind it: the page background blended with the globe pixels at that spot (read from a 96 px copy of
     the WebGL canvas, a few times per second at most). Dark behind -> white text, light behind -> dark text, for every theme. */
  var ink = (function () {
    var S = 96, sc = document.createElement('canvas'); sc.width = sc.height = S;
    var sx = sc.getContext('2d', { willReadFrequently: true });
    var data = null, lastSample = 0, queued = false;

    function split(el) {
      if (el.querySelector('.aw')) return;
      var f = document.createDocumentFragment();
      el.textContent.split(/(\s+)/).forEach(function (p) {
        if (!p) return;
        if (/^\s+$/.test(p)) { f.appendChild(document.createTextNode(' ')); return; }
        var w = document.createElement('span'); w.className = 'aw'; w.textContent = p; f.appendChild(w);
      });
      el.textContent = ''; el.appendChild(f);
    }
    var hosts = document.querySelectorAll('.adapt-ink');
    for (var i = 0; i < hosts.length; i++) {
      split(hosts[i]);
      // a language switch rewrites the text: split it again and recolour
      if (window.MutationObserver) new MutationObserver((function (el) { return function () { if (!el.querySelector('.aw')) { split(el); schedule(); } }; })(hosts[i])).observe(hosts[i], { childList: true });
    }
    function active() { return hosts.length && hosts[0].offsetParent !== null; }

    function rgbOf(c) { var m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c || ''); return m && (m[4] === undefined || +m[4] > 0.5) ? [+m[1], +m[2], +m[3]] : null; }
    function pageBg() {
      var cs = getComputedStyle(document.documentElement);
      return rgbOf(getComputedStyle(document.body).backgroundColor) || rgbOf(cs.backgroundColor) || rgbOf(cs.getPropertyValue('--bg')) || [245, 247, 246];
    }
    function sample() {
      lastSample = performance.now();
      if (!active()) return;                           // nothing to colour (logged in / landing hidden): never read the GPU canvas
      if (!globe || !canvas || !canvas.width) { data = null; return; }
      try { sx.clearRect(0, 0, S, S); sx.drawImage(canvas, 0, 0, S, S); data = sx.getImageData(0, 0, S, S).data; } catch (e) { data = null; }
    }
    function lum(c) { // relative luminance (WCAG)
      var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    }
    function recolor() {
      queued = false;
      if (!active()) return;
      var bg = pageBg(), r = canvas ? canvas.getBoundingClientRect() : null;
      var op = data && r && r.width && card.classList.contains('is-ready') && !card.classList.contains('is-fallback') ? (parseFloat(getComputedStyle(stage).opacity) || 0) : 0;
      var words = document.querySelectorAll('.adapt-ink .aw');
      for (var i = 0; i < words.length; i++) {
        var w = words[i], b = w.getBoundingClientRect(), acc = 0, n = 0;
        if (!b.width) continue;
        for (var gx = 0; gx < 3; gx++) for (var gy = 0; gy < 3; gy++) {
          var x = b.left + b.width * (gx + 0.5) / 3, y = b.top + b.height * (gy + 0.5) / 3, c = bg;
          if (op > 0) {
            var u = Math.floor((x - r.left) / r.width * S), v = Math.floor((y - r.top) / r.height * S);
            if (u >= 0 && v >= 0 && u < S && v < S) {
              var k = (v * S + u) * 4, a = data[k + 3] / 255 * op;
              c = [bg[0] * (1 - a) + data[k] * a, bg[1] * (1 - a) + data[k + 1] * a, bg[2] * (1 - a) + data[k + 2] * a];
            }
          }
          acc += lum(c); n++;
        }
        var L = acc / n, light = w.classList.contains('ink-light'), dark = w.classList.contains('ink-dark');
        // Anything that is not clearly light (the grey globe measures L ~0.17-0.30) gets white text with a soft dark halo;
        // the small band between the two limits keeps words from flickering as the dots pass by.
        var wantLight = light ? L < 0.36 : dark ? L < 0.28 : L < 0.32;
        if (wantLight !== light || !(light || dark)) { w.classList.toggle('ink-light', wantLight); w.classList.toggle('ink-dark', !wantLight); }
      }
    }
    function schedule() { if (!queued) { queued = true; requestAnimationFrame(recolor); } }
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    // theme switch only (Lenis toggles classes on <html> during every scroll: watching 'class' re-read the canvas constantly)
    if (window.MutationObserver) new MutationObserver(function () { setTimeout(function () { sample(); schedule(); }, 50); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    schedule();
    return {
      afterDraw: function () { if (active() && performance.now() - lastSample > 350) { sample(); schedule(); } },
      now: function () { sample(); schedule(); },
      later: function (ms) { setTimeout(schedule, ms); }
    };
  })();

  function frame(t) {
    requestAnimationFrame(frame);
    if (document.hidden) { prevT = 0; return; }
    if (lenis) lenis.raf(t);
    if (!globe || overlayOpen) { prevT = 0; return; }
    watchSpeed(t);
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
    if (SPEED || intro > 0.0005) { globe.update({ phi: st.phi, theta: st.theta }); ink.afterDraw(); }
  }

  function size() { return Math.round(stage.clientWidth) || 320; }

  function start() {
    curW = size();
    var maxPx = coarse ? 560 : 900;                 // backing-store size in device pixels (CSS scales it up; soft is fine for a background)
    var dpr = Math.max(0.3, Math.min(window.devicePixelRatio || 1, 1, maxPx / curW));

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
      new MutationObserver(function () { if (globe) { globe.update(palette()); ink.now(); } })
        .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }

    globe.update({ phi: st.phi, theta: st.theta });
    ink.now();
    card.classList.add('is-ready');
    ink.later(400); ink.later(1200); ink.later(2300);   // the globe fades in over 2 s: recolour as it becomes visible
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
      (window.Lenis ? Promise.resolve() : loadScript(CDN.lenis)).then(function () {
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
