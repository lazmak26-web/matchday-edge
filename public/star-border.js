/* star-border.js — vanilla-JS port of React Bits "StarBorder".
   A star with a light trail runs around the edge of an existing button; it does an extra lap on
   hover/keyboard focus and sends two pulses round the border from where you click.

   API:  var sb = StarBorder.attach(buttonEl, options);   sb.destroy();
   color / trailColor default to the button's own text colour, so it follows the theme. */
(function (global) {
  'use strict';

  var HOVERS = ['lap', 'brighten', 'reveal', 'none'];
  var BLEED = 48, LAP = 0.9, TAU = Math.PI * 2, WHITE = [255, 255, 255];
  var DEFAULTS = {
    color: null, trailColor: null, duration: 4, thickness: 1, radius: null, trailLength: 0.3,
    stars: 1, glow: 0.6, sparkle: false, direction: 'clockwise', hover: 'lap', clickPulse: true,
    theme: 'dark'   // 'dark' = additive light (for coloured/dark buttons), 'light' = ink on a light surface
  };

  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var wrap = function (v, t) { return ((v % t) + t) % t; };
  var ease = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(2 - 2 * t, 3) / 2; };
  var mix = function (a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
  var rgba = function (c, a) { return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + clamp(a, 0, 1).toFixed(3) + ')'; };

  var colorCtx = null;
  function toRgb(color) {
    colorCtx = colorCtx || document.createElement('canvas').getContext('2d');
    if (!colorCtx) return WHITE;
    colorCtx.fillStyle = '#000000'; colorCtx.fillStyle = color;
    var v = String(colorCtx.fillStyle);
    if (v.charAt(0) === '#') { var h = parseInt(v.slice(1, 7), 16); return [(h >> 16) & 255, (h >> 8) & 255, h & 255]; }
    var p = (v.match(/[\d.]+/g) || [255, 255, 255]).map(Number);
    return [p[0], p[1], p[2]];
  }

  function outline(w, h, radius) {
    var r = Math.max(0, Math.min(radius, w / 2, h / 2));
    var arc = (Math.PI * r) / 2, across = Math.max(0, w - 2 * r), down = Math.max(0, h - 2 * r);
    var seg = [
      { length: across, x: r, y: 0, dx: 1, dy: 0, angle: null },
      { length: arc, x: w - r, y: r, dx: 0, dy: 0, angle: -Math.PI / 2 },
      { length: down, x: w, y: r, dx: 0, dy: 1, angle: null },
      { length: arc, x: w - r, y: h - r, dx: 0, dy: 0, angle: 0 },
      { length: across, x: w - r, y: h, dx: -1, dy: 0, angle: null },
      { length: arc, x: r, y: h - r, dx: 0, dy: 0, angle: Math.PI / 2 },
      { length: down, x: 0, y: h - r, dx: 0, dy: -1, angle: null },
      { length: arc, x: r, y: r, dx: 0, dy: 0, angle: Math.PI }
    ];
    var total = 0; seg.forEach(function (s) { total += s.length; });
    return { r: r, segments: seg, total: Math.max(1, total) };
  }
  function pointAt(shape, d, pt) {
    var s = wrap(d, shape.total);
    for (var i = 0; i < shape.segments.length; i++) {
      var g = shape.segments[i];
      if (g.length > 0 && s <= g.length) {
        if (g.angle === null) { pt.x = g.x + g.dx * s; pt.y = g.y + g.dy * s; pt.nx = g.dy; pt.ny = -g.dx; }
        else { var a = g.angle + s / shape.r; pt.nx = Math.cos(a); pt.ny = Math.sin(a); pt.x = g.x + pt.nx * shape.r; pt.y = g.y + pt.ny * shape.r; }
        return pt;
      }
      s -= g.length;
    }
    return pt;
  }
  function project(shape, px, py) {
    var best = Infinity, found = 0, off = 0;
    shape.segments.forEach(function (g) {
      if (g.length > 0) {
        var s, x, y;
        if (g.angle === null) { s = clamp((px - g.x) * g.dx + (py - g.y) * g.dy, 0, g.length); x = g.x + g.dx * s; y = g.y + g.dy * s; }
        else {
          var a = wrap(Math.atan2(py - g.y, px - g.x) - g.angle, TAU);
          if (a > Math.PI / 2) a = a > Math.PI * 1.25 ? 0 : Math.PI / 2;
          s = a * shape.r; x = g.x + Math.cos(g.angle + a) * shape.r; y = g.y + Math.sin(g.angle + a) * shape.r;
        }
        var d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < best) { best = d; found = off + s; }
      }
      off += g.length;
    });
    return found;
  }

  function attach(root, userOpts) {
    if (root.__starBorder) return root.__starBorder;
    var o = Object.assign({}, DEFAULTS, userOpts || {});
    var canvas = document.createElement('canvas');
    canvas.className = 'star-border__light';
    canvas.setAttribute('aria-hidden', 'true');
    root.insertBefore(canvas, root.firstChild);
    root.classList.add('star-border');
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var reduce = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var idleGap = global.matchMedia && global.matchMedia('(pointer: coarse)').matches ? 50 : 40;

    function settings() {
      var cs = getComputedStyle(root);
      var r = o.radius != null ? o.radius : parseFloat(cs.borderTopLeftRadius) || 12;
      var c = o.color || cs.color;
      return {
        light: o.theme === 'light', color: c, trailColor: o.trailColor || c,
        duration: Math.max(0.3, o.duration), thickness: Math.max(0.5, o.thickness), radius: Math.max(0, r),
        trailLength: clamp(o.trailLength, 0, 1), stars: clamp(Math.round(o.stars), 1, 6), glow: clamp(o.glow, 0, 1),
        sparkle: o.sparkle, direction: o.direction === 'counterclockwise' ? -1 : 1,
        hover: HOVERS.indexOf(o.hover) >= 0 ? o.hover : 'lap', clickPulse: o.clickPulse
      };
    }
    var S = settings();
    root.style.setProperty('--star-border-thickness', S.thickness + 'px');

    var pt = { x: 0, y: 0, nx: 0, ny: -1 };
    var st = { width: 0, height: 0, dpr: 1, phase: 0, velocity: 0, motion: 0, lap: -1, time: 0, reveal: 0, boost: 0, flash: 0, emit: 0,
      hovered: false, focused: false, visible: true };
    var pulses = [], dust = [], colors = { key: '', head: WHITE, tail: WHITE };
    var raf = 0, last = performance.now(), alive = true, resizePending = true;

    function applyMeasure() {
      st.width = root.offsetWidth; st.height = root.offsetHeight;
      st.dpr = Math.min(global.devicePixelRatio || 1, 1.25);   // soft light: a 1.25x backing store is enough and 2.5x cheaper than 2x
      canvas.width = Math.max(1, Math.round((st.width + BLEED * 2) * st.dpr));
      canvas.height = Math.max(1, Math.round((st.height + BLEED * 2) * st.dpr));
      S = settings();
    }
    function local(e) {
      var r = root.getBoundingClientRect();
      return [(e.clientX - r.left) * (r.width ? st.width / r.width : 1), (e.clientY - r.top) * (r.height ? st.height / r.height : 1)];
    }
    function shapeFor(s) { return outline(Math.max(1, st.width - s.thickness), Math.max(1, st.height - s.thickness), s.radius - s.thickness / 2); }
    function stroke(x1, y1, x2, y2, w, style) { ctx.lineWidth = w; ctx.strokeStyle = style; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

    function drawTrail(s, shape, head, length, sign, k, tip) {
      if (length < 0.5 || k <= 0) return;
      var steps = clamp(Math.ceil(length / 4), 2, 36);
      pointAt(shape, head, pt);
      var px = pt.x, py = pt.y;
      for (var i = 1; i <= steps; i++) {
        pointAt(shape, head - sign * length * (i / steps), pt);
        var u = 1 - (i - 0.5) / steps, fade = u * u * k;
        var tone = mix(colors.tail, colors.head, u);
        if (!s.light) tone = mix(tone, WHITE, Math.pow(u, 6) * 0.65);
        ctx.lineCap = tip !== false && i === 1 ? 'round' : 'butt';
        stroke(px, py, pt.x, pt.y, 2 + 6 * s.glow, rgba(tone, fade * (s.light ? 0.1 : 0.2) * s.glow));
        stroke(px, py, pt.x, pt.y, s.thickness, rgba(tone, fade));
        px = pt.x; py = pt.y;
      }
    }
    function drawHead(s, x, y, k, twinkle) {
      if (k <= 0) return;
      var tone = colors.head, reach = (12 + 40 * s.glow) * (s.light ? 0.6 : 1);
      var bloom = ctx.createRadialGradient(x, y, 0, x, y, reach), str = (s.light ? 0.08 : 0.4) * s.glow * k;
      bloom.addColorStop(0, rgba(tone, str)); bloom.addColorStop(0.2, rgba(tone, str * 0.4));
      bloom.addColorStop(0.5, rgba(tone, str * 0.1)); bloom.addColorStop(1, rgba(tone, 0));
      ctx.fillStyle = bloom; ctx.fillRect(x - reach, y - reach, reach * 2, reach * 2);
      if (!s.sparkle) return;
      var size = (1 + s.thickness * 0.6) * (s.light ? 0.85 : 1);
      var core = ctx.createRadialGradient(x, y, 0, x, y, size * 2.2);
      core.addColorStop(0, rgba(s.light ? tone : WHITE, k));
      core.addColorStop(s.light ? 0.3 : 0.4, rgba(s.light ? tone : mix(tone, WHITE, 0.5), k * 0.9));
      core.addColorStop(s.light ? 0.55 : 1, rgba(tone, s.light ? k * 0.12 : 0));
      core.addColorStop(1, rgba(tone, 0));
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(x, y, size * 2.2, 0, TAU); ctx.fill();
      var spike = (3 + 4 * s.glow + s.thickness * 1.5) * twinkle, center = s.light ? tone : WHITE;
      var hz = ctx.createLinearGradient(x - spike, y, x + spike, y);
      hz.addColorStop(0, rgba(tone, 0)); hz.addColorStop(0.5, rgba(center, k * 0.95)); hz.addColorStop(1, rgba(tone, 0));
      stroke(x - spike, y, x + spike, y, s.light ? 0.75 : 1, hz);
      var vt = ctx.createLinearGradient(x, y - spike, x, y + spike);
      vt.addColorStop(0, rgba(tone, 0)); vt.addColorStop(0.5, rgba(center, k * 0.95)); vt.addColorStop(1, rgba(tone, 0));
      stroke(x, y - spike, x, y + spike, s.light ? 0.75 : 1, vt);
    }
    function spawnDust(x, y, nx, ny, speed) {
      if (dust.length > 48) return;
      var push = 3 + Math.random() * 10, drift = (Math.random() - 0.5) * 8;
      dust.push({ x: x + nx * (Math.random() * 3 - 1), y: y + ny * (Math.random() * 3 - 1),
        vx: nx * push - ny * drift - speed * -ny * 0.04, vy: ny * push + nx * drift - speed * nx * 0.04,
        age: 0, life: 0.35 + Math.random() * 0.5, size: 0.45 + Math.random() * 0.7, seed: Math.random() * TAU });
    }

    function draw(base, shape) {
      var s = st.boost > 0.001 ? Object.assign({}, base, { glow: Math.min(1.5, base.glow + 0.4 * st.boost) }) : base;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (st.width < 2 || st.height < 2) return;
      var off = (BLEED + s.thickness / 2) * st.dpr;
      ctx.setTransform(st.dpr, 0, 0, st.dpr, off, off);
      ctx.globalCompositeOperation = s.light ? 'source-over' : 'lighter';
      ctx.lineCap = 'butt';
      var total = shape.total, spacing = total / s.stars, speed = Math.abs(st.motion), sign = st.motion >= 0 ? 1 : -1;
      var length = Math.min(speed * s.trailLength * s.duration, spacing * 0.92, total * 0.6);
      var k = st.reveal * (1 + 0.4 * st.boost + 0.6 * st.flash), i;
      var ring = st.flash * (s.light ? 0.18 : 0.32) + st.boost * st.reveal * (s.light ? 0.07 : 0.12);
      if (ring > 0.005 && ctx.roundRect) {
        ctx.lineWidth = s.thickness + 2 * s.glow; ctx.strokeStyle = rgba(colors.head, ring);
        ctx.beginPath(); ctx.roundRect(0, 0, Math.max(1, st.width - s.thickness), Math.max(1, st.height - s.thickness), Math.max(0, shape.r)); ctx.stroke();
      }
      var still = clamp(1 - speed / Math.max(1, (total / s.duration) * 0.6), 0, 1) * Math.min(1, k);
      var rest = (10 + 14 * s.glow + s.thickness * 2) * still;
      for (i = 0; i < s.stars; i++) {
        var head = st.phase + i * spacing;
        drawTrail(s, shape, head, length, sign, Math.min(1, k));
        if (still > 0.01) { drawTrail(s, shape, head, rest, 1, still, false); drawTrail(s, shape, head, rest, -1, still, false); }
      }
      pulses.forEach(function (pl) {
        var fade = Math.pow(1 - pl.age / 0.65, 2);
        var travel = (total / 2) * (1 - Math.pow(1 - Math.min(1, pl.age / 0.5), 2));
        var tail = Math.min(travel, total * 0.16);
        [1, -1].forEach(function (way) {
          var front = pl.origin + way * travel;
          drawTrail(s, shape, front, tail, way, fade);
          pointAt(shape, front, pt); drawHead(s, pt.x, pt.y, fade * 0.8, 0.8);
        });
      });
      for (i = 0; i < s.stars; i++) {
        pointAt(shape, st.phase + i * spacing, pt);
        drawHead(s, pt.x, pt.y, Math.min(1.3, k), 0.82 + 0.18 * Math.sin(st.time * 6.1 + i * 2.3) * Math.sin(st.time * 2.7 + i));
      }
      dust.forEach(function (m) {
        var left = 1 - m.age / m.life, a = left * (0.45 + 0.55 * Math.sin(st.time * 20 + m.seed)) * st.reveal * (s.light ? 0.35 : 0.9);
        if (a <= 0.01) return;
        ctx.fillStyle = rgba(s.light ? colors.head : mix(colors.tail, WHITE, 0.6), a);
        ctx.beginPath(); ctx.arc(m.x, m.y, m.size * (0.6 + 0.4 * left), 0, TAU); ctx.fill();
      });
    }

    function frame(now) {
      raf = 0;
      if (!alive) return;
      var busyNow = st.lap >= 0 || pulses.length || st.hovered || st.flash > 0.01;
      if (!busyNow && now - last < idleGap) { raf = requestAnimationFrame(frame); return; }   // ~25 fps (20 on phones) while it just drifts
      if (resizePending) { resizePending = false; applyMeasure(); }
      var s = S, dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now; st.time += dt;
      var key = s.color + '|' + s.trailColor;
      if (key !== colors.key) { colors.key = key; colors.head = toRgb(s.color); colors.tail = toRgb(s.trailColor); }
      var shape = shapeFor(s), total = shape.total, spacing = total / s.stars;
      var engaged = st.hovered || st.focused, cruise = reduce ? 0 : (s.direction * total) / s.duration;
      var revealT = s.hover === 'reveal' && !engaged ? 0 : 1;
      st.reveal += (revealT - st.reveal) * (1 - Math.exp(-dt / (revealT > st.reveal ? 0.16 : 0.45)));
      var boostT = s.hover === 'brighten' && engaged ? 1 : 0;
      st.boost += (boostT - st.boost) * (1 - Math.exp(-dt / (boostT > st.boost ? 0.18 : 0.5)));
      st.flash *= Math.exp(-dt / 0.22);
      st.velocity += (cruise - st.velocity) * (1 - Math.exp(-dt / 0.45));
      var extra = 0;
      if (st.lap >= 0) {
        var before = ease(Math.min(1, st.lap / LAP));
        st.lap += dt;
        extra = (ease(Math.min(1, st.lap / LAP)) - before) * total * s.direction;
        if (st.lap >= LAP) st.lap = -1;
      }
      st.motion = st.velocity + extra / dt;
      st.phase = wrap(st.phase + st.velocity * dt + extra, total);
      var pace = Math.abs(st.motion) / Math.max(1, Math.abs(total / s.duration)), i;
      if (s.sparkle && !reduce && st.reveal > 0.05) {
        st.emit += dt * (2 + 6 * Math.min(2, pace)) * s.stars;
        while (st.emit > 1) {
          st.emit -= 1;
          pointAt(shape, st.phase + Math.floor(Math.random() * s.stars) * spacing, pt);
          spawnDust(pt.x, pt.y, pt.nx, pt.ny, st.motion);
        }
      }
      for (i = dust.length - 1; i >= 0; i--) {
        var m = dust[i]; m.age += dt; m.x += m.vx * dt; m.y += m.vy * dt;
        m.vx *= Math.exp(-dt * 2.2); m.vy *= Math.exp(-dt * 2.2);
        if (m.age >= m.life) dust.splice(i, 1);
      }
      for (i = pulses.length - 1; i >= 0; i--) { pulses[i].age += dt; if (pulses[i].age >= 0.65) pulses.splice(i, 1); }
      draw(s, shape);
      var settling = Math.abs(revealT - st.reveal) > 0.002 || Math.abs(boostT - st.boost) > 0.002 || st.flash > 0.01 || pulses.length > 0 || dust.length > 0;
      var moving = Math.abs(st.motion) > 0.05 || cruise !== 0 || st.lap >= 0;
      var showing = st.reveal > 0.002 || revealT > 0;
      if (st.visible && !document.hidden && (settling || (moving && showing) || st.hovered)) raf = requestAnimationFrame(frame);
    }
    function wake() { if (raf || !alive || !started || !st.visible || document.hidden) return; last = performance.now(); raf = requestAnimationFrame(frame); }

    function onEnter(e) {
      var p = local(e); st.hovered = true;
      if (S.hover === 'reveal' && st.reveal < 0.15) { st.phase = project(shapeFor(S), p[0] - S.thickness / 2, p[1] - S.thickness / 2); st.velocity = 0; }
      if (S.hover === 'lap' && st.lap < 0 && !reduce) st.lap = 0;
      wake();
    }
    function onLeave() { st.hovered = false; wake(); }
    function pulse(origin) {
      if (!S.clickPulse) return;
      pulses.push({ origin: origin, age: 0 }); if (pulses.length > 4) pulses.shift();
      st.flash = 1; wake();
    }
    function onDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      var p = local(e); pulse(project(shapeFor(S), p[0] - S.thickness / 2, p[1] - S.thickness / 2));
    }
    function onClick(e) { if (e.detail === 0) pulse(st.phase); }   // keyboard activation
    function onFocus() {
      st.focused = root.matches(':focus-visible');
      if (st.focused && S.hover === 'lap' && st.lap < 0 && !reduce) st.lap = 0;
      wake();
    }
    function onBlur() { st.focused = false; wake(); }
    function onVis() { wake(); }
    function measure() { resizePending = true; wake(); }

    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(root);
    var io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(function (en) {
      st.visible = en.some(function (x) { return x.isIntersecting; }); if (st.visible) wake();
    }) : null;
    if (io) io.observe(root);
    var mo = typeof MutationObserver === 'function' ? new MutationObserver(measure) : null;   // theme switch changes the colours
    if (mo) mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    root.addEventListener('pointerenter', onEnter); root.addEventListener('pointerleave', onLeave);
    root.addEventListener('pointerdown', onDown); root.addEventListener('click', onClick);
    root.addEventListener('focus', onFocus); root.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    var started = false;
    function begin() { if (started || !alive) return; started = true; measure(); }
    function afterLoad() { if (global.requestIdleCallback) requestIdleCallback(begin, { timeout: 2500 }); else setTimeout(begin, 1200); }
    if (document.readyState === 'complete') afterLoad(); else global.addEventListener('load', afterLoad, { once: true });

    var api = {
      el: root,
      destroy: function () {
        alive = false; cancelAnimationFrame(raf);
        if (ro) ro.disconnect(); if (io) io.disconnect(); if (mo) mo.disconnect();
        root.removeEventListener('pointerenter', onEnter); root.removeEventListener('pointerleave', onLeave);
        root.removeEventListener('pointerdown', onDown); root.removeEventListener('click', onClick);
        root.removeEventListener('focus', onFocus); root.removeEventListener('blur', onBlur);
        document.removeEventListener('visibilitychange', onVis);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        root.classList.remove('star-border'); root.__starBorder = null;
      }
    };
    root.__starBorder = api;
    return api;
  }

  global.StarBorder = { attach: attach };
})(window);
