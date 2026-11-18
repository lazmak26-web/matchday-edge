/* code-slots.js — vanilla-JS port of React Bits "CodeSlots" (one-time-code input).
   Enhances an existing <input>: the input stays the real form field (its .value is always the
   typed digits, autofill and paste work), and the slots, caret, success wash and error drain
   are drawn around it. Springs from the original are approximated with CSS transitions.

   API:  var cs = CodeSlots.enhance(inputEl, { length: 6, onComplete(code), onChange(code) });
         cs.setStatus('idle' | 'error' | 'success')   cs.reset()   cs.value()   cs.focus()
*/
(function (global) {
  'use strict';

  var DEFAULTS = { length: 6, cascade: 20, settle: 300, mask: false, caret: true, onComplete: null, onChange: null };
  var CHECK_SVG = '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13.5l4 4L19 7"/></svg>';
  var digitsOf = function (s) { return String(s == null ? '' : s).replace(/\D/g, ''); };
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function enhance(input, userOpts) {
    var o = Object.assign({}, DEFAULTS, userOpts || {});
    var n = o.length;
    var mq = global.matchMedia ? global.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var reduced = function () { return !!(mq && mq.matches); };

    var root = el('div', 'code-slots');
    var row = el('div', 'code-slots__row');
    row.setAttribute('data-status', 'idle');
    input.parentNode.insertBefore(root, input);
    root.appendChild(row);
    row.appendChild(input);
    input.classList.add('code-slots__input');
    input.setAttribute('maxlength', String(n));
    input.setAttribute('pattern', '[0-9]*');
    input.removeAttribute('placeholder');

    var slots = [], digits = [];
    for (var i = 0; i < n; i++) {
      var s = el('span', 'code-slots__slot');
      s.setAttribute('aria-hidden', 'true');
      var fill = el('span', 'code-slots__fill');
      var dg = el('span', 'code-slots__digit');
      s.appendChild(fill); s.appendChild(dg);
      row.appendChild(s);
      slots.push(s); digits.push(dg);
    }
    var wash = el('span', 'code-slots__wash'); wash.setAttribute('aria-hidden', 'true');
    var check = el('span', 'code-slots__check'); check.innerHTML = CHECK_SVG;
    wash.appendChild(check); row.appendChild(wash);
    var caret = el('span', 'code-slots__caret'); caret.setAttribute('aria-hidden', 'true');
    var caretLine = el('span', 'code-slots__caret-line'); caret.appendChild(caretLine); row.appendChild(caret);
    var sr = el('span', 'code-slots__sr'); sr.setAttribute('aria-live', 'polite');
    root.appendChild(sr);

    var vals = new Array(n).fill('');
    var active = 0, focused = false, status = 'idle', draining = false, drainTimer = 0;

    var firstEmpty = function () { var k = vals.indexOf(''); return k === -1 ? n - 1 : k; };
    var full = function () { return vals.every(Boolean); };
    var code = function () { return vals.join(''); };
    var busy = function () { return input.disabled || draining || status === 'success'; };

    function pitch() { return slots.length > 1 ? slots[1].offsetLeft - slots[0].offsetLeft : slots[0].offsetWidth; }

    function paintSlot(k, delayMs) {
      var s = slots[k], ch = vals[k];
      s.style.setProperty('--cs-delay', (reduced() ? 0 : (delayMs || 0)) + 'ms');
      if (ch) { digits[k].textContent = o.mask ? '•' : ch; s.setAttribute('data-filled', ''); }
      else s.removeAttribute('data-filled');   // digit text stays during the exit transition
    }
    function paintCaret() {
      for (var k = 0; k < n; k++) slots[k].toggleAttribute('data-active', focused && k === active);
      caret.style.transform = 'translateX(' + (active * pitch()) + 'px)';
      var show = o.caret && focused && !input.disabled && status !== 'success' && !vals[active];
      caret.toggleAttribute('data-show', show);
      caretLine.style.animation = 'none'; void caretLine.offsetWidth; caretLine.style.animation = '';   // restart blink
      sr.textContent = status === 'success' ? 'Code accepted' : vals.filter(Boolean).length + ' / ' + n;
    }

    function commit(prevFull) {
      input.value = code();
      if (typeof o.onChange === 'function') o.onChange(code());
      if (!prevFull && full() && typeof o.onComplete === 'function') o.onComplete(code());
    }

    function insert(raw, from) {
      var d = digitsOf(raw);
      if (!d) return;
      if (status === 'error') setStatus('idle');
      var wasFull = full(), k = from, step = reduced() ? 0 : o.cascade;
      for (var j = 0; j < d.length && k < n; j++, k++) { vals[k] = d[j]; paintSlot(k, j * step); }
      active = Math.min(k, n - 1);
      paintCaret();
      commit(wasFull);
    }
    function clearSlot(k, stepBack) {
      if (status === 'error') setStatus('idle');
      if (vals[k]) { vals[k] = ''; paintSlot(k, 0); commit(true); }
      if (stepBack) active = k;
      paintCaret();
    }

    function onKeyDown(e) {
      if (busy() || e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key;
      if (/^[0-9]$/.test(k)) { e.preventDefault(); insert(k, active); }
      else if (k === 'Backspace') { e.preventDefault(); if (vals[active]) clearSlot(active); else if (active > 0) clearSlot(active - 1, true); }
      else if (k === 'Delete') { e.preventDefault(); clearSlot(active); }
      else if (k === 'ArrowLeft') { e.preventDefault(); active = Math.max(active - 1, 0); paintCaret(); }
      else if (k === 'ArrowRight') { e.preventDefault(); active = Math.min(active + 1, n - 1); paintCaret(); }
      else if (k === 'Home') { e.preventDefault(); active = 0; paintCaret(); }
      else if (k === 'End') { e.preventDefault(); active = n - 1; paintCaret(); }
      else if (k.length === 1 && k !== ' ' && k !== 'Enter') e.preventDefault();   // ignore letters
    }
    function onPaste(e) {
      if (busy()) return;
      e.preventDefault();
      var d = digitsOf((e.clipboardData || global.clipboardData).getData('text'));
      insert(d, d.length >= n ? 0 : active);
    }
    // Mobile keyboards, SMS/e-mail autofill and IMEs change .value without a usable keydown.
    function onInput() {
      if (busy()) { input.value = code(); return; }
      var d = digitsOf(input.value);
      var prev = code();
      if (d === prev) return;
      if (d.length > prev.length && d.indexOf(prev) === 0 && d.length - prev.length === 1) insert(d.slice(-1), active);
      else { for (var k = 0; k < n; k++) { vals[k] = ''; paintSlot(k, 0); } insert(d, 0); if (!d) { input.value = ''; active = 0; paintCaret(); } }
    }
    function onRowDown(e) {
      if (input.disabled) return;
      e.preventDefault();
      if (!draining && status !== 'success') {
        var r = row.getBoundingClientRect();
        var k = Math.floor((e.clientX - r.left) / pitch());
        if (document.documentElement.dir === 'rtl' && getComputedStyle(row).direction === 'rtl') k = n - 1 - k;
        active = Math.max(0, Math.min(k, firstEmpty()));
      }
      input.focus();
      paintCaret();
    }

    function setStatus(next) {
      if (next === status) return;
      var was = status;
      status = next;
      row.setAttribute('data-status', next);
      input.setAttribute('aria-invalid', next === 'error' ? 'true' : 'false');
      input.readOnly = next === 'success';
      if (next === 'success') {
        for (var k = 0; k < n; k++) slots[k].style.setProperty('--cs-sink-delay', (reduced() ? 0 : 60 + k * 30) + 'ms');
      }
      if (next === 'error') {
        var filled = [];
        for (var j = n - 1; j >= 0; j--) if (vals[j]) filled.push(j);
        if (filled.length) {
          draining = true;
          var step = reduced() ? 0 : o.cascade;
          // let the red tint show, then empty the slots right-to-left
          setTimeout(function () {
            filled.forEach(function (idx, q) { vals[idx] = ''; paintSlot(idx, q * step); });
            active = 0; paintCaret();
          }, reduced() ? 0 : 280);
          clearTimeout(drainTimer);
          drainTimer = setTimeout(function () { draining = false; input.value = ''; paintCaret(); },
            reduced() ? 300 : 280 + (filled.length - 1) * step + o.settle);
        }
      }
      if (was === 'success' || next === 'idle') paintCaret();
      paintCaret();
    }

    function reset() {
      clearTimeout(drainTimer); draining = false;
      status = 'idle'; row.setAttribute('data-status', 'idle');
      input.readOnly = false; input.setAttribute('aria-invalid', 'false');
      for (var k = 0; k < n; k++) { vals[k] = ''; paintSlot(k, 0); }
      input.value = ''; active = 0; paintCaret();
    }

    input.addEventListener('keydown', onKeyDown);
    input.addEventListener('paste', onPaste);
    input.addEventListener('input', onInput);
    input.addEventListener('focus', function () { focused = true; paintCaret(); });
    input.addEventListener('blur', function () { focused = false; paintCaret(); });
    row.addEventListener('mousedown', onRowDown);

    // start from whatever the field already holds
    var init = digitsOf(input.value).slice(0, n);
    for (var q = 0; q < init.length; q++) { vals[q] = init[q]; paintSlot(q, 0); }
    input.value = code(); active = firstEmpty(); paintCaret();

    return {
      el: root,
      setStatus: setStatus,
      reset: reset,
      value: code,
      focus: function () { input.focus(); }
    };
  }

  global.CodeSlots = { enhance: enhance };
})(window);
