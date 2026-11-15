// LuciBet live tour: drives the real site with Playwright and records it via CDP screencast.
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const BASE = process.env.BASE || 'https://matchday-edge-production.up.railway.app';
const OUT = path.join(__dirname, 'frames'); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT);
const TOK = fs.existsSync(__dirname + '/../.tok') ? fs.readFileSync(__dirname + '/../.tok', 'utf8').trim() : '';
const W = 1600, H = 900;
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1.2, permissions: ['notifications'] });
  await ctx.addInitScript(t => { try { if (t) localStorage.setItem('mde:token', t); localStorage.setItem('mde:consent', JSON.stringify({ v: 1, essential: true, presence: true, at: Date.now() })); localStorage.setItem('mde:lang', 'en'); } catch (e) {} }, TOK);
  await ctx.addInitScript({ path: path.join(__dirname, 'overlay.js') });
  const p = await ctx.newPage();
  p.on('dialog', d => d.dismiss());
  await p.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 90000 }).catch(() => {});

  await p.waitForTimeout(4000);

  // ── recorder ──
  const cdp = await ctx.newCDPSession(p); const idx = []; let n = 0;
  cdp.on('Page.screencastFrame', async f => { const file = `f${String(n++).padStart(6, '0')}.jpg`; fs.writeFileSync(path.join(OUT, file), Buffer.from(f.data, 'base64')); idx.push([file, f.metadata.timestamp]); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
  // keep frames flowing even when the page is still: a 1px invisible ticker forces a repaint every frame
  await p.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;z-index:2147483647;pointer-events:none;opacity:.01;background:#000'; document.documentElement.appendChild(d); let i = 0; (function f() { d.style.transform = `translateX(${(i++ % 2)}px)`; requestAnimationFrame(f); })(); });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

  // ── helpers ──
  const wait = ms => p.waitForTimeout(ms);
  const T = (fn, ...a) => p.evaluate(([fn, a]) => window.__T[fn](...a), [fn, a]);
  const rect = sel => p.evaluate(s => { const e = typeof s === 'string' ? document.querySelector(s) : null; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
  const rectOf = fnSrc => p.evaluate(src => { let e = (new Function('return (' + src + ')'))()(); if (typeof e === 'function') e = e(); if (!e) return null; document.querySelectorAll('[data-tour]').forEach(x => x.removeAttribute('data-tour')); e.setAttribute('data-tour', '1'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, fnSrc.toString());
  const marks = []; const INPAGE = process.env.INPAGE === '1';
  const cap = async (num, html) => { marks.push({ num, html, t: Date.now() / 1000 }); if (INPAGE) await T('cap', num ? `<span class="n">${num}</span>${html}` : html); };
  const card = async (html) => { marks.push({ card: !!html, t: Date.now() / 1000 }); if (INPAGE) await T('card', html); };
  const spot = (r, pad) => T('spot', r, pad);
  const bubble = (html, r, side = 'right') => { if (!html) return T('bubble', null);
    let x = side === 'right' ? r.x + r.w + 34 : side === 'left' ? r.x - 560 : r.x, y = side === 'below' ? r.y + r.h + 26 : side === 'above' ? r.y - 150 : r.y + 6;
    x = Math.max(24, Math.min(W - 560, x)); y = Math.max(24, Math.min(H - 260, y)); return T('bubble', html, x, y); };
  const moveTo = async (r, ms = 800, fx = .5, fy = .5) => { const x = r.x + r.w * fx, y = r.y + r.h * fy; await T('move', x, y, ms); await p.mouse.move(x, y); return [x, y]; };
  const click = async (r, ms = 800, fx, fy) => { const [x, y] = await moveTo(r, ms, fx, fy); await wait(150); await T('ripple', x, y); await p.mouse.click(x, y); await wait(250); };
  const clickSel = async (sel, ms) => { const r = await rect(sel); if (!r) throw new Error('missing ' + sel); await click(r, ms); };
  const scrollTo = (y, ms) => T('scrollTo', y, ms);
  const scrollIntoCenter = async (sel, ms = 1000) => { const y = await p.evaluate(s => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return scrollY + r.top - (innerHeight - r.height) / 2 + 40; }, sel); await scrollTo(Math.max(0, y), ms); await wait(150); };
  const typeSlow = async (text, d = 110) => { for (const ch of text) { await p.keyboard.type(ch); await wait(d); } };
  const drag = async (sel, toVal, ms = 1600) => { const g = await p.evaluate(s => { const e = document.querySelector(s); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width, min: +e.min, max: +e.max, v: +e.value }; }, sel);
    const X = v => g.x + 10 + (v - g.min) / (g.max - g.min) * (g.w - 20); const x0 = X(g.v), x1 = X(toVal);
    await T('move', x0, g.y, 600); await p.mouse.move(x0, g.y); await p.mouse.down(); await T('ripple', x0, g.y);
    const steps = Math.round(ms / 40); for (let i = 1; i <= steps; i++) { const k = i / steps, e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2, x = x0 + (x1 - x0) * e; await p.mouse.move(x, g.y); await p.evaluate(([x, y]) => window.__T.move(x, y, 1), [x, g.y]); await wait(40); }
    await p.mouse.up(); };
  const VO = JSON.parse(fs.readFileSync(path.join(__dirname, 'vo', 'durations.json'), 'utf8'));
  const SEC = { signals: '01', card: '02', value: '03', filters: '04', history: '05', discover: '06', standings: '07', demo: '08', settings: '09', pro: '10' };
  const step = async (name, fn) => { const t0 = Date.now(); try { await fn(); } catch (e) { console.log('STEP FAIL', name, e.message.split('\n')[0]); await T('spot', null); await T('bubble', null); }
    const need = ((VO[SEC[name]] || 0) + 1.0) * 1000 - (Date.now() - t0); if (need > 0) { const [x, y] = await p.evaluate(() => window.__T.pos()); await T('move', x + 40, y + 20, Math.min(need, 1500)); await wait(Math.max(0, need - 1500)); }
    console.log('step', name, ((Date.now() - t0) / 1000).toFixed(1), 's'); };
  const menu = async (sel) => { await clickSel('#menuBtn', 700); await wait(700); await clickSel(sel, 800); await wait(1800); await scrollTo(0, 10); };

  // ── TOUR ──
  await card(`<div class="k">LUCIBET · MATCH DAY EDGE</div><div class="h">Football analytics,<br><em>live.</em></div><div class="s">A tour of the real site, click by click.</div>`);
  await wait(4000); await card(null); await wait(Math.max(700, ((VO['00'] || 4) + 0.6) * 1000 - 4000));

  await step('signals', async () => {
    await cap('01', 'Signals: <em>every match today, priced by the model</em>');
    const r = await rectOf(() => () => document.querySelector('#stats') || document.querySelector('.stat-label')?.closest('section,div[class*=stats],div[class*=hero]'));
    await spot(r, 14); await moveTo(r, 900, .15, .5);
    await bubble(`<b>Live board</b>: matches today, matches with odds, value bets found and the <span class="g">best EV</span> on the board.`, r, 'below');
    await wait(1200); await moveTo(r, 900, .82, .5); await wait(2200);
    await bubble(null); await spot(null);
  });

  await step('card', async () => {
    await cap('02', 'Match model: <em>probabilities for every market</em>');
    await scrollIntoCenter('#cards > *', 1100);
    const r = await rectOf(() => () => document.querySelector('#cards > *'));
    await spot(r, 10); await bubble(`<b>Win · Draw · Away</b> — the model's probability for each result, plus the most likely <b>scoreline</b> and <b>Over/Under</b> goals.`, r, 'right');
    const prob = await rectOf(() => () => document.querySelector('#cards > *').querySelectorAll('[class*=prob],[class*=pct],button')[0]);
    await moveTo(r, 900, .2, .55); await wait(700); await moveTo(r, 600, .5, .55); await wait(700); await moveTo(r, 600, .8, .55); await wait(900);
    await moveTo(r, 800, .6, .82); await wait(1600);
    const pin = await rectOf(() => () => document.querySelector('#cards > * .pin-btn:not(.share-btn)'));
    if (pin) { await bubble(`<b>Pin</b> the matches you follow — they stay on top.`, r, 'right'); await click(pin, 800); await wait(1600); }
    await bubble(null); await spot(null);
  });

  await step('value', async () => {
    await cap('03', 'Value bets: <em>only when the price is wrong</em>');
    // read today's value bet from the board (live data changes during the day)
    const vb = await p.evaluate(() => { const ev = document.querySelector('.vb-ev'); if (!ev) return null;
      const box = ev.closest('.vb') || ev.parentElement.parentElement; const txt = [...box.querySelectorAll('*')].filter(e => !e.children.length).map(e => e.textContent.trim()).filter(Boolean);
      const pick = txt.find(x => /to win|draw|over|under/i.test(x)) || ''; const odds = txt.find(x => /^\d+\.\d+$/.test(x)) || '';
      const kelly = txt.find(x => /kelly/i.test(x)) || ''; const conf = txt.find(x => /^(high|medium|low)$/i.test(x)) || '';
      return { pick, odds, ev: ev.textContent.trim(), kelly, conf }; });
    console.log('VALUE BET', JSON.stringify(vb));
    await scrollTo(0, 900); await clickSel('#searchBtn', 800); await wait(600);
    const term = vb && vb.pick ? vb.pick.replace(/\s+to win.*$/i, '').replace(/\s*\(.*$/, '').trim() : '';
    if (term) { await T('key', `Search: "${term}"`); await typeSlow(term, 130); await wait(1500); await T('key', null); }
    const r = await rectOf(() => () => { const e = document.querySelector('.vb-ev'); return e ? e.closest('article.match') : document.querySelector('#cards > *'); });
    if (r) { await p.evaluate(() => { const e = document.querySelector('[data-tour]'); const rr = e.getBoundingClientRect(); if (rr.top < 80 || rr.bottom > innerHeight - 160) scrollBy(0, rr.top - innerHeight / 2 + rr.height / 2); }); await wait(500); }
    const r2 = await rectOf(() => () => document.querySelector('[data-tour]'));
    await spot(r2, 12); await moveTo(r2, 900, .5, .5);
    if (vb) await bubble(`<b>${vb.pick}${vb.odds ? ' @ ' + vb.odds : ''}</b><br>The model's price beats the market → <span class="g">${vb.ev.replace(/\s*EV/i, '')} expected value</span>.<small>${[vb.kelly, vb.conf && 'confidence ' + vb.conf].filter(Boolean).join(' · ')}</small>`, r2, 'right');
    else await bubble(`When the model's price beats the market, the match gets a <span class="g">Value Bet</span> badge with its expected value.`, r2, 'right');
    await wait(4200); await bubble(null); await spot(null);
    await clickSel('#searchClose', 700).catch(() => p.keyboard.press('Escape')); await wait(800);
  });

  await step('filters', async () => {
    await cap('04', 'Model filters: <em>tune the engine yourself</em>');
    await scrollTo(0, 600); await clickSel('#openFilterBtn', 900); await wait(1000);
    const m = await rectOf(() => () => document.querySelector('#filterModal .modal, #filterModal [class*=sheet], #filterModal > div') || document.querySelector('#filterModal'));
    await spot(m, 8);
    const s1 = await rect('#mw'); await bubble(`<b>Market weight</b>: how much the final probability trusts the bookmakers vs the Poisson model.`, m, 'right');
    await drag('#mw', 60, 1700); await wait(900); await drag('#mw', 85, 1200); await wait(700);
    await bubble(`<b>Minimum EV</b>: the edge a price needs before it's flagged as a value bet. Watch the summary update live.`, m, 'right');
    await drag('#mev', 2, 1600); await wait(1600);
    const pv = await rect('#fpreview'); if (pv) { await moveTo(pv, 700, .5, .3); await wait(1800); }
    await drag('#mev', 4.5, 1200); await wait(600);
    await bubble(null); await spot(null);
    const done = await rectOf(() => () => [...document.querySelectorAll('#filterModal button')].find(b => /done/i.test(b.textContent)));
    if (done) await click(done, 700); else await p.keyboard.press('Escape'); await wait(900);
  });

  await step('history', async () => {
    await cap('05', 'Bot history: <em>every pick settled, win or lose</em>');
    await clickSel('#nav-history', 900); await wait(2200);
    await moveTo(await rect('#history-list'), 800, .5, .3); await scrollTo(500, 1400); await wait(400); await scrollTo(0, 900);
    await clickSel('#historySearch', 700); await T('key', 'Search a team: "Vasco"'); await typeSlow('Vasco', 140); await wait(1300); await T('key', null);
    const r = await rectOf(() => () => document.querySelector('#history-list > *'));
    if (r) { await spot(r, 8); await moveTo(r, 800, .5, .6); await bubble(`Each past match shows the bot's <b>1X2</b> and <b>goals</b> picks with a <span class="g">WIN</span> / LOSS badge.`, r, 'right'); await wait(3600); await bubble(null); await spot(null); }
  });

  await step('discover', async () => {
    await cap('06', 'Discover: <em>the community feed</em>');
    await clickSel('#nav-discover', 900); await wait(2200);
    const r = await rectOf(() => () => document.querySelector('#discoverFeed > *'));
    if (r) { await moveTo(r, 800, .5, .3); }
    await scrollTo(450, 1500); await wait(600); await scrollTo(900, 1500); await wait(1400); await scrollTo(0, 900); await wait(300);
  });

  await step('standings', async () => {
    await cap('07', 'League tables: <em>standings, teams and scorers</em>');
    await menu('[data-tab=standings]');
    const chips = await p.$$eval('#fbStChips button, #fbStChips [role=tab], #fbStChips > *', els => els.slice(0, 4).map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
    for (const c of chips.slice(1, 4)) { await click(c, 700); await wait(1100); }
    if (chips[0]) { await click(chips[0], 700); await wait(1300); }
    const row = await rectOf(() => () => document.querySelector('#fbStBody [onclick]') || [...document.querySelectorAll('#fbStBody tr')].find(r => r.querySelector('td')));
    if (row) { await spot(row, 6); await bubble(`Click any team to open its <b>form, results and top scorers</b>.`, row, 'below'); await wait(1400); await click(row, 800, .2, .5); await wait(2600); await spot(null); await bubble(null);
      const mod = await rectOf(() => () => document.querySelector('#fbTeamModal [class*=modal], #fbTeamModal > div') || document.querySelector('#fbTeamModal'));
      if (mod) { await moveTo(mod, 800, .5, .5); await wait(2600); }
      await p.keyboard.press('Escape'); await wait(500);
      const x = await rectOf(() => () => [...document.querySelectorAll('#fbTeamModal button')].find(b => b.offsetParent && /close|×|✕/i.test(b.textContent + (b.getAttribute('aria-label') || ''))));
      if (x) await click(x, 600); await wait(700); }
  });

  await step('demo', async () => {
    await cap('08', 'Demo Arena: <em>practise with virtual credits</em>');
    await menu('[data-tab=demo]');
    const r = await rectOf(() => () => document.querySelector('#view-demo .da-hero'));
    await spot(r, 8); await moveTo(r, 900, .3, .6);
    await bubble(`Start with <b>2,000 DH virtual</b> credits, predict real matches and track your record. <span class="g">No real money, ever.</span>`, r, 'below');
    await wait(3600); await bubble(null); await spot(null);
    const tab = await rectOf(() => () => [...document.querySelectorAll('#view-demo button')].find(b => b.offsetParent && /^\s*Finished\s*$/i.test(b.textContent)));
    if (tab) { await click(tab, 800); await wait(1500); }
    const tab2 = await rectOf(() => () => [...document.querySelectorAll('#view-demo button')].find(b => b.offsetParent && /^\s*Upcoming\s*$/i.test(b.textContent)));
    if (tab2) { await click(tab2, 700); await wait(1200); }
    await scrollTo(600, 1500); await wait(1200); await scrollTo(0, 900);
  });

  await step('settings', async () => {
    await cap('09', 'Settings: <em>your theme, your language</em>');
    await clickSel('#menuBtn', 700); await wait(700); await clickSel('#menuSetBtn', 800); await wait(1300);
    const grid = await rect('#themeGrid');
    if (grid) { await spot(grid, 10); const items = await p.$$eval('#themeGrid > *', els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
      for (const it of items.slice(0, 4)) { await click(it, 650); await wait(1100); }
      if (items[0]) { await click(items[0], 600); await wait(800); } await spot(null); }
    const ls = await rect('#langSelect');
    if (ls) { await spot(ls, 8); await moveTo(ls, 700); await T('ripple', ls.x + ls.w / 2, ls.y + ls.h / 2);
      for (const v of ['fr', 'ar', 'en']) { await p.selectOption('#langSelect', v).catch(() => {}); await T('key', { fr: 'Français', ar: 'العربية', en: 'English' }[v]); await wait(1700); }
      await T('key', null); await spot(null); }
    await p.keyboard.press('Escape'); await wait(500);
    const x = await rectOf(() => () => [...document.querySelectorAll('#settingsModal button')].find(b => b.offsetParent && /close|done|save|×|✕/i.test(b.textContent + (b.getAttribute('aria-label') || ''))));
    if (x) await click(x, 600); await wait(700);
  });

  await step('pro', async () => {
    await cap('10', 'Pro: <em>one plan, everything unlocked</em>');
    await menu('[data-tab=unlock]');
    const r = await rectOf(() => () => document.querySelector('#planBox > *') || document.querySelector('#planBox'));
    await spot(r, 10); await moveTo(r, 900, .4, .45);
    await bubble(`<b>$30</b> · daily +EV value bets, win probabilities, Over/Under and scorelines, match alerts and live scores.<small>No hidden fees, no automatic renewal.</small>`, r, 'right');
    await wait(4200); await bubble(null); await spot(null);
  });

  await cap(null, null);
  await card(`<div class="k">MATCH DAY EDGE</div><div class="h">LuciBet</div><div class="s" style="color:#fff;font-weight:700">Find the edge. <span style="color:#2fce8f">The decision is yours.</span></div><div class="s" style="font-size:30px;margin-top:30px">1uciferxyz.com</div><div class="s" style="font-size:18px;margin-top:40px;color:#7d8296">18+ · Statistical estimates, not guarantees. Play responsibly.</div>`);
  await wait(((VO['11'] || 8) + 1.2) * 1000);

  await cdp.send('Page.stopScreencast'); await wait(300);
  fs.writeFileSync(path.join(__dirname, 'index.json'), JSON.stringify(idx)); fs.writeFileSync(path.join(__dirname, 'marks.json'), JSON.stringify({ t0: idx[0][1], marks }));
  console.log('frames', idx.length, 'secs', (idx.at(-1)[1] - idx[0][1]).toFixed(1));
  await b.close();
})();
