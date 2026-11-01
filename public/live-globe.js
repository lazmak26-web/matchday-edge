/* LuciBet live globe
 *  - Globe ........ Magic UI <Globe/> (built on cobe), ported to plain JS
 *  - Motion ....... GSAP: inertia drag, marker pop-in, counter, entrance
 *  - Scrolling .... Lenis (darkroomengineering), desktop wheel only
 *  - Presence ..... heartbeat + points from /api/presence (approximate, city-level)
 * Libraries load from jsDelivr (allowed by the CSP). If any of them fails to load the
 * page keeps working: the card falls back to the "online" counter only.
 */
(function () {
  'use strict';

  var CDN = {
    gsap: 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js',
    cobe: 'https://cdn.jsdelivr.net/npm/cobe@2.0.1/+esm',
    lenis: 'https://cdn.jsdelivr.net/npm/lenis@1.3.4/dist/lenis.min.js'
  };

  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function loadScript(src) {
    return new Promise(function (ok, no) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = ok;
      s.onerror = function () { no(new Error('failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ───────────── presence heartbeat (every visitor, logged in or not) ───────────── */
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

  /* ───────────── Lenis smooth scroll (desktop wheel only; touch keeps native scrolling) ───────────── */
  function startLenis() {
    if (reduced || !window.Lenis || (window.matchMedia && matchMedia('(pointer: coarse)').matches)) return;
    document.querySelectorAll('.modal-box, .side-menu, .profile-menu').forEach(function (el) { el.setAttribute('data-lenis-prevent', ''); });
    var lenis = new window.Lenis({ lerp: 0.09, wheelMultiplier: 0.95 });
    (function raf(t) { lenis.raf(t); requestAnimationFrame(raf); })(0);
  }
  if (!reduced) loadScript(CDN.lenis).then(startLenis).catch(function () {});

  /* ───────────── the globe card ───────────── */
  var card = document.getElementById('globeCard');
  if (!card) return;
  var stage = document.getElementById('globeStage');
  var canvas = document.getElementById('globeCanvas');
  var onlineEl = document.getElementById('globeOnline') || { textContent: '' };

  var visible = false, booted = false, globe = null, createGlobe = null;
  var AUTO = 0.0012;                 // slow spin (about 85 s per turn at 60 fps)
  var st = { phi: 0.6, theta: 0.28, auto: reduced ? 0 : AUTO, vel: 0, drag: false };
  var markers = new Map();          // "lat,lng" -> { lat, lng, n, k (0..1 pop-in), ph, leaving }
  var counter = { v: 0 };

  function palette() {
    var t = document.documentElement.getAttribute('data-theme') || 'dark';
    if (t === 'light' || /^light/.test(getComputedStyle(document.documentElement).colorScheme || '')) return { dark: 0, diffuse: 0.5, mapBrightness: 1.3, baseColor: [1, 1, 1], glowColor: [0.93, 0.97, 0.95], markerColor: [0.06, 0.72, 0.5] };
    if (t === 'blue') return { dark: 0, diffuse: 0.5, mapBrightness: 1.3, baseColor: [0.93, 0.96, 1], glowColor: [0.75, 0.86, 1], markerColor: [0.06, 0.72, 0.5] };
    return { dark: 1, diffuse: 1.1, mapBrightness: 6, baseColor: [0.32, 0.28, 0.62], glowColor: [0.26, 0.22, 0.62], markerColor: [0.2, 0.83, 0.6] };
  }

  function buildMarkers(t) {
    var out = [];
    markers.forEach(function (m) {
      var base = 0.035 + Math.min(0.07, Math.log2(m.n + 1) * 0.018);
      var pulse = reduced ? 1 : 1 + 0.16 * Math.sin(t * 2.2 + m.ph);
      out.push({ location: [m.lat, m.lng], size: Math.max(0, base * m.k * pulse) });
    });
    return out;
  }

  /* online counter (Magic UI "number ticker") */
  function setOnline(n) {
    if (!window.gsap || reduced) { onlineEl.textContent = n; counter.v = n; return; }
    window.gsap.to(counter, { v: n, duration: 1.1, ease: 'power2.out', snap: { v: 1 }, overwrite: true,
      onUpdate: function () { onlineEl.textContent = counter.v; } });
  }

  function applyData(d) {
    var g = window.gsap, seen = new Set();
    (d.points || []).forEach(function (p) {
      var key = p.lat + ',' + p.lng;
      seen.add(key);
      var m = markers.get(key);
      if (!m) {
        m = { lat: p.lat, lng: p.lng, n: p.n, k: 0, ph: Math.random() * 6.28, leaving: false };
        markers.set(key, m);
        if (g && !reduced) g.to(m, { k: 1, duration: 1.4, ease: 'elastic.out(1, 0.55)', delay: Math.random() * 0.4 });
        else m.k = 1;
      } else {
        m.n = p.n;
        if (m.leaving) { m.leaving = false; if (g) g.to(m, { k: 1, duration: 0.6, overwrite: true }); else m.k = 1; }
      }
    });
    markers.forEach(function (m, key) {
      if (seen.has(key) || m.leaving) return;
      m.leaving = true;
      if (!g) { markers.delete(key); return; }
      g.to(m, { k: 0, duration: 0.6, ease: 'power2.in', overwrite: true, onComplete: function () { if (m.leaving) markers.delete(key); } });
    });
    setOnline(d.online | 0);
    var note = document.getElementById('globeNote');
    if (note) note.classList.toggle('is-empty', !(d.points && d.points.length));
  }

  function pull() {
    return fetch('/api/presence', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) applyData(d); })
      .catch(function () {});
  }

  /* drag with inertia: the globe keeps spinning after you let go, then eases back to its idle rotation */
  function bindDrag() {
    var g = window.gsap, lastX = 0, lastY = 0, K = 0.0065;
    canvas.addEventListener('pointerdown', function (e) {
      st.drag = true; lastX = e.clientX; lastY = e.clientY;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      canvas.classList.add('is-dragging');
      g.killTweensOf(st);
      st.auto = 0; st.vel = 0;
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!st.drag) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      st.phi += dx * K;
      st.vel = st.vel * 0.6 + dx * K * 0.4;
      st.theta = Math.max(-0.25, Math.min(0.75, st.theta + dy * 0.004));
    });
    function release() {
      if (!st.drag) return;
      st.drag = false;
      canvas.classList.remove('is-dragging');
      g.to(st, { vel: 0, duration: 1.5, ease: 'power3.out' });
      g.to(st, { theta: 0.28, duration: 1.4, ease: 'power2.inOut' });
      if (!reduced) g.to(st, { auto: AUTO, duration: 2.2, delay: 0.4, ease: 'power1.inOut' });
    }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  }

  function start() {
    var g = window.gsap;
    var size = function () { return Math.round(stage.clientWidth) || 320; };
    var w = size();

    globe = createGlobe(canvas, Object.assign({
      width: w, height: w, devicePixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
      phi: st.phi, theta: st.theta, mapSamples: 24000, markers: []
    }, palette()));
    // cobe wraps the canvas in a div; pin it to the stage so the globe always fills the square
    if (canvas.parentElement && canvas.parentElement !== stage) canvas.parentElement.style.cssText = 'position:absolute;inset:0';

    new ResizeObserver(function () {
      var nw = size();
      if (nw !== w) { w = nw; globe.update({ width: nw, height: nw }); }
    }).observe(stage);

    new MutationObserver(function () { globe.update(palette()); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    g.ticker.add(function (time) {
      if (!visible || !globe) return;
      if (!st.drag) st.phi += st.auto + st.vel;
      globe.update({ phi: st.phi, theta: st.theta, markers: buildMarkers(time) });
    });

    card.classList.add('is-ready');
    if (!reduced) {
            st.phi -= 2.2;
      g.to(st, { phi: '+=2.2', duration: 2.6, ease: 'power3.out' });
    }
  }

  function boot() {
    (window.gsap ? Promise.resolve() : loadScript(CDN.gsap))
      .then(function () { return import(CDN.cobe); })
      .then(function (mod) { createGlobe = mod.default; start(); })
      .catch(function () { card.classList.add('is-fallback'); })
      .then(function () { pull(); });
  }

  function setVisible(v) {
    var was = visible;
    visible = v && !document.hidden;
    if (visible && !was && booted) pull();
  }

  var lp = document.getElementById('landingPage');
  function onLanding() { return true; }
  function sync() {
    var on = onLanding();
    setVisible(on);
    if (on && !booted) { booted = true; boot(); }
  }
  if (lp) new MutationObserver(sync).observe(lp, { attributes: true, attributeFilter: ['class'] });
  sync();

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) visible = false;
    else { ping(); setVisible(onLanding()); }
  });

  setInterval(function () { if (visible) pull(); }, 20000);
})();
