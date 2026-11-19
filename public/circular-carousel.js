/* circular-carousel.js — vanilla-JS port of React Bits "CircularCarousel" (cylinder preset).
   The original bends <img> strips; here every slide is a real HTML card, so its buttons and
   handlers keep working. Cards stay flat (no bend) and the far side shows a plain card back.
   Kept from the original: 3D ring, momentum drag, spring snap, drift autoplay, pause on hover,
   click-to-focus, pointer parallax, speed stretch, depth fade, intro animations, keyboard,
   prefers-reduced-motion.

   API:  var c = CircularCarousel.mount(hostEl, [{ html, label }], options);
         c.update(items)   same count: swaps the card HTML in place (rotation is kept); else rebuilds
         c.focus(index)    c.destroy()    c.el (root)   c.host
*/
(function (global) {
  'use strict';

  var INTRO_LENGTH = { assemble: 1500, rise: 1400, spin: 1800, none: 0 };
  var DRAG_THRESHOLD = 5;
  var SPRING = 118;
  var SETTLE_SPEED = 9;
  var TO_RAD = Math.PI / 180;

  var DEFAULTS = {
    intro: 'rise',
    cardWidth: 310,        // max card width (px); shrinks to ~84% of the container on narrow screens
    gap: 25,
    tilt: -3,              // less tilt keeps the far cards closer to the front row (less empty height above it)
    perspective: 2500,
    autoplay: 'drift',     // 'drift' | 'step' | 'off'
    speed: 14,             // deg/s while drifting
    interval: 3,           // seconds between steps ('step' autoplay)
    direction: 'left',
    draggable: true,
    momentum: 0.6,
    snap: true,
    pauseOnHover: true,
    focusOnClick: true,    // click a side card to bring it to the front instead of activating it
    parallax: 0.3,
    stretch: 0.5,
    depthFade: 0.55,
    innerShade: 0.6,
    padY: 40,              // vertical room used for the first layout pass (px)
    padTop: 8,             // room above the highest card once fitted (px)
    padBottom: 14,         // room below the lowest card once fitted (px)
    label: 'Carousel',
    onChange: null
  };

  var clamp = function (v, min, max) { return Math.min(max, Math.max(min, v)); };
  var wrap = function (d) { return ((((d + 180) % 360) + 360) % 360) - 180; };
  var easeOut = function (t) { return 1 - Math.pow(1 - t, 4); };
  var easeOutQuint = function (t) { return 1 - Math.pow(1 - t, 5); };

  function div(cls) { var d = document.createElement('div'); d.className = cls; return d; }

  function mount(host, items, userOpts) {
    var o = Object.assign({}, DEFAULTS, userOpts || {});
    var mq = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = !!(mq && mq.matches);
    var destroyed = false;

    var root = div('circular-carousel');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-roledescription', 'carousel');
    root.setAttribute('aria-label', o.label);
    root.tabIndex = 0;
    if (o.draggable) root.setAttribute('data-draggable', '');
    root.style.setProperty('--cc-inner', (clamp(o.innerShade, 0, 1) * 0.6).toFixed(3));

    var view = div('circular-carousel__view');
    var stage = div('circular-carousel__stage');
    var camera = div('circular-carousel__camera');
    var ring = div('circular-carousel__ring');
    var live = div('circular-carousel__live');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    camera.appendChild(ring); stage.appendChild(camera); view.appendChild(stage);
    root.appendChild(view); root.appendChild(live);
    host.textContent = '';
    host.appendChild(root);

    var list = [];
    var cards = [];          // { card, face, back, html }
    var count = 0, step = 0, radius = 0, cardW = 0, cardH = 0, lastW = 0;
    var ready = false, introSkipped = false;
    var active = 0, raf = 0, visible = true;

    var st = {
      angle: 0, velocity: 0, target: null,
      dir: (o.direction === 'right' ? 1 : -1),
      press: null, drag: false, hover: false,
      pointer: { inside: false, x: 0, y: 0 },
      yaw: 0, pitch: 0,
      intro: null, introDone: false,
      holdUntil: 0, stepAt: 0, suppressClick: false, wheelTimer: 0,
      drop: 0, last: 0
    };

    function S() {
      return {
        intro: reduced ? 'none' : (INTRO_LENGTH[o.intro] != null ? o.intro : 'rise'),
        autoplay: reduced ? 'off' : o.autoplay,
        parallax: reduced ? 0 : clamp(o.parallax, 0, 1),
        stretch: reduced ? 0 : clamp(o.stretch, 0, 1),
        momentum: clamp(o.momentum, 0, 1),
        depthFade: clamp(o.depthFade, 0, 1)
      };
    }

    var nearest = function (angle) { return Math.round(angle / step) * step; };

    /* ───────── build / update ───────── */
    function setFace(c, html) {
      c.html = html;
      c.face.innerHTML = html;
      var shade = div('circular-carousel__shade');
      shade.setAttribute('aria-hidden', 'true');
      c.face.appendChild(shade);
    }

    function build(next) {
      list = next;
      ring.textContent = '';
      cards = list.map(function (item, i) {
        var card = div('circular-carousel__card');
        card.setAttribute('data-cc-index', String(i));
        card.setAttribute('role', 'group');
        card.setAttribute('aria-roledescription', 'slide');
        card.setAttribute('aria-label', (item.label || ('#' + (i + 1))) + ', ' + (i + 1) + ' / ' + list.length);
        var face = div('circular-carousel__face');
        var back = div('circular-carousel__back');
        back.setAttribute('aria-hidden', 'true');
        card.appendChild(face); card.appendChild(back);
        ring.appendChild(card);
        var c = { card: card, face: face, back: back, html: '' };
        setFace(c, item.html);
        return c;
      });
      count = cards.length;
      step = count ? 360 / count : 0;
      active = 0;
      if (cards[0]) cards[0].card.setAttribute('data-active', '');
      st.angle = 0; st.velocity = 0; st.target = null;
      if (introSkipped) { st.intro = null; st.introDone = true; }
      introSkipped = true;   // only the very first build plays the intro
      lastW = 0;
      layout(true);
    }

    /* ───────── geometry ───────── */
    function layout(force) {
      var w = root.clientWidth;
      if (!w || !cards.length) return;
      if (!force && w === lastW) return;
      lastW = w;

      cardW = Math.max(220, Math.min(o.cardWidth, Math.round(w * 0.84)));
      var i, c;
      for (i = 0; i < cards.length; i++) { c = cards[i]; c.face.style.width = cardW + 'px'; c.face.style.height = 'auto'; }
      var h = 0;
      for (i = 0; i < cards.length; i++) h = Math.max(h, cards[i].face.offsetHeight);
      cardH = Math.max(h, 120);
      for (i = 0; i < cards.length; i++) {
        c = cards[i];
        c.face.style.height = cardH + 'px';
        c.face.style.left = (-cardW / 2) + 'px'; c.face.style.top = (-cardH / 2) + 'px';
        c.back.style.width = cardW + 'px'; c.back.style.height = cardH + 'px';
        c.back.style.left = (-cardW / 2) + 'px'; c.back.style.top = (-cardH / 2) + 'px';
      }

      var pitch = cardW + o.gap;
      radius = Math.max(pitch / (2 * Math.sin(Math.PI / Math.max(count, 3))), cardW * 0.6);
      var rootH = Math.round(cardH + o.padY * 2);
      root.style.height = rootH + 'px';
      stage.style.perspective = o.perspective + 'px';
      stage.style.top = '50%';
      st.drop = rootH * 0.55 + cardH;

      if (!ready) { ready = true; root.setAttribute('data-ready', ''); }
      fitHeight();
      render(performance.now());
      wake();
    }

    // The tilt and perspective push the ring off-centre (the far cards rise, the front card sinks), so a box of
    // cardH + 2*padY leaves a gap on top and clips the bottom of the front card. Measure where the cards really land
    // (at rest, ignoring the intro) and size/shift the box to fit them, with padTop/padBottom of room.
    function fitHeight() {
      var intro = st.intro, introDone = st.introDone;
      st.intro = null; st.introDone = true;
      render(performance.now());
      var top = Infinity, bottom = -Infinity, base = root.getBoundingClientRect().top;
      for (var i = 0; i < cards.length; i++) {
        [cards[i].face, cards[i].back].forEach(function (el) {
          var r = el.getBoundingClientRect();
          if (r.width > 4) { top = Math.min(top, r.top - base); bottom = Math.max(bottom, r.bottom - base); }
        });
      }
      st.intro = intro; st.introDone = introDone;
      if (!isFinite(top)) return;
      var h = Math.round(bottom - top + o.padTop + o.padBottom);
      var shift = o.padTop - top - (h - root.offsetHeight) / 2;   // after the resize the stage centre moves by half the change
      root.style.height = h + 'px';
      stage.style.top = 'calc(50% + ' + shift.toFixed(1) + 'px)';
      st.drop = h * 0.55 + cardH;
    }

    /* ───────── animation ───────── */
    function introCard(elapsed, landing) {
      if (!st.intro) return { radius: 1, lift: 0 };
      var type = st.intro.type, reach = Math.abs(wrap(landing + st.angle)), p;
      if (type === 'assemble') {
        p = easeOut(clamp((elapsed - (reach / 180) * 420) / 1080, 0, 1));
        return { radius: 1 + 0.6 * (1 - p), lift: 0 };
      }
      if (type === 'rise') {
        p = easeOutQuint(clamp((elapsed - (reach / 180) * 480) / 900, 0, 1));
        return { radius: 1, lift: (1 - p) * st.drop };
      }
      if (type === 'spin') {
        p = easeOut(clamp(elapsed / INTRO_LENGTH.spin, 0, 1));
        return { radius: 1 + 0.28 * (1 - p), lift: 0 };
      }
      return { radius: 1, lift: 0 };
    }

    function advance(dt, now) {
      var s = S();
      if (!st.introDone && ready) {
        if (!st.intro) {
          if (s.intro === 'none') st.introDone = true;
          else st.intro = { type: s.intro, start: now };
        }
        if (st.intro && now - st.intro.start >= INTRO_LENGTH[st.intro.type]) { st.intro = null; st.introDone = true; }
      }

      var paused = (o.pauseOnHover && st.hover) || st.drag || now < st.holdUntil;
      var cruise = s.autoplay === 'drift' && !paused && !st.intro ? o.speed * st.dir : 0;
      var busy = !!st.intro || st.drag;

      if (st.drag || st.intro) {
        st.velocity = st.drag ? st.velocity : 0;
      } else if (st.target !== null) {
        var remaining = dt, damping = 2 * Math.sqrt(SPRING);
        while (remaining > 0) {
          var hh = Math.min(remaining, 1 / 240);
          var accel = SPRING * (st.target - st.angle) - damping * st.velocity;
          st.velocity += accel * hh;
          st.angle += st.velocity * hh;
          remaining -= hh;
        }
        if (Math.abs(st.target - st.angle) < 0.004 && Math.abs(st.velocity) < 0.03) {
          st.angle = st.target; st.velocity = 0; st.target = null;
        }
        busy = true;
      } else {
        var tau = 0.18 + s.momentum * 1.5;
        st.velocity += (cruise - st.velocity) * (1 - Math.exp(-dt / tau));
        st.angle += st.velocity * dt;
        if (cruise === 0 && o.snap && Math.abs(st.velocity) < SETTLE_SPEED) st.target = nearest(st.angle);
        busy = busy || cruise !== 0 || Math.abs(st.velocity) > 0.01 || st.target !== null;
      }

      if (s.autoplay === 'step' && !paused && !st.intro && st.introDone) {
        if (!st.stepAt) st.stepAt = now + Math.max(0.5, o.interval) * 1000;
        if (now >= st.stepAt) {
          st.target = (st.target !== null ? st.target : nearest(st.angle)) + step * st.dir;
          st.stepAt = now + Math.max(0.5, o.interval) * 1000;
        }
        busy = true;
      } else {
        st.stepAt = 0;
      }

      if (now < st.holdUntil) busy = true;

      var ease = 1 - Math.exp(-dt / 0.35);
      var aimYaw = st.pointer.inside ? st.pointer.x * s.parallax * 9 : 0;
      var aimPitch = st.pointer.inside ? -st.pointer.y * s.parallax * 6 : 0;
      st.yaw += (aimYaw - st.yaw) * ease;
      st.pitch += (aimPitch - st.pitch) * ease;
      if (Math.abs(aimYaw - st.yaw) > 0.01 || Math.abs(aimPitch - st.pitch) > 0.01) busy = true;
      return busy;
    }

    function render(now) {
      if (!ready || !count) return;
      var s = S();
      var elapsed = st.intro ? now - st.intro.start : 0;
      var swell = 1 + s.stretch * 0.12 * Math.min(1, Math.abs(st.velocity) / 420);
      var spinOffset = 0, p;
      if (st.intro && st.intro.type === 'spin') {
        p = easeOut(clamp(elapsed / INTRO_LENGTH.spin, 0, 1));
        spinOffset = -300 * st.dir * (1 - p);
      } else if (st.intro && st.intro.type === 'assemble') {
        p = easeOut(clamp(elapsed / INTRO_LENGTH.assemble, 0, 1));
        spinOffset = -32 * st.dir * (1 - p);
      }
      var angle = st.angle + spinOffset;
      var R = radius * swell;

      camera.style.transform = 'translate3d(0,0,' + (-R) + 'px) rotateX(' + (o.tilt + st.pitch) + 'deg) rotateY(' + st.yaw + 'deg)';
      ring.style.transform = 'rotateY(' + angle + 'deg)';

      for (var i = 0; i < count; i++) {
        var base = i * step;
        var mod = introCard(elapsed, base);
        var t = 'rotateY(' + base + 'deg) translateZ(' + (R * mod.radius) + 'px)';
        if (mod.lift) t += ' translateY(' + mod.lift + 'px)';
        cards[i].card.style.transform = t;
        var facing = Math.cos(wrap(base + angle) * TO_RAD);
        var fade = s.depthFade * Math.pow((1 - facing) / 2, 1.25);
        cards[i].card.style.setProperty('--cc-depth', fade.toFixed(3));
      }

      var idx = ((Math.round(-st.angle / step) % count) + count) % count || 0;
      if (idx !== active) setActive(idx, now);
    }

    function setActive(idx, now) {
      if (cards[active]) cards[active].card.removeAttribute('data-active');
      active = idx;
      cards[idx].card.setAttribute('data-active', '');
      // Announce only changes the user caused, not the idle drift.
      if (st.drag || now < st.holdUntil) {
        live.textContent = (list[idx].label || ('#' + (idx + 1))) + ', ' + (idx + 1) + ' / ' + count;
      }
      if (typeof o.onChange === 'function') o.onChange(idx);
    }

    function frame(now) {
      raf = 0;
      if (destroyed) return;
      var dt = st.last ? Math.min((now - st.last) / 1000, 0.05) : 1 / 60;
      st.last = now;
      var busy = advance(dt, now);
      render(now);
      if (busy && visible && !document.hidden) raf = requestAnimationFrame(frame);
      else st.last = 0;
    }
    function wake() {
      if (!destroyed && !raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
    }

    /* ───────── interaction ───────── */
    function focusIndex(i) {
      var target = -i * step;
      target += 360 * Math.round((st.angle - target) / 360);
      st.target = target;
      st.holdUntil = performance.now() + 2800;
      wake();
    }
    function stepBy(d) {
      var base = st.target !== null ? st.target : nearest(st.angle);
      st.target = base - d * step;
      st.holdUntil = performance.now() + 2800;
      wake();
    }
    function perPixel() { return 180 / (Math.PI * radius); }

    function updatePointer(e) {
      var r = root.getBoundingClientRect();
      st.pointer.x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      st.pointer.y = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    }

    function onPointerDown(e) {
      st.suppressClick = false;
      if (!o.draggable || e.button !== 0) return;
      st.press = { id: e.pointerId, x: e.clientX, y: e.clientY, angle: st.angle, moved: false, origin: 0,
        samples: [{ time: performance.now(), angle: st.angle }] };
    }
    function onPointerMove(e) {
      if (e.pointerType === 'mouse') { st.pointer.inside = true; updatePointer(e); }
      var press = st.press;
      if (!press || press.id !== e.pointerId) { wake(); return; }
      var delta = e.clientX - press.x, cross = e.clientY - press.y;
      if (!press.moved) {
        if (Math.abs(delta) < DRAG_THRESHOLD) return;
        if (Math.abs(cross) > Math.abs(delta) * 1.2 && e.pointerType !== 'mouse') { st.press = null; return; }  // vertical page scroll
        press.moved = true; press.origin = delta;
        st.drag = true; st.target = null; st.velocity = 0;
        root.setAttribute('data-dragging', '');
        try { root.setPointerCapture(e.pointerId); } catch (x) { /* not capturable */ }
      }
      st.angle = press.angle + (delta - press.origin) * perPixel();
      var now = performance.now();
      press.samples.push({ time: now, angle: st.angle });
      while (press.samples.length > 2 && now - press.samples[0].time > 110) press.samples.shift();
      wake();
    }
    function onPointerUp(e) {
      var press = st.press;
      if (!press || press.id !== e.pointerId) return;
      st.press = null;
      if (!press.moved) return;
      st.drag = false;
      root.removeAttribute('data-dragging');
      st.suppressClick = true;
      var first = press.samples[0], last = press.samples[press.samples.length - 1];
      var span = (last.time - first.time) / 1000;
      var v = span > 0.008 ? clamp((last.angle - first.angle) / span, -1400, 1400) : 0;
      st.velocity = v;
      if (Math.abs(v) > 60) st.dir = Math.sign(v);
      var coasting = S().autoplay === 'drift' && !(o.pauseOnHover && st.hover && e.pointerType === 'mouse');
      if (o.snap && !coasting) {
        var tau = 0.18 + S().momentum * 1.5;
        st.target = Math.round((st.angle + v * tau * 0.55) / step) * step;
      }
      wake();
    }
    function onPointerEnter(e) { if (e.pointerType !== 'mouse') return; st.hover = true; wake(); }
    function onPointerLeave(e) {
      if (e.pointerType === 'mouse') { st.hover = false; st.pointer.inside = false; }
      wake();
    }

    // Capture phase: a drag must not also "click" the card under the finger, and a click on a
    // side card should bring it to the front instead of firing its button.
    function onClickCapture(e) {
      if (st.suppressClick) { st.suppressClick = false; e.stopPropagation(); e.preventDefault(); return; }
      if (!o.focusOnClick) return;
      var card = e.target.closest && e.target.closest('[data-cc-index]');
      if (!card) return;
      var i = Number(card.getAttribute('data-cc-index'));
      if (i !== active) { e.stopPropagation(); e.preventDefault(); focusIndex(i); }
    }

    function activateActive() {
      var c = cards[active]; if (!c) return;
      var target = c.face.querySelector('[role="button"],button,a[href]');
      if (target) target.click();
    }
    function onKeyDown(e) {
      if (e.target !== root) return;   // keys inside a card belong to the card
      if (e.key === 'ArrowRight') stepBy(1);
      else if (e.key === 'ArrowLeft') stepBy(-1);
      else if (e.key === 'Home') focusIndex(0);
      else if (e.key === 'End') focusIndex(count - 1);
      else if (e.key === 'Enter' || e.key === ' ') activateActive();
      else return;
      e.preventDefault();
    }
    function onFocusIn(e) {
      st.holdUntil = performance.now() + 4000;   // don't move cards under keyboard focus
      var card = e.target.closest && e.target.closest('[data-cc-index]');
      if (card) { var i = Number(card.getAttribute('data-cc-index')); if (i !== active) focusIndex(i); }
      wake();
    }
    function onWheel(e) {
      if (!o.draggable) return;
      var delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
      if (!delta) return;
      e.preventDefault();
      var pp = perPixel();
      st.target = null;
      st.angle -= delta * pp;
      st.velocity = -delta * pp * 30;
      st.holdUntil = performance.now() + 1600;
      clearTimeout(st.wheelTimer);
      st.wheelTimer = setTimeout(function () {
        if (o.snap) st.target = nearest(st.angle + st.velocity * 0.12);
        wake();
      }, 140);
      wake();
    }
    // Focusing something clipped by overflow can scroll the clipping box; keep it pinned.
    function onScroll() { view.scrollLeft = 0; view.scrollTop = 0; root.scrollLeft = 0; root.scrollTop = 0; }
    var imgTimer = 0;
    function onImgLoad() { clearTimeout(imgTimer); imgTimer = setTimeout(function () { layout(true); }, 60); }
    function onVisibility() {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; st.last = 0; } else wake();
    }
    function onMotionChange() { reduced = !!(mq && mq.matches); wake(); }

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerUp);
    root.addEventListener('pointerenter', onPointerEnter);
    root.addEventListener('pointerleave', onPointerLeave);
    root.addEventListener('click', onClickCapture, true);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('load', onImgLoad, true);   // crest images change the card height
    view.addEventListener('scroll', onScroll);
    root.addEventListener('scroll', onScroll);
    document.addEventListener('visibilitychange', onVisibility);
    if (mq && mq.addEventListener) mq.addEventListener('change', onMotionChange);

    var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(function () { layout(false); wake(); }) : null;
    if (ro) ro.observe(root);
    var io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) wake(); else { cancelAnimationFrame(raf); raf = 0; st.last = 0; }
    }) : null;
    if (io) io.observe(root);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (!destroyed) layout(true); });

    build(items);

    return {
      el: root,
      host: host,
      focus: focusIndex,
      update: function (next) {
        if (destroyed) return;
        if (next.length !== count) { build(next); return; }
        list = next;
        for (var i = 0; i < next.length; i++) {
          if (cards[i].html !== next[i].html) setFace(cards[i], next[i].html);
          cards[i].card.setAttribute('aria-label', (next[i].label || ('#' + (i + 1))) + ', ' + (i + 1) + ' / ' + count);
        }
        layout(true);
      },
      destroy: function () {
        destroyed = true;
        cancelAnimationFrame(raf); raf = 0;
        clearTimeout(st.wheelTimer); clearTimeout(imgTimer);
        if (ro) ro.disconnect();
        if (io) io.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        if (mq && mq.removeEventListener) mq.removeEventListener('change', onMotionChange);
        if (root.parentNode) root.parentNode.removeChild(root);
      }
    };
  }

  global.CircularCarousel = { mount: mount };
})(window);
