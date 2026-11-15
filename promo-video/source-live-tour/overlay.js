// Injected into every page: cursor, ripple, spotlight, captions, bubbles, title cards. Pure visual layer, never touches app state.
(() => {
  if (window.__T) return;
  const css = `#tgFab{display:none!important} *{scroll-behavior:auto!important}
  #__t{position:fixed;inset:0;pointer-events:none;z-index:2147483646;font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  #__t .spot{position:fixed;border-radius:18px;box-shadow:0 0 0 9999px rgba(3,6,14,.72);outline:3px solid #3d8bff;outline-offset:4px;opacity:0;transition:all .55s cubic-bezier(.2,.8,.2,1)}
  #__t .bub{position:fixed;max-width:520px;background:#fff;color:#0b0d14;border-radius:18px;padding:18px 22px;font-size:24px;line-height:1.3;font-weight:600;box-shadow:0 24px 60px -12px rgba(0,0,0,.6);opacity:0;transform:translateY(12px);transition:opacity .4s,transform .4s,left .5s,top .5s}
  #__t .bub b{color:#1f6fff}#__t .bub .g{color:#0e9f63}
  #__t .bub small{display:block;font-size:18px;font-weight:500;color:#4a4f60;margin-top:6px}
  #__t .cap{position:fixed;left:50%;bottom:34px;transform:translate(-50%,20px);background:rgba(8,10,18,.92);color:#fff;border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:18px 34px;font-size:38px;font-weight:700;letter-spacing:-.01em;white-space:nowrap;opacity:0;transition:opacity .35s,transform .35s;box-shadow:0 20px 50px -10px rgba(0,0,0,.6)}
  #__t .cap .n{display:inline-block;background:#1f6fff;color:#fff;border-radius:10px;padding:2px 12px;margin-right:16px;font-size:28px;vertical-align:4px}
  #__t .cap em{font-style:normal;color:#5ea2ff}
  #__t .card{position:fixed;inset:0;display:grid;place-items:center;background:rgba(2,4,10,.86);backdrop-filter:blur(14px);opacity:0;transition:opacity .5s}
  #__t .card .in{text-align:center;color:#fff;transform:scale(.94);transition:transform .7s cubic-bezier(.2,.8,.2,1)}
  #__t .card .k{font-size:22px;letter-spacing:.42em;color:#5ea2ff;font-weight:700}
  #__t .card .h{font-size:96px;font-weight:800;letter-spacing:-.04em;line-height:1.05;margin-top:14px}
  #__t .card .s{font-size:34px;font-weight:500;color:#b8bdd0;margin-top:18px}
  #__t .card .h em{font-style:normal;color:#2fce8f}
  #__t .cur{position:fixed;left:0;top:0;width:34px;height:34px;transform:translate(-100px,-100px);filter:drop-shadow(0 4px 8px rgba(0,0,0,.5))}
  #__t .rip{position:fixed;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:3px solid #3d8bff;background:rgba(61,139,255,.25);animation:__rip .6s ease-out forwards}
  @keyframes __rip{to{transform:scale(5);opacity:0}}
  #__t .key{position:fixed;right:40px;top:120px;background:rgba(8,10,18,.92);color:#fff;border-radius:14px;padding:10px 18px;font-size:22px;font-weight:600;opacity:0;transition:opacity .3s}`;
  const mount = () => {
    if (document.getElementById('__t')) return;
    const st = document.createElement('style'); st.textContent = css; document.documentElement.appendChild(st);
    const r = document.createElement('div'); r.id = '__t';
    r.innerHTML = `<div class="spot"></div><div class="bub"></div><div class="cap"></div><div class="key"></div>
      <div class="card"><div class="in"></div></div>
      <svg class="cur" viewBox="0 0 24 24"><path d="M4 2l15 9.5-6.6 1.4 3.9 7.4-3 1.5-3.8-7.5L4 19z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    document.documentElement.appendChild(r);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  const q = s => document.querySelector('#__t ' + s);
  let cx = 960, cy = 600;
  const ease = t => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
  window.__T = {
    pos: () => [cx, cy],
    move(x, y, ms = 700) { mount(); const x0 = cx, y0 = cy, t0 = performance.now(), el = q('.cur');
      return new Promise(res => { const f = now => { const k = Math.min(1, (now - t0) / ms), e = ease(k);
        cx = x0 + (x - x0) * e; cy = y0 + (y - y0) * e - Math.sin(k * Math.PI) * 30; el.style.transform = `translate(${cx - 4}px,${cy - 2}px)`;
        k < 1 ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); }); },
    ripple(x, y) { const d = document.createElement('div'); d.className = 'rip'; d.style.left = x + 'px'; d.style.top = y + 'px'; document.getElementById('__t').appendChild(d); setTimeout(() => d.remove(), 700); },
    spot(r, pad = 10) { const s = q('.spot'); if (!r) { s.style.opacity = 0; return; }
      Object.assign(s.style, { left: (r.x - pad) + 'px', top: (r.y - pad) + 'px', width: (r.w + pad * 2) + 'px', height: (r.h + pad * 2) + 'px', opacity: 1 }); },
    bubble(html, x, y) { const b = q('.bub'); if (!html) { b.style.opacity = 0; b.style.transform = 'translateY(12px)'; return; }
      b.innerHTML = html; b.style.left = x + 'px'; b.style.top = y + 'px'; b.style.opacity = 1; b.style.transform = 'none'; },
    cap(html) { const c = q('.cap'); if (!html) { c.style.opacity = 0; c.style.transform = 'translate(-50%,20px)'; return; }
      c.innerHTML = html; c.style.opacity = 1; c.style.transform = 'translate(-50%,0)'; },
    key(t) { const k = q('.key'); if (!t) { k.style.opacity = 0; return; } k.textContent = t; k.style.opacity = 1; },
    card(html) { const c = q('.card'), i = q('.card .in'); if (!html) { c.style.opacity = 0; i.style.transform = 'scale(.94)'; return; }
      i.innerHTML = html; c.style.opacity = 1; requestAnimationFrame(() => i.style.transform = 'scale(1)'); },
    scrollTo(y, ms = 900) { const y0 = scrollY, t0 = performance.now();
      return new Promise(res => { const f = now => { const k = Math.min(1, (now - t0) / ms); window.scrollTo(0, y0 + (y - y0) * ease(k)); k < 1 ? requestAnimationFrame(f) : res(); }; requestAnimationFrame(f); }); },
    blurPII() { document.querySelectorAll('body *').forEach(e => { if ([...e.childNodes].some(c => c.nodeType === 3 && /marocheat|@gmail|USR0000/i.test(c.textContent))) e.style.filter = 'blur(8px)'; }); }
  };
  setInterval(() => window.__T && window.__T.blurPII(), 250);
})();
