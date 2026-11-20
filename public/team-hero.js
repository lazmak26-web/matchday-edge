/* team-hero.js — national-team banner at the top of the match-counter box (#stats .sx).
   A waving flag (canvas) with a few squad players in front of it; every few seconds the next nation comes in.
   Data: /api/public/nations (flags are local SVGs, photos come from /portraits/:id.png).
   One banner element is built once and moved into the box each time #stats is re-rendered.

   API: TeamHero.place(sxEl) */
(function (global) {
  'use strict';
  var ROTATE_MS = 7000;
  var reduced = !!(global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var root = null, canvas = null, ctx = null, nameEl = null, playersEl = null;
  var nations = [], idx = 0, flagImg = null, raf = 0, last = 0, t0 = 0, visible = true, timer = 0, loading = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function build() {
    root = document.createElement('div');
    root.className = 'sx-hero';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = '<canvas class="sxh-flag"></canvas><i class="sxh-fabric"></i><i class="sxh-shade"></i>' +
      '<div class="sxh-name"></div><div class="sxh-players"></div>';
    canvas = root.querySelector('canvas'); ctx = canvas.getContext('2d');
    nameEl = root.querySelector('.sxh-name'); playersEl = root.querySelector('.sxh-players');
    if (typeof IntersectionObserver === 'function') {
      new IntersectionObserver(function (en) { visible = en[0].isIntersecting; if (visible) wake(); }).observe(root);
    }
    document.addEventListener('visibilitychange', wake);
    if (typeof ResizeObserver === 'function') new ResizeObserver(function () { size(); draw(performance.now()); }).observe(root);
  }

  function size() {
    var r = root.getBoundingClientRect(), dpr = Math.min(global.devicePixelRatio || 1, 1.5);
    var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  // The flag is drawn in thin vertical strips, each shifted on a sine wave and lit/shaded by the wave's slope: a cloth ripple.
  function draw(now) {
    if (!ctx) return;
    var W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!flagImg || !flagImg.complete || !flagImg.naturalWidth) return;
    var t = reduced ? 0 : (now - t0) / 1000;
    var pad = H * 0.12, dh = H + pad * 2;                                   // a little overscan so the edges never show
    var iw = flagImg.naturalWidth, ih = flagImg.naturalHeight, scale = Math.max(W / iw, dh / ih);
    var sw = W / scale, sh = dh / scale, sx0 = (iw - sw) / 2, sy0 = (ih - sh) / 2;
    var step = Math.max(2, Math.round(W / 140)), amp = H * 0.045, k = (Math.PI * 2) / (W * 0.62);
    for (var x = 0; x < W; x += step) {
      var ph = x * k - t * 2.1, y = Math.sin(ph) * amp + Math.sin(ph * 0.5 + 1.3) * amp * 0.6;
      ctx.drawImage(flagImg, sx0 + x / scale, sy0, step / scale + 0.5, sh, x, -pad + y, step + 1, dh);
      var slope = Math.cos(ph);
      ctx.fillStyle = slope > 0 ? 'rgba(255,255,255,' + (slope * 0.13).toFixed(3) + ')' : 'rgba(0,0,0,' + (-slope * 0.24).toFixed(3) + ')';
      ctx.fillRect(x, 0, step + 1, H);
    }
  }

  function frame(now) {
    raf = 0;
    if (!root || !root.isConnected || !visible || document.hidden || reduced) { last = 0; return; }
    if (now - last >= 40) { last = now; draw(now); }                      // ~25 fps is plenty for cloth
    raf = requestAnimationFrame(frame);
  }
  function wake() { if (!raf && root && root.isConnected && visible && !document.hidden && !reduced) raf = requestAnimationFrame(frame); }

  function show(n, first) {
    var apply = function () {
      var img = new Image();
      img.onload = function () { flagImg = img; size(); draw(performance.now()); };
      img.src = n.flag;
      nameEl.textContent = n.name;
      var ps = n.players || [], order = [3, 1, 0, 2, 4];                     // best-ranked player in the middle, like a cover line-up
      ps = order.filter(function (k) { return k < ps.length; }).map(function (k) { return ps[k]; });
      playersEl.innerHTML = ps.map(function (p, i) {
        return '<figure style="--i:' + i + '"><span class="sxh-ph"><img src="/portraits/' + p.id + '.png" alt="" loading="lazy" decoding="async"></span>' +
          '<figcaption>' + (p.number != null ? '<b>' + p.number + '</b>' : '') + esc(p.name) + '</figcaption></figure>';
      }).join('');
      playersEl.querySelectorAll('img').forEach(function (im) { im.onerror = function () { var f = im.closest('figure'); if (f) f.remove(); }; });
      root.classList.toggle('no-players', !(n.players && n.players.length));
      root.classList.remove('is-out');
    };
    if (first || reduced) { apply(); return; }
    root.classList.add('is-out');
    setTimeout(apply, 320);
  }

  function preload(n) { if (!n) return; (n.players || []).forEach(function (p) { var i = new Image(); i.src = '/portraits/' + p.id + '.png'; }); }

  function next() {
    if (!nations.length || !root || !root.isConnected || document.hidden) return;
    idx = (idx + 1) % nations.length;
    show(nations[idx]);
    preload(nations[(idx + 1) % nations.length]);
  }

  function load() {
    if (loading || nations.length) return;
    loading = true;
    fetch('/api/public/nations').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      var all = (d && d.nations) || [];
      var withPlayers = all.filter(function (n) { return n.players && n.players.length; });
      nations = withPlayers.length >= 2 ? withPlayers : all;              // only the teams we have players for, once there are some
      if (!nations.length) { root.classList.add('is-empty'); return; }
      idx = Math.floor(Math.random() * nations.length);
      show(nations[idx], true);
      preload(nations[(idx + 1) % nations.length]);
      if (!reduced && nations.length > 1) timer = setInterval(next, ROTATE_MS);
    }).catch(function () { root.classList.add('is-empty'); }).then(function () { loading = false; });
  }

  function place(sx) {
    if (!sx) return;
    if (!root) build();
    if (root.parentNode !== sx) sx.insertBefore(root, sx.firstChild);
    sx.classList.add('has-hero');
    size(); draw(performance.now()); wake();
    load();
  }

  global.TeamHero = { place: place };
})(window);
