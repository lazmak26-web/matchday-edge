/* stat-globe.js — small spinning globe in the match-counter box (replaces the football).
   Uses cobe (/vendor/cobe.esm.js, already used for the page background). One canvas is created once and moved
   into the box every time the box is re-rendered, so the WebGL globe is never rebuilt.

   API: StatGlobe.place(sxEl)   (call after #stats is rendered) */
(function (global) {
  'use strict';
  var reduced = !!(global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var SIZE = 150;                       // CSS px
  var wrap = null, canvas = null, globe = null, loading = null, raf = 0, last = 0, visible = true, failed = false;
  var st = { phi: 0.9, theta: 0.32 };

  function isLight() {
    var cx = document.createElement('canvas').getContext('2d'); cx.fillStyle = '#000';
    cx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000';
    var hx = String(cx.fillStyle), c = hx.charAt(0) === '#' ? [1, 3, 5].map(function (i) { return parseInt(hx.slice(i, i + 2), 16); }) : (hx.match(/[\d.]+/g) || []).map(Number);
    return c.length >= 3 ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) > 150 : true;
  }
  function brand() {
    var c = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#2f8cff';
    var x = document.createElement('canvas').getContext('2d'); x.fillStyle = c; c = x.fillStyle;
    if (c.charAt(0) !== '#') return [0.18, 0.55, 1];
    var n = parseInt(c.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function palette() {
    var b = brand();
    return isLight()
      ? { dark: 0, diffuse: 1.2, mapBrightness: 2.2, baseColor: [0.94, 0.95, 0.97], glowColor: [0.86, 0.89, 0.95], markerColor: b }
      : { dark: 1, diffuse: 1.2, mapBrightness: 7, baseColor: [0.3, 0.34, 0.42], glowColor: [0.14, 0.17, 0.24], markerColor: b };
  }

  function build() {
    wrap = document.createElement('div');
    wrap.className = 'sx-globe';
    wrap.setAttribute('aria-hidden', 'true');
    canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver(function (en) { visible = en[0].isIntersecting; if (visible) wake(); }).observe(wrap);
    }
    document.addEventListener('visibilitychange', wake);
    new MutationObserver(function () { if (globe) globe.update(palette()); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  function start(createGlobe) {
    try {
      var dpr = Math.min(global.devicePixelRatio || 1, 2);
      globe = createGlobe(canvas, Object.assign({
        width: SIZE * dpr, height: SIZE * dpr, devicePixelRatio: 1,
        phi: st.phi, theta: st.theta, mapSamples: 9000, markers: []
      }, palette()));
      wrap.classList.add('is-ready');
      wake();
    } catch (e) { failed = true; wrap.classList.add('is-fallback'); }
  }

  function frame(now) {
    raf = 0;
    if (!globe || !visible || document.hidden || !wrap.isConnected) { last = 0; return; }
    var dt = last ? Math.min(64, now - last) : 16; last = now;
    st.phi += dt * 0.00035;                    // ~one turn every 18 s
    globe.update({ phi: st.phi, theta: st.theta });
    raf = requestAnimationFrame(frame);
  }
  function wake() { if (!reduced && !raf && globe && visible && !document.hidden) raf = requestAnimationFrame(frame); }

  function place(host) {
    if (!host || failed) return;
    if (!wrap) build();
    if (wrap.parentNode !== host) host.appendChild(wrap);
    if (!globe && !loading) {
      loading = import('/vendor/cobe.esm.js').then(function (m) { start(m.default); })
        .catch(function () { failed = true; wrap.classList.add('is-fallback'); });
    }
    wake();
  }

  global.StatGlobe = { place: place };
})(window);
