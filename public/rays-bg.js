/* rays-bg.js — site background: soft light rays fanning out from the top-right corner, like silk in a light beam.
   Drawn once into a full-screen canvas (redrawn on resize and theme change, never per frame); a very slow CSS sway
   gives it life. Dark themes get light rays, light themes get soft ink-coloured folds.
   It replaces the old background globe (live-globe.js checks window.__raysBg and skips its globe). */
(function (global) {
  'use strict';
  global.__raysBg = true;
  Array.prototype.forEach.call(document.querySelectorAll('link[data-async-css]'), function (l) { l.media = 'all'; });

  var canvas, ctx, timer = 0, drawToken = 0;
  var SEED = 7;                                         // same rays on every visit
  function rand() { SEED = (SEED * 16807) % 2147483647; return (SEED - 1) / 2147483646; }

  function isLight() {
    var cx = document.createElement('canvas').getContext('2d'); cx.fillStyle = '#000';
    cx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#000';
    var h = String(cx.fillStyle);
    var c = h.charAt(0) === '#' ? [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }) : (h.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 150;
  }

  function draw() {
    if (!canvas) return;
    var w = global.innerWidth, h = Math.max(global.innerHeight, document.documentElement.clientHeight);
    var scale = Math.min(0.5, (matchMedia('(pointer: coarse)').matches ? 560 : 760) / Math.max(w, h));     // backing store at most half size (CSS scales it up): it is a blurred background
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var light = isLight();
    var tone = light ? '20,22,30' : '255,255,255';
    var k = light ? 0.55 : 1;                            // ink rays on light pages stay fainter
    var ox = w * 1.04, oy = -h * 0.06;                   // just outside the top-right corner
    var reach = Math.hypot(w, h) * 1.25;
    var hasFilter = 'filter' in ctx;
    SEED = 7;

    // three passes: wide soft beams, mid streaks, fine bright lines
    var passes = [
      { n: 9, wMin: 70, wMax: 170, blur: 38, aMin: 0.025, aMax: 0.05 },
      { n: 16, wMin: 8, wMax: 26, blur: 10, aMin: 0.035, aMax: 0.075 },
      { n: 22, wMin: 1, wMax: 3, blur: 1.5, aMin: 0.05, aMax: 0.12 }
    ];
    // one pass per idle slot, so no single task blocks input for long
    var queue = passes.slice(), token = ++drawToken;
    function next(deadline) {
      if (token !== drawToken || !queue.length) { if (!queue.length) canvas.classList.add('is-ready'); return; }
      paint(queue.shift());
      if (global.requestIdleCallback) requestIdleCallback(next, { timeout: 600 }); else setTimeout(next, 16);
    }
    function paint(p) {
      for (var i = 0; i < p.n; i++) {
        // angles between pointing left (180°) and straight down (90°), denser towards the diagonal
        var t = rand();
        var ang = (100 + 75 * (0.5 + 0.5 * Math.sin((t - 0.5) * Math.PI))) * Math.PI / 180;
        var len = reach * (0.55 + 0.45 * rand());
        var a = (p.aMin + (p.aMax - p.aMin) * rand()) * k;
        var ex = ox + Math.cos(ang) * len, ey = oy + Math.sin(ang) * len;
        var g = ctx.createLinearGradient(ox, oy, ex, ey);
        g.addColorStop(0, 'rgba(' + tone + ',' + (a * 0.35).toFixed(3) + ')');
        g.addColorStop(0.18, 'rgba(' + tone + ',' + a.toFixed(3) + ')');
        g.addColorStop(0.6, 'rgba(' + tone + ',' + (a * 0.55).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + tone + ',0)');
        ctx.save();
        if (hasFilter) ctx.filter = 'blur(' + Math.max(0.6, p.blur * scale).toFixed(2) + 'px)';   // filter lengths are in backing-store pixels
        else { ctx.shadowBlur = p.blur * 2 * scale; ctx.shadowColor = 'rgba(' + tone + ',' + a + ')'; }
        ctx.strokeStyle = g;
        ctx.lineCap = 'round';
        ctx.lineWidth = p.wMin + (p.wMax - p.wMin) * rand();
        // a gentle curve, like fabric, instead of a ruler-straight line
        var bend = (rand() - 0.5) * len * 0.12;
        var mx = (ox + ex) / 2 - Math.sin(ang) * bend, my = (oy + ey) / 2 + Math.cos(ang) * bend;
        ctx.beginPath(); ctx.moveTo(ox, oy); ctx.quadraticCurveTo(mx, my, ex, ey); ctx.stroke();
        ctx.restore();
      }
    }
    next();
  }

  function later() { clearTimeout(timer); timer = setTimeout(draw, 160); }

  function init() {
    canvas = document.createElement('canvas');
    canvas.className = 'rays-bg';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(canvas, document.body.firstChild);
    ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); canvas = null; return; }
    // first draw once the page has loaded and the main thread is idle: the background never delays the first paint or input
    var first = function () { if (global.requestIdleCallback) requestIdleCallback(draw, { timeout: 2000 }); else setTimeout(draw, 300); };
    if (document.readyState === 'complete') first(); else global.addEventListener('load', first, { once: true });
    var lastW = global.innerWidth;
    global.addEventListener('resize', function () {      // mobile URL bars change the height constantly: only redraw on width changes
      if (global.innerWidth !== lastW) { lastW = global.innerWidth; later(); }
    });
    new MutationObserver(later).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})(window);
