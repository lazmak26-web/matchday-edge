#!/usr/bin/env python3
"""Generates 10 standalone design previews (hand-written CSS, zero libraries)."""
import os, html

OUT = os.path.dirname(os.path.abspath(__file__))

BASE = """
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{min-height:100vh;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:none}
img{display:block}
.tab{display:none}
.tab.active{display:block;animation:tabin .35s cubic-bezier(.2,.8,.2,1) both}
@keyframes tabin{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.modal{position:fixed;inset:0;display:grid;place-items:center;opacity:0;visibility:hidden;transition:opacity .25s,visibility .25s;z-index:100;padding:16px}
.modal.open{opacity:1;visibility:visible}
.box{transform:translateY(16px) scale(.97);transition:transform .32s cubic-bezier(.2,.8,.2,1);width:min(420px,100%)}
.modal.open .box{transform:none}
.odds{display:flex;gap:6px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.field{display:grid;gap:6px;margin:14px 0}
.field select,.field input{width:100%}
.legend{position:fixed;right:12px;bottom:12px;z-index:200;font:600 11px/1 system-ui,sans-serif;background:#000c;color:#fff;padding:7px 10px;border-radius:99px;text-decoration:none}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"""

BODY = """
<div class="app">
  <header class="top">
    <div class="brand"><img src="../public/logo.png" alt="" width="36" height="36"><div><b>LuciBet</b><small>Football analytics</small></div></div>
    <button class="gear" id="gear" aria-label="Settings">⚙ <span>Settings</span></button>
  </header>
  <nav class="nav" aria-label="Main">
    <button class="nav-item active" data-tab="discover"><i>◎</i><span>Discover</span></button>
    <button class="nav-item" data-tab="signals"><i>◆</i><span>Signals</span></button>
    <button class="nav-item" data-tab="history"><i>↺</i><span>History</span></button>
  </nav>
  <main class="main">
    <section class="hero">
      <p class="eyebrow">⚽ Live odds · +EV value bets</p>
      <h1>Match analytics.<br>The decision is yours.</h1>
      <p class="sub">Statistical analysis built on a Poisson model and live market odds. Estimates, not guaranteed outcomes.</p>
    </section>
    <section class="stats">
      <div class="stat"><span class="k">Hit rate · 30d</span><span class="v">58.4%</span></div>
      <div class="stat"><span class="k">Avg. edge</span><span class="v">+5.7%</span></div>
      <div class="stat"><span class="k">Value bets today</span><span class="v">7</span></div>
    </section>
    <section class="tabs">
      <div class="tab active" id="t-discover">
        <h2 class="sec">Today's Matches</h2>
        <div class="list">
          <article class="match is-value"><div class="meta"><span class="league">Premier League</span><span class="time">20:45</span></div><div class="teams"><b>Arsenal</b><i>vs</i><b>Newcastle</b></div><div class="odds"><span class="odd">1.85</span><span class="odd">3.60</span><span class="odd">4.40</span></div><span class="edge">+6.2% EV</span><div class="bar"><u style="width:62%"></u></div></article>
          <article class="match"><div class="meta"><span class="league">La Liga</span><span class="time">21:00</span></div><div class="teams"><b>Sevilla</b><i>vs</i><b>Valencia</b></div><div class="odds"><span class="odd">2.10</span><span class="odd">3.25</span><span class="odd">3.50</span></div><span class="edge off">+0.8% EV</span><div class="bar"><u style="width:41%"></u></div></article>
          <article class="match is-value"><div class="meta"><span class="league">Serie A</span><span class="time">18:30</span></div><div class="teams"><b>Napoli</b><i>vs</i><b>Torino</b></div><div class="odds"><span class="odd">1.52</span><span class="odd">4.10</span><span class="odd">6.50</span></div><span class="edge">+4.9% EV</span><div class="bar"><u style="width:71%"></u></div></article>
          <article class="match"><div class="meta"><span class="league">Botola Pro</span><span class="time">19:00</span></div><div class="teams"><b>Raja</b><i>vs</i><b>FUS Rabat</b></div><div class="odds"><span class="odd">2.30</span><span class="odd">2.95</span><span class="odd">3.20</span></div><span class="edge off">−1.1% EV</span><div class="bar"><u style="width:38%"></u></div></article>
        </div>
      </div>
      <div class="tab" id="t-signals">
        <h2 class="sec">Daily Signals</h2>
        <div class="list">
          <article class="match is-value"><div class="meta"><span class="league">Over / Under 2.5</span><span class="time">Today</span></div><div class="teams"><b>Arsenal</b><i>vs</i><b>Newcastle</b></div><div class="odds"><span class="odd">Over 1.95</span></div><span class="edge">+6.2% EV</span><div class="bar"><u style="width:62%"></u></div></article>
          <article class="match is-value"><div class="meta"><span class="league">1X2</span><span class="time">Today</span></div><div class="teams"><b>Napoli</b><i>vs</i><b>Torino</b></div><div class="odds"><span class="odd">Home 1.52</span></div><span class="edge">+4.9% EV</span><div class="bar"><u style="width:71%"></u></div></article>
        </div>
      </div>
      <div class="tab" id="t-history">
        <h2 class="sec">Bot History</h2>
        <div class="list">
          <article class="match"><div class="meta"><span class="league">Yesterday</span><span class="time">FT 2–1</span></div><div class="teams"><b>Inter</b><i>vs</i><b>Roma</b></div><div class="odds"><span class="odd">Home 1.90</span></div><span class="edge">WON</span></article>
          <article class="match"><div class="meta"><span class="league">Yesterday</span><span class="time">FT 0–0</span></div><div class="teams"><b>Lyon</b><i>vs</i><b>Nice</b></div><div class="odds"><span class="odd">Over 2.05</span></div><span class="edge off">LOST</span></article>
        </div>
      </div>
    </section>
  </main>
</div>
<div class="modal" id="modal" role="dialog" aria-modal="true" aria-label="Settings">
  <div class="box">
    <div class="row"><h3>⚙ Settings</h3><button class="x" id="close" aria-label="Close">✕</button></div>
    <div class="field"><label for="lang">Language</label><select id="lang"><option>English</option><option>Français</option><option>العربية</option></select></div>
    <div class="field"><label for="ev">Minimum EV: <b id="evv">4.5</b>%</label><input id="ev" type="range" min="0" max="10" step="0.5" value="4.5"></div>
    <button class="save" id="save">Save</button>
  </div>
</div>
"""

SCRIPT = """
(function(){
  var tabs=document.querySelectorAll('.nav-item'),panes=document.querySelectorAll('.tab');
  tabs.forEach(function(b){b.addEventListener('click',function(){
    tabs.forEach(function(x){x.classList.toggle('active',x===b)});
    panes.forEach(function(p){p.classList.toggle('active',p.id==='t-'+b.dataset.tab)});
  })});
  var m=document.getElementById('modal');
  function o(){m.classList.add('open')}function c(){m.classList.remove('open')}
  document.getElementById('gear').onclick=o;document.getElementById('close').onclick=c;document.getElementById('save').onclick=c;
  m.addEventListener('click',function(e){if(e.target===m)c()});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')c()});
  var ev=document.getElementById('ev'),evv=document.getElementById('evv');
  ev.addEventListener('input',function(){evv.textContent=ev.value});
})();
"""

EXTRA_JS = {
 7: """document.addEventListener('pointermove',function(e){document.documentElement.style.setProperty('--mx',e.clientX+'px');document.documentElement.style.setProperty('--my',e.clientY+'px')});"""
}

DESIGNS = []
def d(name, tagline, css): DESIGNS.append((name, tagline, css))

# 1 ─────────────────────────────────────────────────────────────
d("Obsidian Pitch", "Dark + mowed-grass stripes, neon green numbers", """
:root{--bg:#050907;--card:#0b130f;--ink:#e9f5ee;--mut:#7c968a;--g:#22e58a;--line:rgba(34,229,138,.18)}
body{background:radial-gradient(900px 500px at 50% -10%,rgba(34,229,138,.14),transparent 60%),repeating-linear-gradient(90deg,rgba(255,255,255,.022) 0 70px,transparent 70px 140px),var(--bg);color:var(--ink);font:15px/1.55 system-ui,'Segoe UI',Roboto,sans-serif}
.top{display:flex;justify-content:space-between;align-items:center;padding:14px 24px;position:sticky;top:0;backdrop-filter:blur(14px);background:rgba(5,9,7,.7);border-bottom:1px solid var(--line);z-index:20}
.brand{display:flex;gap:10px;align-items:center}.brand img{border-radius:10px}.brand b{display:block;letter-spacing:.04em}.brand small{color:var(--mut);font-size:11px}
.gear{padding:8px 14px;border:1px solid var(--line);border-radius:10px;color:var(--g)}
.nav{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:4px;padding:6px;border-radius:999px;background:#0b130fee;border:1px solid var(--line);z-index:30;box-shadow:0 20px 40px -10px #000}
.nav-item{display:flex;gap:8px;align-items:center;padding:10px 18px;border-radius:999px;color:var(--mut);font-weight:600;transition:background .25s,color .25s}
.nav-item.active{background:var(--g);color:#032013}
.main{max-width:1000px;margin:0 auto;padding:44px 20px 120px}
.eyebrow{color:var(--g);font-size:13px;letter-spacing:.14em;text-transform:uppercase}
h1{font-size:clamp(34px,6vw,64px);line-height:1.02;letter-spacing:-.03em;margin:12px 0}
.sub{color:var(--mut);max-width:560px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:34px 0}
.stat{border:1px solid var(--line);background:var(--card);border-radius:18px;padding:18px;position:relative;overflow:hidden}
.stat::after{content:"";position:absolute;right:-30px;top:-30px;width:90px;height:90px;border:1px solid var(--line);border-radius:50%}
.k{display:block;color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.v{font:700 clamp(28px,4vw,42px) ui-monospace,Menlo,monospace;color:var(--g)}
.sec{font-size:22px;margin-bottom:14px}
.list{display:grid;gap:12px}
.match{display:grid;grid-template-columns:1.1fr 1.6fr auto auto;gap:14px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;position:relative;transition:transform .25s,border-color .25s}
.match:hover{transform:translateY(-2px);border-color:var(--g)}
.match.is-value{box-shadow:0 0 0 1px var(--g),0 10px 40px -18px var(--g)}
.meta{display:grid}.league{font-weight:600}.time{color:var(--mut);font-size:12px}
.teams{display:flex;gap:8px;align-items:baseline;font-size:17px}.teams i{color:var(--mut);font-size:12px}
.odd{padding:6px 10px;border-radius:8px;background:#ffffff0a;font-family:ui-monospace,monospace}
.edge{font:700 13px ui-monospace,monospace;padding:6px 10px;border-radius:99px;background:rgba(34,229,138,.14);color:var(--g)}.edge.off{background:#ffffff0a;color:var(--mut)}
.bar{grid-column:1/-1;height:3px;background:#ffffff10;border-radius:3px}.bar u{display:block;height:100%;background:var(--g);border-radius:3px}
.modal{background:#000a;backdrop-filter:blur(6px)}.box{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:22px;color:var(--ink)}
.x{color:var(--mut)}.save{width:100%;padding:12px;border-radius:12px;background:var(--g);color:#032013;font-weight:700}
.field select,.field input{accent-color:var(--g)}.field select{padding:10px;background:#000;border:1px solid var(--line);border-radius:10px;color:var(--ink)}
@media(max-width:700px){.match{grid-template-columns:1fr auto}.teams{grid-column:1/-1}.stats{grid-template-columns:1fr}.nav-item span{display:none}.nav-item.active span{display:inline}}
""")

# 2 ─────────────────────────────────────────────────────────────
d("Terminal Quant", "Bloomberg-style: dense, mono, amber on black", """
:root{--bg:#0a0a0a;--ink:#d8d8d8;--a:#ffb000;--mut:#7a7a7a;--line:#2b2b2b;--up:#33ff88;--dn:#ff4d4d}
body{background:var(--bg);color:var(--ink);font:13px/1.5 ui-monospace,'SF Mono',Menlo,Consolas,monospace}
.top{display:flex;justify-content:space-between;align-items:center;padding:8px 16px;background:#141414;border-bottom:2px solid var(--a)}
.brand{display:flex;gap:10px;align-items:center}.brand img{filter:grayscale(1) contrast(1.2)}.brand b{color:var(--a);text-transform:uppercase;letter-spacing:.1em}.brand small{display:block;color:var(--mut)}
.gear{border:1px solid var(--a);color:var(--a);padding:5px 10px;text-transform:uppercase}
.nav{display:flex;background:#101010;border-bottom:1px solid var(--line)}
.nav-item{padding:9px 20px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;border-right:1px solid var(--line);transition:background .2s,color .2s}
.nav-item i{display:none}.nav-item.active{background:var(--a);color:#000;font-weight:700}
.main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
.eyebrow{color:var(--a);text-transform:uppercase;letter-spacing:.12em}
h1{font-size:clamp(22px,3.4vw,34px);text-transform:uppercase;letter-spacing:-.01em;margin:6px 0;color:#fff}
.sub{color:var(--mut)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);margin:18px 0}
.stat{padding:12px 14px;border-right:1px solid var(--line)}.stat:last-child{border:0}
.k{display:block;color:var(--mut);text-transform:uppercase;font-size:11px}.v{font-size:30px;color:var(--up)}
.sec{font-size:13px;text-transform:uppercase;color:var(--a);padding:6px 0;border-bottom:1px solid var(--a);margin-bottom:0}
.list{border:1px solid var(--line);border-top:0}
.match{display:grid;grid-template-columns:150px 1fr 190px 90px;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--line);position:relative;transition:background .15s}
.match:hover{background:#181818}.match.is-value{border-left:3px solid var(--up);background:#0d1a12}
.meta{display:grid}.league{color:var(--a)}.time{color:var(--mut)}
.teams{display:flex;gap:8px}.teams i{color:var(--mut)}.teams b{font-weight:600;color:#fff}
.odd{padding:2px 8px;border:1px solid var(--line);min-width:52px;text-align:center}
.edge{text-align:right;color:var(--up);font-weight:700}.edge.off{color:var(--dn)}
.bar{display:none}
.modal{background:#000b}.box{background:#101010;border:1px solid var(--a);padding:18px;color:var(--ink)}
.x{color:var(--a)}.save{width:100%;padding:9px;background:var(--a);color:#000;text-transform:uppercase;font-weight:700}
.field select{padding:8px;background:#000;border:1px solid var(--line);color:var(--ink)}.field input{accent-color:var(--a)}
@media(max-width:760px){.match{grid-template-columns:1fr auto}.teams{grid-column:1/-1}.stats{grid-template-columns:1fr}.stat{border-right:0;border-bottom:1px solid var(--line)}}
""")

# 3 ─────────────────────────────────────────────────────────────
d("Paper Almanac", "Cream newsprint, serif headlines, ink & red", """
:root{--bg:#f2e9d4;--ink:#1c1b29;--red:#a8231b;--mut:#6b6558;--rule:#1c1b29}
body{background:var(--bg) repeating-linear-gradient(0deg,transparent 0 31px,rgba(0,0,0,.035) 31px 32px);color:var(--ink);font:16px/1.6 Georgia,'Times New Roman',serif}
.top{text-align:center;padding:22px 20px 10px;border-bottom:4px double var(--rule);position:relative}
.brand{display:flex;flex-direction:column;align-items:center;gap:4px}.brand img{width:44px;height:44px;border-radius:50%;filter:sepia(.6);background:#1c1b29;padding:4px}.brand b{font-size:clamp(30px,5vw,52px);letter-spacing:.06em;font-variant:small-caps}.brand small{font-style:italic;color:var(--mut)}
.gear{position:absolute;right:16px;top:16px;font:italic 14px Georgia,serif;text-decoration:underline;color:var(--red)}
.nav{display:flex;justify-content:center;gap:34px;padding:10px;border-bottom:1px solid var(--rule)}
.nav-item{font:600 14px Georgia,serif;letter-spacing:.14em;text-transform:uppercase;padding:4px 0;border-bottom:2px solid transparent;transition:border-color .25s,color .25s}
.nav-item i{display:none}.nav-item.active{border-color:var(--red);color:var(--red)}
.main{max-width:980px;margin:0 auto;padding:30px 20px 80px}
.eyebrow{font-style:italic;color:var(--red)}
h1{font-size:clamp(38px,7vw,76px);line-height:1;font-weight:900;margin:8px 0 12px;letter-spacing:-.02em}
.sub{max-width:600px;color:var(--mut);font-style:italic;border-left:3px solid var(--red);padding-left:12px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);margin:30px 0;border-top:3px solid var(--rule);border-bottom:1px solid var(--rule)}
.stat{padding:14px;text-align:center;border-right:1px solid var(--rule)}.stat:last-child{border:0}
.k{display:block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}.v{font-size:44px;font-weight:900;color:var(--red)}
.sec{font-size:26px;border-bottom:1px solid var(--rule);padding-bottom:6px;margin-bottom:6px;font-variant:small-caps}
.list{display:grid}
.match{display:grid;grid-template-columns:140px 1fr auto auto;gap:16px;align-items:baseline;padding:14px 4px;border-bottom:1px dotted var(--rule);transition:background .2s}
.match:hover{background:rgba(168,35,27,.06)}.match.is-value .teams b{text-decoration:underline;text-decoration-color:var(--red);text-decoration-thickness:2px}
.league{font-variant:small-caps;font-weight:700;display:block}.time{font-style:italic;color:var(--mut);font-size:13px}
.teams{font-size:21px;display:flex;gap:10px}.teams i{color:var(--mut);font-size:14px}
.odd{font-family:Georgia,serif;font-variant-numeric:oldstyle-nums;padding:0 6px;border-bottom:1px solid var(--rule)}
.edge{font-weight:700;color:var(--red);font-style:italic}.edge.off{color:var(--mut);font-weight:400}
.bar{display:none}
.modal{background:rgba(28,27,41,.55)}.box{background:var(--bg);border:3px double var(--rule);padding:22px;box-shadow:8px 8px 0 rgba(0,0,0,.2)}
.x{font-size:18px}.save{width:100%;padding:11px;background:var(--ink);color:var(--bg);letter-spacing:.14em;text-transform:uppercase}
.field select{padding:9px;background:#fffaf0;border:1px solid var(--rule);font:inherit}.field input{accent-color:var(--red)}
@media(max-width:700px){.match{grid-template-columns:1fr auto}.teams{grid-column:1/-1}.stats{grid-template-columns:1fr}.stat{border-right:0;border-bottom:1px solid var(--rule)}}
""")

# 4 ─────────────────────────────────────────────────────────────
d("Neo-Brutalist", "Thick black borders, hard shadows, loud colours", """
:root{--bg:#ffe84a;--ink:#000;--pk:#ff5fa2;--bl:#59c3ff;--gr:#5dff9b;--w:#fff}
body{background:var(--bg);color:var(--ink);font:600 15px/1.5 'Arial Black',Arial,Helvetica,sans-serif;font-weight:700}
.top{display:flex;justify-content:space-between;align-items:center;padding:14px 20px;background:var(--w);border-bottom:4px solid var(--ink)}
.brand{display:flex;gap:10px;align-items:center}.brand img{border:3px solid #000;border-radius:8px}.brand b{font-size:22px;text-transform:uppercase}.brand small{display:block;font-weight:600}
.gear{background:var(--pk);border:3px solid #000;box-shadow:4px 4px 0 #000;padding:8px 14px;text-transform:uppercase;font-weight:800;transition:transform .12s,box-shadow .12s}
.gear:active,.nav-item:active{transform:translate(4px,4px);box-shadow:0 0 0 #000}
.nav{display:flex;gap:12px;padding:16px 20px;flex-wrap:wrap}
.nav-item{background:var(--w);border:3px solid #000;box-shadow:4px 4px 0 #000;padding:10px 18px;text-transform:uppercase;font-weight:800;display:flex;gap:8px;transition:transform .12s,box-shadow .12s,background .12s}
.nav-item:hover{transform:translate(-2px,-2px);box-shadow:6px 6px 0 #000}.nav-item.active{background:var(--bl)}
.main{max-width:1000px;margin:0 auto;padding:10px 20px 80px}
.eyebrow{display:inline-block;background:#000;color:var(--bg);padding:4px 10px;text-transform:uppercase;font-size:12px}
h1{font-size:clamp(36px,7vw,78px);line-height:.98;text-transform:uppercase;margin:14px 0;letter-spacing:-.03em;font-weight:900}
.sub{max-width:560px;font-weight:600;background:var(--w);border:3px solid #000;padding:10px 14px;box-shadow:5px 5px 0 #000}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:30px 0}
.stat{background:var(--gr);border:4px solid #000;box-shadow:6px 6px 0 #000;padding:14px}.stat:nth-child(2){background:var(--pk)}.stat:nth-child(3){background:var(--bl)}
.k{display:block;font-size:12px;text-transform:uppercase}.v{font-size:clamp(30px,5vw,50px);font-weight:900}
.sec{font-size:26px;text-transform:uppercase;margin-bottom:14px;display:inline-block;background:#000;color:#fff;padding:2px 12px}
.list{display:grid;gap:16px}
.match{display:grid;grid-template-columns:1fr auto;gap:8px 14px;background:var(--w);border:4px solid #000;box-shadow:6px 6px 0 #000;padding:14px;transition:transform .15s,box-shadow .15s}
.match:hover{transform:translate(-3px,-3px);box-shadow:9px 9px 0 #000}.match.is-value{background:var(--gr)}
.meta{display:flex;gap:10px;grid-column:1/-1;font-size:12px;text-transform:uppercase}
.teams{display:flex;gap:10px;font-size:22px;text-transform:uppercase}.teams i{font-size:13px;align-self:center}
.odd{border:3px solid #000;padding:2px 8px;background:var(--w)}
.edge{background:#000;color:var(--bg);padding:4px 10px;align-self:center;justify-self:end;grid-row:2;grid-column:2}.edge.off{background:#ddd;color:#000}
.bar{grid-column:1/-1;height:12px;border:3px solid #000;background:#fff}.bar u{display:block;height:100%;background:var(--pk)}
.modal{background:rgba(0,0,0,.5)}.box{background:var(--w);border:5px solid #000;box-shadow:10px 10px 0 #000;padding:20px}
.x{border:3px solid #000;width:34px;height:34px;background:var(--pk)}.save{width:100%;padding:12px;border:4px solid #000;background:var(--gr);text-transform:uppercase;font-weight:900;box-shadow:4px 4px 0 #000}
.field select{padding:10px;border:3px solid #000;background:#fff;font:inherit}.field input{accent-color:#000}
@media(max-width:700px){.stats{grid-template-columns:1fr}}
""")

# 5 ─────────────────────────────────────────────────────────────
d("Glass Aurora", "Frosted glass over slow-moving colour", """
:root{--ink:#f4f3ff;--mut:#b9b6dd}
body{background:#0c0a1f;color:var(--ink);font:15px/1.55 system-ui,'Segoe UI',Roboto,sans-serif;overflow-x:hidden}
body::before,body::after{content:"";position:fixed;width:60vmax;height:60vmax;border-radius:50%;filter:blur(90px);z-index:-1;opacity:.5;animation:drift 22s ease-in-out infinite alternate}
body::before{background:#6a4bff;left:-20vmax;top:-25vmax}body::after{background:#00c2ff;right:-22vmax;bottom:-25vmax;animation-delay:-8s;opacity:.38}
@keyframes drift{to{transform:translate(8vmax,6vmax) scale(1.15)}}
.top{display:flex;justify-content:space-between;align-items:center;padding:16px 26px}
.brand{display:flex;gap:10px;align-items:center}.brand img{border-radius:12px}.brand b{font-size:18px}.brand small{display:block;color:var(--mut);font-size:11px}
.gear{padding:9px 16px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);backdrop-filter:blur(14px)}
.nav{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:4px;padding:6px;border-radius:22px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);backdrop-filter:blur(22px);z-index:30}
.nav-item{display:flex;gap:8px;align-items:center;padding:11px 18px;border-radius:16px;color:var(--mut);transition:background .3s,color .3s}
.nav-item.active{background:rgba(255,255,255,.2);color:#fff}
.main{max-width:1000px;margin:0 auto;padding:30px 20px 130px}
.eyebrow{color:var(--mut);font-size:13px}
h1{font-size:clamp(34px,6vw,62px);line-height:1.04;margin:10px 0;letter-spacing:-.03em;background:linear-gradient(120deg,#fff,#b8a8ff 60%,#7fe3ff);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--mut);max-width:560px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:30px 0}
.stat,.match{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);backdrop-filter:blur(18px);border-radius:22px;box-shadow:0 12px 40px -18px #0008,inset 0 1px 0 rgba(255,255,255,.18)}
.stat{padding:18px}.k{display:block;color:var(--mut);font-size:12px}.v{font-size:40px;font-weight:700}
.sec{font-size:22px;margin-bottom:14px}
.list{display:grid;gap:12px}
.match{display:grid;grid-template-columns:1fr 1.6fr auto auto;gap:14px;align-items:center;padding:16px 20px;transition:transform .3s,background .3s}
.match:hover{transform:translateY(-3px);background:rgba(255,255,255,.12)}.match.is-value{border-color:rgba(120,255,200,.55)}
.meta{display:grid}.time{color:var(--mut);font-size:12px}.teams{display:flex;gap:8px;font-size:17px;font-weight:600}.teams i{color:var(--mut);font-weight:400;font-size:12px;align-self:center}
.odd{padding:6px 11px;border-radius:12px;background:rgba(255,255,255,.1)}
.edge{padding:6px 12px;border-radius:99px;background:rgba(120,255,200,.2);color:#9dffd6;font-weight:700;font-size:13px}.edge.off{background:rgba(255,255,255,.1);color:var(--mut)}
.bar{display:none}
.modal{background:rgba(8,6,24,.5);backdrop-filter:blur(8px)}.box{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);backdrop-filter:blur(28px);border-radius:26px;padding:24px;color:var(--ink)}
.x{opacity:.7}.save{width:100%;padding:13px;border-radius:16px;background:linear-gradient(120deg,#7b5cff,#3bb8ff);font-weight:700}
.field select{padding:11px;border-radius:12px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff}.field select option{color:#000}.field input{accent-color:#8f7bff}
@media(max-width:700px){.match{grid-template-columns:1fr auto}.teams{grid-column:1/-1}.stats{grid-template-columns:1fr}.nav-item span{display:none}.nav-item.active span{display:inline}}
""")

# 6 ─────────────────────────────────────────────────────────────
d("Swiss Grid", "White, black & one red. Strict grid, big numerals", """
:root{--bg:#fafafa;--ink:#111;--red:#e10600;--mut:#777}
body{background:var(--bg);color:var(--ink);font:15px/1.5 'Helvetica Neue',Helvetica,Arial,sans-serif}
.app{display:grid;grid-template-columns:220px 1fr;min-height:100vh}
.top{grid-column:2;display:flex;justify-content:flex-end;padding:18px 36px;border-bottom:1px solid var(--ink)}
.brand{position:fixed;left:0;top:0;width:220px;padding:24px 24px;border-right:1px solid var(--ink);border-bottom:1px solid var(--ink);background:var(--bg);display:flex;flex-direction:column;gap:12px;z-index:5}
.brand img{width:44px;height:44px;border-radius:0;background:#111;padding:4px}.brand b{font-size:22px;letter-spacing:-.03em}.brand small{display:block;color:var(--mut);font-size:12px}
.gear{font-weight:600;border-bottom:2px solid var(--red)}
.nav{position:fixed;left:0;top:140px;bottom:0;width:220px;border-right:1px solid var(--ink);display:flex;flex-direction:column}
.nav-item{display:flex;gap:10px;padding:16px 24px;text-align:left;border-bottom:1px solid var(--ink);font-weight:600;transition:background .2s,color .2s,padding .25s}
.nav-item i{font-style:normal;color:var(--red)}.nav-item:hover{padding-left:32px}.nav-item.active{background:var(--ink);color:#fff}
.main{grid-column:2;padding:40px 36px 80px}
.eyebrow{color:var(--red);font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:12px}
h1{font-size:clamp(40px,7vw,96px);line-height:.95;letter-spacing:-.05em;font-weight:700;margin:14px 0 18px}
.sub{max-width:520px;color:var(--mut)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);margin:40px 0;border-top:1px solid var(--ink)}
.stat{padding:14px 14px 14px 0;border-right:1px solid var(--ink);padding-left:14px}.stat:first-child{padding-left:0}.stat:last-child{border:0}
.k{display:block;color:var(--mut);font-size:12px}.v{font-size:clamp(38px,5vw,72px);font-weight:700;letter-spacing:-.05em;line-height:1}
.sec{font-size:13px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--ink);padding-bottom:8px}
.match{display:grid;grid-template-columns:160px 1fr auto 130px;gap:16px;align-items:center;padding:16px 0;border-bottom:1px solid #ccc;transition:background .2s,padding .25s}
.match:hover{background:#fff;padding-left:10px}.match.is-value{border-left:6px solid var(--red);padding-left:12px}
.league{font-weight:700;display:block}.time{color:var(--mut);font-size:13px}
.teams{display:flex;gap:10px;font-size:22px;letter-spacing:-.02em}.teams i{color:var(--mut);font-size:13px;align-self:center}
.odd{font-weight:600;padding:0 8px;border:1px solid var(--ink)}
.edge{font-size:22px;font-weight:700;text-align:right;color:var(--red);letter-spacing:-.03em;white-space:nowrap}.edge.off{color:var(--mut)}
.bar{display:none}
.modal{background:rgba(250,250,250,.85)}.box{background:#fff;border:2px solid var(--ink);padding:24px}
.x{font-size:18px}.save{width:100%;padding:13px;background:var(--red);color:#fff;font-weight:700}
.field select{padding:10px;border:1px solid var(--ink);background:#fff;border-radius:0}.field input{accent-color:var(--red)}
@media(max-width:820px){.app{display:block}.brand{position:static;width:auto;flex-direction:row;align-items:center;border:0;border-bottom:1px solid var(--ink)}.top{position:absolute;right:0;top:0;border:0}.nav{position:static;width:auto;flex-direction:row;border-right:0;border-bottom:1px solid var(--ink)}.nav-item{flex:1;border-bottom:0;padding:14px 10px;justify-content:center}.main{padding:26px 18px 70px}.match{grid-template-columns:1fr auto}.teams{grid-column:1/-1}.stats{grid-template-columns:1fr}.stat{border:0;border-bottom:1px solid var(--ink);padding-left:0}}
""")

# 7 ─────────────────────────────────────────────────────────────
d("Stadium Floodlight", "Night match under floodlights that follow your cursor", """
:root{--bg:#070b16;--card:#0e1526;--ink:#eaf0ff;--mut:#8896b8;--l:#ffe9a8;--b:#4da3ff;--mx:50vw;--my:20vh}
body{background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,'Segoe UI',Roboto,sans-serif;position:relative}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(520px circle at var(--mx) var(--my),rgba(255,233,168,.10),transparent 60%),radial-gradient(900px 400px at 15% -5%,rgba(77,163,255,.18),transparent 60%),radial-gradient(900px 400px at 85% -5%,rgba(77,163,255,.18),transparent 60%)}
.app{position:relative;z-index:1}
.top{display:flex;justify-content:space-between;align-items:center;padding:16px 26px}
.brand{display:flex;gap:10px;align-items:center}.brand img{border-radius:10px;box-shadow:0 0 22px rgba(255,233,168,.35)}.brand b{letter-spacing:.06em}.brand small{display:block;color:var(--mut);font-size:11px}
.gear{padding:8px 14px;border-radius:10px;border:1px solid #223055;color:var(--l)}
.nav{display:flex;justify-content:center;gap:8px;padding:6px}
.nav-item{display:flex;gap:8px;padding:10px 20px;border-radius:12px;color:var(--mut);transition:color .25s,background .25s,box-shadow .25s}
.nav-item.active{color:var(--l);background:#131d36;box-shadow:inset 0 -2px 0 var(--l)}
.main{max-width:1000px;margin:0 auto;padding:30px 20px 90px}
.eyebrow{color:var(--l);letter-spacing:.14em;text-transform:uppercase;font-size:12px}
h1{font-size:clamp(34px,6vw,64px);line-height:1.03;letter-spacing:-.03em;margin:12px 0;text-shadow:0 0 40px rgba(255,233,168,.25)}
.sub{color:var(--mut);max-width:560px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:30px 0}
.stat,.match{background:linear-gradient(180deg,#121b33,var(--card));border:1px solid #1d2a4d;border-radius:18px;position:relative;overflow:hidden}
.stat::before,.match::before{content:"";position:absolute;inset:0;background:radial-gradient(260px circle at 50% -40%,rgba(255,233,168,.12),transparent 70%);pointer-events:none}
.stat{padding:18px}.k{display:block;color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.v{font-size:40px;font-weight:700;color:var(--l)}
.sec{font-size:22px;margin-bottom:14px}
.list{display:grid;gap:12px}
.match{display:grid;grid-template-columns:1fr 1.6fr auto auto;gap:14px;align-items:center;padding:16px 20px;transition:transform .3s,border-color .3s,box-shadow .3s}
.match:hover{transform:translateY(-3px);border-color:#3b5aa0}.match.is-value{border-color:var(--l);box-shadow:0 0 34px -10px rgba(255,233,168,.55)}
.meta{display:grid}.time{color:var(--mut);font-size:12px}.teams{display:flex;gap:8px;font-size:17px;font-weight:600}.teams i{color:var(--mut);font-weight:400;font-size:12px;align-self:center}
.odd{padding:6px 11px;border-radius:10px;background:#0a1020;border:1px solid #1d2a4d}
.edge{padding:6px 12px;border-radius:99px;background:rgba(255,233,168,.14);color:var(--l);font-weight:700;font-size:13px}.edge.off{background:#ffffff0c;color:var(--mut)}
.bar{display:none}
.modal{background:rgba(3,6,14,.7)}.box{background:var(--card);border:1px solid #2a3a68;border-radius:20px;padding:22px;box-shadow:0 0 60px -10px rgba(255,233,168,.25)}
.x{color:var(--mut)}.save{width:100%;padding:12px;border-radius:12px;background:var(--l);color:#1a1300;font-weight:700}
.field select{padding:10px;background:#0a1020;border:1px solid #1d2a4d;border-radius:10px;color:var(--ink)}.field input{accent-color:var(--l)}
@media(max-width:700px){.match{grid-template-columns:1fr auto}.teams{grid-column:1/-1}.stats{grid-template-columns:1fr}}
""")

# 8 ─────────────────────────────────────────────────────────────
d("Retro Arcade", "CRT scanlines, neon, stepped pixel borders", """
:root{--bg:#12002b;--c:#00f0ff;--m:#ff2bd6;--y:#ffe600;--ink:#e8e0ff}
body{background:var(--bg);color:var(--ink);font:14px/1.6 ui-monospace,'Courier New',monospace;text-transform:uppercase;letter-spacing:.04em}
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:300;background:repeating-linear-gradient(0deg,rgba(0,0,0,.28) 0 1px,transparent 1px 3px);mix-blend-mode:multiply}
.top{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;border-bottom:4px solid var(--m)}
.brand{display:flex;gap:10px;align-items:center}.brand img{image-rendering:pixelated;border:3px solid var(--c)}.brand b{color:var(--y);font-size:20px;text-shadow:3px 3px 0 var(--m)}.brand small{display:block;color:var(--c);font-size:10px}
.gear{border:3px solid var(--c);color:var(--c);padding:6px 12px;box-shadow:4px 4px 0 var(--m)}
.nav{display:flex;gap:10px;padding:14px 18px;flex-wrap:wrap}
.nav-item{border:3px solid var(--ink);padding:8px 14px;display:flex;gap:8px;transition:none}
.nav-item.active{background:var(--y);color:#000;border-color:var(--y);box-shadow:4px 4px 0 var(--m);animation:blink 1s steps(2) infinite}
@keyframes blink{50%{box-shadow:4px 4px 0 var(--c)}}
.main{max-width:1000px;margin:0 auto;padding:14px 18px 80px}
.eyebrow{color:var(--c)}
h1{font-size:clamp(26px,5.4vw,56px);line-height:1.1;margin:12px 0;color:var(--y);text-shadow:4px 4px 0 var(--m),8px 8px 0 #3a0a6b}
.sub{max-width:560px;color:var(--ink);opacity:.85;text-transform:none}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:26px 0}
.stat{border:4px solid var(--c);padding:12px;box-shadow:6px 6px 0 #3a0a6b;background:#1b0540}
.k{display:block;font-size:11px;color:var(--c)}.v{font-size:clamp(28px,5vw,46px);color:var(--y)}
.sec{font-size:20px;color:var(--m);margin-bottom:12px}.sec::before{content:"► "}
.list{display:grid;gap:14px}
.match{display:grid;grid-template-columns:1fr auto;gap:6px 14px;border:4px solid var(--ink);padding:12px 14px;background:#1b0540;box-shadow:6px 6px 0 #3a0a6b;transition:transform .08s steps(2)}
.match:hover{transform:translate(-3px,-3px)}.match.is-value{border-color:var(--y);box-shadow:6px 6px 0 var(--m)}
.meta{grid-column:1/-1;display:flex;gap:12px;color:var(--c);font-size:12px}
.teams{display:flex;gap:10px;font-size:18px}.teams i{color:var(--m);align-self:center;font-size:12px}
.odd{border:2px solid var(--c);padding:0 6px;color:var(--c)}
.edge{color:#000;background:var(--y);padding:2px 8px;justify-self:end;grid-row:2;grid-column:2;align-self:center}.edge.off{background:#444;color:#aaa}
.bar{grid-column:1/-1;height:10px;border:2px solid var(--c)}.bar u{display:block;height:100%;background:repeating-linear-gradient(90deg,var(--m) 0 8px,transparent 8px 10px)}
.modal{background:rgba(10,0,30,.8)}.box{background:#1b0540;border:4px solid var(--y);box-shadow:8px 8px 0 var(--m);padding:18px}
.x{color:var(--m);font-size:18px}.save{width:100%;padding:10px;background:var(--c);color:#000;border:3px solid #fff;font-weight:700}
.field select{padding:8px;background:#000;border:3px solid var(--c);color:var(--ink);font:inherit}.field input{accent-color:var(--m)}
@media(max-width:700px){.stats{grid-template-columns:1fr}}
""")

# 9 ─────────────────────────────────────────────────────────────
d("Soft Neumorphic", "Calm pastel light, pressable buttons, soft depth", """
:root{--bg:#e6eaf2;--ink:#2b3350;--mut:#7d86a3;--ac:#5b7cfa;--sh1:#c6cbd9;--sh2:#ffffff;--ok:#1fa97a}
body{background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,'Segoe UI',Roboto,sans-serif}
.top{display:flex;justify-content:space-between;align-items:center;padding:20px 28px}
.brand{display:flex;gap:12px;align-items:center}.brand img{border-radius:14px;background:#2b3350;padding:3px;box-shadow:5px 5px 10px var(--sh1),-5px -5px 10px var(--sh2)}.brand b{font-size:18px}.brand small{display:block;color:var(--mut);font-size:11px}
.gear{padding:10px 18px;border-radius:14px;background:var(--bg);box-shadow:6px 6px 12px var(--sh1),-6px -6px 12px var(--sh2);transition:box-shadow .2s}
.gear:active,.nav-item:active{box-shadow:inset 4px 4px 8px var(--sh1),inset -4px -4px 8px var(--sh2)}
.nav{display:flex;width:max-content;max-width:calc(100% - 40px);margin:0 auto;padding:6px;border-radius:20px;box-shadow:inset 6px 6px 12px var(--sh1),inset -6px -6px 12px var(--sh2)}
.nav-item{display:flex;gap:8px;padding:11px 22px;border-radius:15px;color:var(--mut);transition:box-shadow .25s,color .25s,background .25s}
.nav-item.active{color:var(--ac);background:var(--bg);box-shadow:5px 5px 10px var(--sh1),-5px -5px 10px var(--sh2);font-weight:700}
.main{max-width:980px;margin:0 auto;padding:30px 20px 80px}
.eyebrow{color:var(--ac);font-weight:600;font-size:13px}
h1{font-size:clamp(32px,5.4vw,56px);line-height:1.06;letter-spacing:-.03em;margin:10px 0}
.sub{color:var(--mut);max-width:540px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;margin:32px 0}
.stat,.match{background:var(--bg);border-radius:24px;box-shadow:9px 9px 18px var(--sh1),-9px -9px 18px var(--sh2)}
.stat{padding:20px}.k{display:block;color:var(--mut);font-size:12px}.v{font-size:40px;font-weight:700;color:var(--ac)}
.sec{font-size:22px;margin-bottom:18px}
.list{display:grid;gap:20px}
.match{display:grid;grid-template-columns:1fr 1.6fr auto auto;gap:14px;align-items:center;padding:18px 22px;transition:box-shadow .3s}
.match:hover{box-shadow:12px 12px 24px var(--sh1),-12px -12px 24px var(--sh2)}
.meta{display:grid}.time{color:var(--mut);font-size:12px}.teams{display:flex;gap:8px;font-size:17px;font-weight:600}.teams i{color:var(--mut);font-weight:400;font-size:12px;align-self:center}
.odd{padding:7px 12px;border-radius:12px;box-shadow:inset 3px 3px 6px var(--sh1),inset -3px -3px 6px var(--sh2)}
.edge{padding:7px 14px;border-radius:99px;color:var(--ok);font-weight:700;font-size:13px;box-shadow:inset 3px 3px 6px var(--sh1),inset -3px -3px 6px var(--sh2)}.edge.off{color:var(--mut)}
.match.is-value .teams b{color:var(--ac)}.bar{display:none}
.modal{background:rgba(230,234,242,.7);backdrop-filter:blur(6px)}.box{background:var(--bg);border-radius:28px;padding:26px;box-shadow:14px 14px 30px #b8bdcc,-10px -10px 24px #fff}
.x{width:36px;height:36px;border-radius:50%;box-shadow:4px 4px 8px var(--sh1),-4px -4px 8px var(--sh2)}
.save{width:100%;padding:13px;border-radius:16px;background:var(--ac);color:#fff;font-weight:700;box-shadow:6px 6px 12px var(--sh1),-4px -4px 10px var(--sh2)}
.field select{padding:11px;border:0;border-radius:14px;background:var(--bg);box-shadow:inset 4px 4px 8px var(--sh1),inset -4px -4px 8px var(--sh2);color:var(--ink)}.field input{accent-color:var(--ac)}
@media(max-width:700px){.match{grid-template-columns:1fr auto}.teams{grid-column:1/-1}.stats{grid-template-columns:1fr}.nav-item span{display:none}.nav-item.active span{display:inline}}
""")

# 10 ────────────────────────────────────────────────────────────
d("Bento Command Center", "Tile dashboard with a side rail; ideal for phones", """
:root{--bg:#0d0f14;--t:#151922;--t2:#1b2030;--ink:#eef1f8;--mut:#8a93a8;--ac:#ff6b4a;--ok:#3de0a2;--line:#232a3b}
body{background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,'Segoe UI',Roboto,sans-serif}
.app{display:grid;grid-template-columns:86px 1fr;min-height:100vh}
.top{position:fixed;left:0;top:0;bottom:0;width:86px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;padding:18px 0;border-right:1px solid var(--line);background:#0a0c10;z-index:20}
.brand{display:flex;flex-direction:column;align-items:center}.brand img{border-radius:12px}.brand div{display:none}
.gear{width:46px;height:46px;border-radius:14px;background:var(--t);display:grid;place-items:center;transition:background .2s}.gear span{display:none}.gear:hover{background:var(--t2)}
.nav{position:fixed;left:0;top:90px;width:86px;display:flex;flex-direction:column;align-items:center;gap:10px;z-index:21}
.nav-item{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;color:var(--mut);position:relative;transition:background .25s,color .25s,transform .2s}
.nav-item i{font-style:normal;font-size:20px}.nav-item span{position:absolute;left:66px;background:var(--t2);padding:4px 10px;border-radius:8px;font-size:12px;white-space:nowrap;opacity:0;transform:translateX(-6px);pointer-events:none;transition:opacity .2s,transform .2s;color:var(--ink)}
.nav-item:hover span{opacity:1;transform:none}.nav-item.active{background:var(--ac);color:#1a0600}.nav-item:active{transform:scale(.94)}
.main{grid-column:2;padding:26px 26px 60px;max-width:1100px;display:grid;grid-template-columns:repeat(6,1fr);gap:14px;align-content:start}
.hero{grid-column:span 4;background:linear-gradient(135deg,#ff6b4a22,var(--t));border:1px solid var(--line);border-radius:26px;padding:28px}
.eyebrow{color:var(--ac);font-size:12px;letter-spacing:.1em;text-transform:uppercase}
h1{font-size:clamp(28px,4.4vw,52px);line-height:1.04;letter-spacing:-.03em;margin:10px 0}
.sub{color:var(--mut);max-width:480px}
.stats{display:contents}
.stat{background:var(--t);border:1px solid var(--line);border-radius:26px;padding:20px;grid-column:span 2;transition:transform .25s,border-color .25s}
.stat:hover{transform:translateY(-3px);border-color:#34405c}.stat:first-child{grid-column:span 2}.stat:nth-child(2),.stat:nth-child(3){grid-column:span 3}
.k{display:block;color:var(--mut);font-size:12px}.v{font-size:clamp(30px,4vw,46px);font-weight:700;letter-spacing:-.03em}.stat:nth-child(2) .v{color:var(--ok)}
.tabs{grid-column:1/-1}
.sec{font-size:20px;margin:8px 0 12px}
.list{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
.match{display:grid;grid-template-columns:1fr auto;gap:8px 12px;background:var(--t);border:1px solid var(--line);border-radius:26px;padding:20px;transition:transform .25s,border-color .25s}
.match:hover{transform:translateY(-3px);border-color:#34405c}.match.is-value{background:linear-gradient(160deg,#3de0a21c,var(--t));border-color:#3de0a255}
.meta{grid-column:1/-1;display:flex;justify-content:space-between;color:var(--mut);font-size:12px}
.teams{display:flex;gap:8px;font-size:19px;font-weight:700;grid-column:1/-1}.teams i{color:var(--mut);font-weight:400;font-size:12px;align-self:center}
.odd{padding:5px 10px;border-radius:10px;background:var(--t2);font-size:13px}
.edge{font-weight:800;color:var(--ok);font-size:18px;align-self:center}.edge.off{color:var(--mut)}
.bar{grid-column:1/-1;height:6px;border-radius:6px;background:var(--t2)}.bar u{display:block;height:100%;border-radius:6px;background:linear-gradient(90deg,var(--ac),var(--ok))}
.modal{background:rgba(5,6,10,.7)}.box{background:var(--t);border:1px solid var(--line);border-radius:28px;padding:24px}
.x{width:34px;height:34px;border-radius:10px;background:var(--t2)}.save{width:100%;padding:13px;border-radius:16px;background:var(--ac);color:#1a0600;font-weight:800}
.field select{padding:11px;border-radius:12px;background:var(--t2);border:1px solid var(--line);color:var(--ink)}.field input{accent-color:var(--ac)}
@media(max-width:820px){.app{display:block}.top{position:fixed;left:auto;right:12px;top:12px;bottom:auto;width:auto;height:auto;border:0;background:none;padding:0}.brand{display:none}.nav{top:auto;bottom:0;left:0;right:0;width:auto;flex-direction:row;justify-content:space-around;padding:10px 10px calc(10px + env(safe-area-inset-bottom,0px));background:#0a0c10ee;backdrop-filter:blur(14px);border-top:1px solid var(--line)}.nav-item span{display:none}.main{grid-template-columns:repeat(2,1fr);padding:64px 14px 100px}.hero{grid-column:1/-1}.stat,.stat:first-child,.stat:nth-child(2),.stat:nth-child(3){grid-column:span 1}.stat:last-child{grid-column:1/-1}.list{grid-template-columns:1fr}}
""")

# ─── build ───────────────────────────────────────────────────────
PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} · LuciBet design preview</title><style>{base}{css}</style></head>
<body>{body}<a class="legend" href="index.html">← all designs · #{n} {title}</a>
<script>{script}{extra}</script></body></html>"""

import base64
LOGO="data:image/png;base64,"+base64.b64encode(open(os.path.join(OUT,"..","public","logo.png"),"rb").read()).decode()
cards = []
for i, (name, tag, css) in enumerate(DESIGNS, 1):
    fn = "design-%02d.html" % i
    with open(os.path.join(OUT, fn), "w", encoding="utf-8") as f:
        f.write(PAGE.format(title=html.escape(name), base=BASE, css=css, body=BODY.replace("../public/logo.png",LOGO), n=i, script=SCRIPT, extra=EXTRA_JS.get(i, "")))
    cards.append((i, fn, name, tag))

GAL = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LuciBet · 10 design previews</title>
<style>*{box-sizing:border-box;margin:0}body{background:#101114;color:#f2f2f2;font:15px/1.5 system-ui,sans-serif;padding:28px 18px 60px}
h1{font-size:26px;margin-bottom:6px}p.s{color:#9a9aa3;margin-bottom:22px}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;max-width:1300px}
a.c{display:block;text-decoration:none;color:inherit;background:#1a1b20;border:1px solid #2a2c33;border-radius:16px;overflow:hidden;transition:transform .2s,border-color .2s}
a.c:hover{transform:translateY(-3px);border-color:#6d7bff}
.f{height:210px;overflow:hidden;position:relative;background:#000}.f iframe{width:1200px;height:840px;border:0;transform:scale(.25);transform-origin:0 0;pointer-events:none}
.t{padding:12px 14px}.t b{display:block}.t span{color:#9a9aa3;font-size:13px}</style></head><body>
<h1>LuciBet · 10 design previews</h1><p class="s">Click one to open it full-size (try the tabs and the ⚙ Settings modal).</p><div class="g">
%s</div></body></html>"""
items = "".join('<a class="c" href="%s"><div class="f"><iframe src="%s" loading="lazy" tabindex="-1"></iframe></div><div class="t"><b>%d · %s</b><span>%s</span></div></a>' % (fn, fn, i, html.escape(n), html.escape(t)) for i, fn, n, t in cards)
with open(os.path.join(OUT, "index.html"), "w", encoding="utf-8") as f:
    f.write(GAL % items)
print("built", len(cards), "designs")
