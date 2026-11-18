/* pixel-card.js — vanilla-JS port of React Bits "PixelCard".
   Adds the pixel field (canvas) behind an existing card's content: pixels ripple out from the
   centre on hover/focus, twinkle, follow the cursor with a spotlight and pulse on click.

   API:  var pc = PixelCard.attach(cardEl, options);   pc.destroy();   pc.refresh();
   Colours default to the page theme (--brand, --brand-2, --ink-3) and follow theme changes. */
(function (global) {
  'use strict';

  var SHAPES = { square: 0, circle: 1, diamond: 2 };
  var APPEAR = 0.26, EXIT = 0.22;
  var DEFAULTS = {
    colors: null, glowColor: null, shape: 'square', origin: 'center',
    gap: 5, pixelSize: 2, speed: 35, revealDuration: 600,
    spotlight: 0.5, glow: 0.5, opacity: 0.35, fade: 0.7,
    trigger: 'hover', clickPulse: true, intro: true, introDelay: 0
  };

  var clamp = function (v, a, b) { return Math.min(Math.max(v, a), b); };
  var smoothstep = function (e0, e1, v) { var t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  var easeOutBack = function (t) { var c = 1.9, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

  var rgbCtx = null;
  function toRgb(color) {
    if (!rgbCtx) { var c = document.createElement('canvas'); c.width = c.height = 1; rgbCtx = c.getContext('2d', { willReadFrequently: true }); }
    rgbCtx.clearRect(0, 0, 1, 1); rgbCtx.fillStyle = '#fff'; rgbCtx.fillStyle = color; rgbCtx.fillRect(0, 0, 1, 1);
    var d = rgbCtx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
  }
  function themeColors(el) {
    var cs = getComputedStyle(el);
    var v = function (n, f) { return (cs.getPropertyValue(n) || '').trim() || f; };
    return { colors: [v('--brand', '#8b7bff'), v('--brand-2', '#a78bfa'), v('--ink-3', '#8f8dab')], glow: v('--brand', '#8b7bff') };
  }

  var live = [];

  function attach(container, userOpts) {
    if (container.__pixelCard) return container.__pixelCard;
    var o = Object.assign({}, DEFAULTS, userOpts || {});
    var reduce = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var canvas = document.createElement('canvas');
    canvas.className = 'pixel-card-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    container.insertBefore(canvas, container.firstChild);
    container.classList.add('pixel-card');
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var S = {};
    function readSettings() {
      var th = themeColors(container);
      S = {
        colors: (o.colors && o.colors.length) ? o.colors : th.colors,
        gap: Math.max(2, o.gap), speed: clamp(o.speed, 0, 100), pixelSize: Math.max(0.5, o.pixelSize),
        shape: SHAPES[o.shape] || 0, origin: o.origin, revealDuration: Math.max(50, o.revealDuration),
        spotlight: clamp(o.spotlight, 0, 1), glow: clamp(o.glow, 0, 1), glowColor: toRgb(o.glowColor || th.glow),
        opacity: clamp(o.opacity, 0, 1), fade: clamp(o.fade, 0, 1),
        trigger: ['hover', 'click', 'always'].indexOf(o.trigger) >= 0 ? o.trigger : 'hover',
        clickPulse: o.clickPulse, intro: o.intro, introDelay: Math.max(0, o.introDelay)
      };
    }
    readSettings();

    var st = {
      alive: true, raf: 0, last: 0, time: 0, visible: true, width: 0, height: 0, ratio: 1, key: '', count: 0,
      x: null, y: null, tint: null, size: null, phase: null, rate: null, jitter: null, presence: new Float32Array(0), delay: null,
      mask: null, maskKey: '', mode: S.trigger, active: false, changedAt: 0, originX: 0, originY: 0, maxDistance: 1,
      pointerX: 0, pointerY: 0, spotX: 0, spotY: 0, spotVX: 0, spotVY: 0, spotPower: 0, hovering: false,
      pulses: [], dt: 1 / 60, releaseAt: -1, introAt: -1
    };

    function build() {
      var w = Math.max(1, Math.round(container.clientWidth));
      var h = Math.max(1, Math.round(container.clientHeight));
      var ratio = Math.min(global.devicePixelRatio || 1, 2);
      var key = [w, h, ratio, S.gap, S.pixelSize, S.colors.join(',')].join('|');
      if (key === st.key) return;
      st.key = key; st.width = w; st.height = h; st.ratio = ratio;
      canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
      var cols = Math.floor((w - 1) / S.gap) + 1, rows = Math.floor((h - 1) / S.gap) + 1;
      var ox = (w - (cols - 1) * S.gap) / 2, oy = (h - (rows - 1) * S.gap) / 2;
      var n = cols * rows, prev = st.presence;
      st.count = n;
      st.x = new Float32Array(n); st.y = new Float32Array(n); st.tint = new Uint8Array(n); st.size = new Float32Array(n);
      st.phase = new Float32Array(n); st.rate = new Float32Array(n); st.jitter = new Float32Array(n);
      st.presence = new Float32Array(n); st.delay = new Float32Array(n);
      var i = 0;
      for (var c = 0; c < cols; c++) for (var r = 0; r < rows; r++) {
        st.x[i] = ox + c * S.gap; st.y[i] = oy + r * S.gap;
        st.tint[i] = Math.floor(Math.random() * S.colors.length);
        st.size[i] = S.pixelSize * (0.25 + Math.random() * 0.75);
        st.phase[i] = Math.random() * Math.PI * 2; st.rate[i] = 0.55 + Math.random() * 0.9; st.jitter[i] = Math.random();
        if (prev.length) st.presence[i] = prev[Math.min(i, prev.length - 1)];
        i++;
      }
      if (!st.active) { st.originX = w / 2; st.originY = h / 2; }
      schedule();
    }

    function schedule() {
      var span = S.revealDuration / 1000, far = 1, i;
      for (i = 0; i < st.count; i++) far = Math.max(far, Math.hypot(st.x[i] - st.originX, st.y[i] - st.originY));
      st.maxDistance = far;
      for (i = 0; i < st.count; i++) {
        var d = Math.hypot(st.x[i] - st.originX, st.y[i] - st.originY) / far;
        st.delay[i] = st.active ? d * span * 0.82 + st.jitter[i] * span * 0.18 : (1 - d) * span * 0.45 + st.jitter[i] * span * 0.1;
      }
    }

    function setActive(v, x, y) {
      if (st.active === v) return;
      st.active = v; st.changedAt = st.time;
      if (v) {
        var usePointer = S.origin === 'pointer' && x !== undefined;
        st.originX = usePointer ? x : st.width / 2; st.originY = usePointer ? y : st.height / 2;
      }
      schedule();
      container.toggleAttribute('data-active', v);
      wake();
    }

    function draw() {
      var w = st.width, h = st.height, i;
      ctx.setTransform(st.ratio, 0, 0, st.ratio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var mk = st.count + '|' + w + '|' + h + '|' + S.fade;
      if (st.maskKey !== mk) {
        st.maskKey = mk; st.mask = new Float32Array(st.count);
        var near = Math.min(w, h) * 0.05, farE = Math.min(w, h) * 0.42;
        for (i = 0; i < st.count; i++) {
          var edge = Math.min(st.x[i], w - st.x[i], st.y[i], h - st.y[i]);
          var t = clamp((edge - near) / (farE - near), 0, 1);
          st.mask[i] = 1 - S.fade * t * t * t * (t * (t * 6 - 15) + 10);
        }
      }
      var sum = 0, elapsed = st.time - st.changedAt, up = st.dt / APPEAR, down = st.dt / EXIT;
      for (i = 0; i < st.count; i++) {
        var cur = st.presence[i], ready = elapsed >= st.delay[i] || reduce;
        var target = st.active ? (ready ? 1 : 0) : (ready ? 0 : cur);
        if (reduce) st.presence[i] = target;
        else if (target > cur) st.presence[i] = Math.min(1, cur + up);
        else if (target < cur) st.presence[i] = Math.max(0, cur - down);
        sum += st.presence[i];
      }
      var avg = st.count ? sum / st.count : 0;
      if (S.glow > 0 && avg > 0.001) {
        var g = S.glowColor, cx = st.spotPower > 0.01 ? st.spotX : st.originX, cy = st.spotPower > 0.01 ? st.spotY : st.originY;
        var reach = Math.max(w, h) * 0.85, k = S.glow * S.opacity * 0.32 * Math.min(1, avg * 1.4);
        var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
        grad.addColorStop(0, 'rgba(' + g[0] + ',' + g[1] + ',' + g[2] + ',' + k + ')');
        grad.addColorStop(0.45, 'rgba(' + g[0] + ',' + g[1] + ',' + g[2] + ',' + (k * 0.35) + ')');
        grad.addColorStop(1, 'rgba(' + g[0] + ',' + g[1] + ',' + g[2] + ',0)');
        ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
      }
      var spotR = Math.min(w, h) * 0.38 + 30, spotK = S.spotlight * st.spotPower, pulses = st.pulses;
      var twinkle = !reduce && S.speed > 0, freq = (S.speed / 35) * 1.35;
      for (var col = 0; col < S.colors.length; col++) {
        ctx.fillStyle = S.colors[col];
        for (i = 0; i < st.count; i++) {
          if (st.tint[i] !== col) continue;
          var pr = st.presence[i];
          if (pr <= 0.002) continue;
          var x = st.x[i], y = st.y[i], size = st.size[i], a = 0.5 + pr * 0.38;
          if (twinkle) {
            var wave = Math.sin(st.phase[i] + st.time * freq * st.rate[i]);
            size *= 0.62 + 0.38 * wave;
            a += 0.12 * wave + (st.jitter[i] > 0.92 ? 0.35 * Math.max(0, wave) : 0);
          }
          size *= easeOutBack(pr);
          var flash = pr < 1 && st.active ? Math.sin(pr * Math.PI) : 0;
          size *= 1 + flash * 0.9; a += flash * 0.6;
          if (spotK > 0.001) {
            var nr = smoothstep(spotR, 0, Math.hypot(x - st.spotX, y - st.spotY));
            size *= 1 + spotK * nr * nr * 2.4; a += spotK * nr * 0.45;
          }
          a = Math.min(1, a) * st.mask[i] * S.opacity;
          if (a <= 0.004) continue;
          for (var p = 0; p < pulses.length; p++) {
            var band = (Math.hypot(x - pulses[p].x, y - pulses[p].y) - pulses[p].radius) / 26;
            var pw = Math.exp(-band * band) * pulses[p].power;
            size *= 1 + pw * 1.4; a = Math.min(1, a + pw * 0.5);
          }
          if (size <= 0.05) continue;
          ctx.globalAlpha = a;
          if (S.shape === 1) { ctx.beginPath(); ctx.arc(x, y, size * 0.5, 0, Math.PI * 2); ctx.fill(); }
          else if (S.shape === 2) {
            var hf = size * 0.62; ctx.beginPath(); ctx.moveTo(x, y - hf); ctx.lineTo(x + hf, y); ctx.lineTo(x, y + hf); ctx.lineTo(x - hf, y); ctx.closePath(); ctx.fill();
          } else ctx.fillRect(x - size * 0.5, y - size * 0.5, size, size);
        }
      }
      ctx.globalAlpha = 1;
      return sum;
    }

    function frame(now) {
      st.raf = 0;
      if (!st.alive) return;
      var dt = st.last ? Math.min(0.05, (now - st.last) / 1000) : 1 / 60;
      st.last = now; st.dt = dt; st.time += dt;
      build();
      if (st.introAt >= 0 && st.time >= st.introAt) {
        st.introAt = -1;
        if (!st.active) { setActive(true); if (st.mode !== 'always') st.releaseAt = st.time + S.revealDuration / 1000 + 0.7; }
      }
      if (st.releaseAt >= 0 && st.time >= st.releaseAt && !st.hovering && st.mode !== 'always') { st.releaseAt = -1; setActive(false); }
      var want = st.hovering && !reduce ? 1 : 0;
      st.spotPower += (want - st.spotPower) * (1 - Math.exp(-(want ? 6 : 3) * dt));
      var k = 120, damp = 2 * Math.sqrt(k) * 0.9;
      st.spotVX += (k * (st.pointerX - st.spotX) - damp * st.spotVX) * dt;
      st.spotVY += (k * (st.pointerY - st.spotY) - damp * st.spotVY) * dt;
      st.spotX += st.spotVX * dt; st.spotY += st.spotVY * dt;
      var ps = st.maxDistance / Math.max(0.35, (S.revealDuration / 1000) * 0.9);
      st.pulses = st.pulses.filter(function (pl) { pl.radius += ps * dt; pl.power = Math.max(0, 1 - pl.radius / (st.maxDistance + 40)); return pl.power > 0; });
      var presence = draw();
      var busy = st.active || st.introAt >= 0 || presence > 0 || st.pulses.length > 0 || st.spotPower > 0.002 || Math.abs(st.spotVX) + Math.abs(st.spotVY) > 0.5;
      if (busy && st.visible && !document.hidden) st.raf = requestAnimationFrame(frame); else st.last = 0;
    }
    function wake() { if (!st.raf && st.alive && st.visible && !document.hidden) st.raf = requestAnimationFrame(frame); }

    function local(e) { var r = container.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    function onEnter(e) {
      var p = local(e);
      st.hovering = e.pointerType !== 'touch'; st.pointerX = p[0]; st.pointerY = p[1];
      if (st.spotPower < 0.01) { st.spotX = p[0]; st.spotY = p[1]; st.spotVX = st.spotVY = 0; }
      if (st.mode === 'hover') { st.releaseAt = -1; st.introAt = -1; setActive(true, p[0], p[1]); }
      wake();
    }
    function onMove(e) { var p = local(e); st.pointerX = p[0]; st.pointerY = p[1]; wake(); }
    function onLeave(e) {
      st.hovering = false;
      if (st.mode === 'hover') { if (e.pointerType === 'touch') st.releaseAt = st.time + 1.2; else setActive(false); }
      wake();
    }
    function onDown(e) {
      var p = local(e);
      if (st.mode === 'click') { st.introAt = -1; st.releaseAt = -1; setActive(!st.active, p[0], p[1]); }
      else if (!st.active) setActive(true, p[0], p[1]);
      if (S.clickPulse && !reduce && st.active) st.pulses.push({ x: p[0], y: p[1], radius: 0, power: 1 });
      wake();
    }
    function onFocusIn(e) { if (container.contains(e.relatedTarget)) return; if (st.mode === 'hover') setActive(true); }
    function onFocusOut(e) { if (container.contains(e.relatedTarget)) return; if (st.mode === 'hover' && !st.hovering) setActive(false); }
    function onVis() { if (!document.hidden) wake(); }

    container.addEventListener('pointerenter', onEnter);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerleave', onLeave);
    container.addEventListener('pointerdown', onDown);
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);
    document.addEventListener('visibilitychange', onVis);
    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { build(); wake(); }) : null;
    if (ro) ro.observe(container);
    var introStarted = false;
    var io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(function (entries) {
      st.visible = entries.some(function (en) { return en.isIntersecting; });
      if (st.visible && !introStarted && (S.trigger === 'always' || (S.intro && !reduce))) {
        introStarted = true; build(); st.introAt = st.time + S.introDelay / 1000;
      }
      if (st.visible) wake();
    }) : null;
    if (io) io.observe(container);

    build();
    st.pointerX = st.spotX = st.width / 2; st.pointerY = st.spotY = st.height / 2;
    if (S.trigger === 'always') setActive(true);

    var api = {
      el: container,
      refresh: function () { readSettings(); st.key = ''; build(); wake(); },
      destroy: function () {
        st.alive = false; cancelAnimationFrame(st.raf);
        if (ro) ro.disconnect(); if (io) io.disconnect();
        document.removeEventListener('visibilitychange', onVis);
        container.removeEventListener('pointerenter', onEnter); container.removeEventListener('pointermove', onMove);
        container.removeEventListener('pointerleave', onLeave); container.removeEventListener('pointerdown', onDown);
        container.removeEventListener('focusin', onFocusIn); container.removeEventListener('focusout', onFocusOut);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        container.__pixelCard = null;
        var ix = live.indexOf(api); if (ix >= 0) live.splice(ix, 1);
      }
    };
    container.__pixelCard = api;
    live.push(api);
    return api;
  }

  /* Attach to every match of `selector` inside `root`; cards that left the page are cleaned up. */
  function mountAll(root, selector, opts) {
    live.slice().forEach(function (pc) { if (!pc.el.isConnected) pc.destroy(); });
    Array.prototype.forEach.call(root.querySelectorAll(selector), function (el) { attach(el, opts); });
  }

  // Theme switch: re-read the colours from the CSS variables.
  if (typeof MutationObserver === 'function') {
    new MutationObserver(function () { live.forEach(function (pc) { pc.refresh(); }); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  global.PixelCard = { attach: attach, mountAll: mountAll };
})(window);
