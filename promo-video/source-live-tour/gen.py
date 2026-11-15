# Generates the Higgsedit edit script (edit.jsx) + VO timing for the LuciBet live tour.
import json, re
W, H, END = 1920, 1080, 197.66
M = {"01": 8.85, "02": 26.31, "03": 40.92, "04": 56.35, "05": 84.24, "06": 99.13, "07": 109.81, "08": 134.14, "09": 152.55, "10": 175.53}
OUTRO = 187.65
TITLES = {"01": ("SIGNALS", "Every match today, priced by the model"), "02": ("MATCH MODEL", "Probabilities for every market"),
  "03": ("VALUE BETS", "Only when the price is wrong"), "04": ("MODEL FILTERS", "Tune the engine yourself"),
  "05": ("BOT HISTORY", "Every pick settled, win or lose"), "06": ("DISCOVER", "The community feed"),
  "07": ("LEAGUE TABLES", "Standings, teams and scorers"), "08": ("DEMO ARENA", "Practise with virtual credits"),
  "09": ("SETTINGS", "Your theme, your language"), "10": ("PRO ACCESS", "One plan, everything unlocked")}
SCRIPT = {
 "00": "This is LuciBet, Match Day Edge. Football analytics, live. Let's take a quick tour.",
 "01": "The Signals board covers every match of the day, priced by a Poisson model and live market odds. At the top: today's matches, how many have odds, the value bets found, and the best expected value.",
 "02": "Every match card shows the model's probability for a home win, a draw or an away win, the most likely scoreline, and over-under goals. Pin the matches you follow to keep them on top.",
 "03": "Search any team in seconds. When the model's price beats the bookmakers', the match is flagged as a value bet, with its expected value, a suggested stake, and a confidence level.",
 "04": "Model filters let you tune the engine. Slide the market weight to decide how much to trust the bookmakers versus the model, then set the minimum edge for a value bet. The summary updates live.",
 "05": "Bot History logs every past pick, win or lose. Search any team to see what the bot picked, and how it ended.",
 "06": "Discover is the community feed, where picks and results are shared and discussed.",
 "07": "League tables cover the top competitions. Switch leagues in one tap, and open any team to see its form, results and top scorers.",
 "08": "In the Demo Arena, you start with 2,000 virtual dirhams and predict real matches. No real money, ever.",
 "09": "Make it yours: change the theme, and switch between English, French and Arabic.",
 "10": "Pro unlocks it all: daily value bets, win probabilities, over-under and scorelines, match alerts and live scores. $30, with no automatic renewal.",
 "11": "LuciBet, Match Day Edge. Find the edge. The decision is yours. 18+ only. Please play responsibly."}
VO_AT = {"00": 0.4, "11": OUTRO + 0.4, **{k: v + 0.6 for k, v in M.items()}}
words = json.load(open("words.json"))

def chunks(text, maxw=6):
    toks = text.split(); out, cur = [], []
    for t in toks:
        cur.append(t)
        if len(cur) >= maxw or re.search(r"[.:!?]$", t) or (re.search(r",$", t) and len(cur) >= 4):
            out.append(cur); cur = []
    if cur: out.append(cur)
    return out

caps = []
for k, text in SCRIPT.items():
    ws = words[k]["words"]; nW = len(ws); toks = text.split(); nS = len(toks); i = 0
    for ch in chunks(text):
        j = i + len(ch)
        a = ws[min(nW - 1, round(i * nW / nS))][1]; b = ws[max(0, min(nW - 1, round(j * nW / nS) - 1))][2]
        caps.append([VO_AT[k] + a, VO_AT[k] + max(b, a + 0.6), " ".join(ch)]); i = j
caps.sort()
for n in range(len(caps) - 1):            # no overlaps, small gap
    caps[n][1] = min(caps[n][1] + 0.15, caps[n + 1][0] - 0.04)

def js(s): return json.dumps(s, ensure_ascii=False)
def fade(d, fi=0.25, fo=0.3): return f'[{{property:"opacity",keyframes:[{{at:0,value:0}},{{at:{fi},value:1}},{{at:{round(d-fo,3)},value:1}},{{at:{round(d,3)},value:0}}]}}]'
def zoom(t0, t1, fx, fy, s, inn=0.8):
    d = t1 - t0
    def off(sc): 
        ox = max(W - sc * W, min(0, W / 2 - sc * fx * W)); oy = max(H - sc * H, min(0, H / 2 - sc * fy * H)); return round(ox, 1), round(oy, 1)
    o = off(s)
    kf = lambda prop, v0, v1: f'{{property:"{prop}",keyframes:[{{at:0,value:{v0},easing:"smooth"}},{{at:{inn},value:{v1},easing:"hold"}},{{at:{round(d-inn,3)},value:{v1},easing:"smooth"}},{{at:{round(d,3)},value:{v0}}}]}}'
    return f'p.compose(<media file={{v}} x={{0}} y={{0}} width={{{W}}} height={{{H}}} fit="fill" trimStart={{{t0}}} animate={{[{kf("scale",1,s)},{kf("offsetX",0,o[0])},{kf("offsetY",0,o[1])}]}} />, {{ at: {t0}, dur: {round(d,3)}, trackIndex: 1 }});'

Z = []        # zoom windows (added first, lane 1)
def zoomspec(t0, t1, fx, fy, sc): Z.append((round(t0,3), round(t1,3), fx, fy, sc))
zoomspec(M["02"] + 3.0, M["02"] + 12.5, 0.43, 0.40, 1.25)
zoomspec(M["03"] + 8.0, M["03"] + 13.8, 0.40, 0.36, 1.28)
zoomspec(M["04"] + 3.0, M["04"] + 25.0, 0.62, 0.45, 1.22)
F = 'fontFamily="Inter"'
OV = []       # (start, end, builder(a, d, fin, fout, first) -> list of JSX nodes)
def op(fin, fout, d, a0=0.25, a1=0.3):
    k = []
    k.append(f'{{at:0,value:{0 if fin else 1}}}')
    if fin: k.append(f'{{at:{min(a0, d/3):.3f},value:1}}')
    if fout: k.append(f'{{at:{max(d - a1, d*2/3):.3f},value:1}}'); k.append(f'{{at:{d:.3f},value:0}}')
    else: k.append(f'{{at:{d:.3f},value:1}}')
    return '{property:"opacity",keyframes:[' + ','.join(k) + ']}'
# intro
def intro(a, d, fin, fout, first):
    return [f'<rect x={{0}} y={{0}} width={{{W}}} height={{{H}}} fill="rgba(2,4,10,0.86)" animate={{[{op(False, fout, d, 0.25, 0.6)}]}} />',
      f'<media file={{logo}} x={{880}} y={{230}} width={{160}} height={{160}} fit="contain" animate={{[{{property:"scale",from:0.6,to:1,duration:0.7,easing:"house"}},{op(True, fout, d, 0.4, 0.6)}]}} />',
      f'<text x={{0}} y={{430}} width={{{W}}} {F} fontSize={{28}} fontWeight={{700}} letterSpacing={{12}} color="#5ea2ff" align="center" animate={{[{op(True, fout, d, 0.25, 0.6)}]}}>LUCIBET · MATCH DAY EDGE</text>',
      f'<text x={{0}} y={{485}} width={{{W}}} {F} fontSize={{120}} fontWeight={{900}} letterSpacing={{-3}} color="#ffffff" align="center" motion={{{{by:"word",from:{{opacity:0,y:40}},duration:0.9,at:0.3}}}} animate={{[{op(False, fout, d, 0.25, 0.6)}]}}>Football analytics, live.</text>',
      f'<text x={{0}} y={{650}} width={{{W}}} {F} fontSize={{40}} fontWeight={{600}} color="#c3c8da" align="center" animate={{[{op(True, fout, d, 0.9, 0.6)}]}}>A tour of the real site, click by click.</text>']
OV.append((0.0, 4.4, intro))
keys = list(M)
for n, k in enumerate(keys):
    t, (title, tag) = M[k], TITLES[k]; nxt = M[keys[n + 1]] if n + 1 < len(keys) else OUTRO; bd = 1.9
    def band(a, d, fin, fout, first, k=k, title=title, tag=tag):
        return [f'<rect x={{0}} y={{405}} width={{{W}}} height={{270}} fill="rgba(4,7,16,0.86)" animate={{[{op(fin, fout, d, 0.2)}]}} />',
          f'<rect x={{760}} y={{438}} width={{110}} height={{70}} radius={{16}} fill="#1f6fff" animate={{[{{property:"scaleX",from:0,to:1,duration:0.35,easing:"house"}},{op(False, fout, d)}]}} />',
          f'<text x={{760}} y={{447}} width={{110}} {F} fontSize={{44}} fontWeight={{900}} color="#ffffff" align="center" animate={{[{op(fin, fout, d, 0.2)}]}}>{k}</text>',
          f'<text x={{890}} y={{440}} width={{900}} {F} fontSize={{60}} fontWeight={{900}} letterSpacing={{4}} color="#ffffff" motion={{{{by:"character",from:{{opacity:0,x:-20}},duration:0.5,at:0.1}}}} animate={{[{op(False, fout, d)}]}}>{title}</text>',
          f'<text x={{0}} y={{560}} width={{{W}}} {F} fontSize={{48}} fontWeight={{700}} color="#7fb4ff" align="center" motion={{{{by:"word",from:{{opacity:0,y:20}},duration:0.6,at:0.35}}}} animate={{[{op(False, fout, d)}]}}>{tag}</text>']
    OV.append((t, t + bd, band))
    cw = 120 + len(title) * 26
    def label(a, d, fin, fout, first, k=k, title=title, cw=cw):
        sl = '{property:"offsetX",from:-60,to:0,duration:0.4,easing:"house"},' if first else ''
        return [f'<rect x={{36}} y={{118}} width={{{cw}}} height={{58}} radius={{14}} fill="rgba(6,9,20,0.88)" strokeColor="rgba(94,162,255,0.55)" strokeWidth={{2}} animate={{[{sl}{op(fin, fout, d, 0.3, 0.3)}]}} />',
          f'<text x={{56}} y={{128}} width={{{cw}}} {F} fontSize={{30}} fontWeight={{900}} color="#5ea2ff" animate={{[{sl}{op(fin, fout, d, 0.3, 0.3)}]}}>{k}  {title}</text>']
    OV.append((t + bd, nxt - 0.15, label))
for a0, b0, txt in caps:
    if a0 >= OUTRO: continue
    b0 = min(b0, OUTRO - 0.05); w = min(1800, int(len(txt) * 25.5 + 90)); x = (W - w) // 2
    safe = js(txt)[1:-1].replace('{', '(').replace('}', ')')
    def sub(a, d, fin, fout, first, x=x, w=w, safe=safe):
        return [f'<rect x={{{x}}} y={{972}} width={{{w}}} height={{80}} radius={{18}} fill="rgba(8,10,18,0.9)" animate={{[{op(fin, fout, d, 0.12, 0.12)}]}} />',
          f'<text x={{0}} y={{984}} width={{{W}}} {F} fontSize={{46}} fontWeight={{700}} color="#ffffff" align="center" animate={{[{op(fin, fout, d, 0.12, 0.12)}]}}>{safe}</text>']
    OV.append((a0, b0, sub))
def outro(a, d, fin, fout, first):
    return [f'<rect x={{0}} y={{0}} width={{{W}}} height={{{H}}} fill="#02040a" animate={{[{{property:"opacity",from:0,to:1,duration:0.5}}]}} />',
      f'<media file={{logo}} x={{620}} y={{300}} width={{150}} height={{150}} fit="contain" animate={{[{{property:"scale",from:0.7,to:1,duration:0.8,at:0.3,easing:"house"}},{{property:"opacity",keyframes:[{{at:0,value:0}},{{at:0.6,value:1}}]}}]}} />',
      f'<text x={{800}} y={{300}} width={{700}} {F} fontSize={{130}} fontWeight={{900}} letterSpacing={{-4}} color="#ffffff" motion={{{{by:"character",from:{{opacity:0,y:30}},duration:0.7,at:0.4}}}}>LuciBet</text>',
      f'<text x={{0}} y={{490}} width={{{W}}} {F} fontSize={{30}} fontWeight={{700}} letterSpacing={{16}} color="#5ea2ff" align="center" animate={{[{{property:"opacity",keyframes:[{{at:0,value:0}},{{at:1.0,value:0}},{{at:1.5,value:1}}]}}]}}>MATCH DAY EDGE</text>',
      f'<text x={{0}} y={{590}} width={{{W}}} {F} fontSize={{64}} fontWeight={{900}} color="#ffffff" align="center" motion={{{{by:"word",from:{{opacity:0,y:24}},duration:0.6,at:1.6}}}}>Find the edge.</text>',
      f'<text x={{0}} y={{675}} width={{{W}}} {F} fontSize={{64}} fontWeight={{900}} color="#2fce8f" align="center" motion={{{{by:"word",from:{{opacity:0,y:24}},duration:0.8,at:2.4}}}}>The decision is yours.</text>',
      f'<text x={{0}} y={{800}} width={{{W}}} {F} fontSize={{38}} fontWeight={{700}} color="#ffffff" align="center" animate={{[{{property:"opacity",keyframes:[{{at:0,value:0}},{{at:3.4,value:0}},{{at:3.9,value:1}}]}}]}}>1uciferxyz.com</text>',
      f'<text x={{0}} y={{1000}} width={{{W}}} {F} fontSize={{24}} fontWeight={{600}} color="#8a8fa3" align="center" animate={{[{{property:"opacity",keyframes:[{{at:0,value:0}},{{at:3.8,value:0}},{{at:4.3,value:1}}]}}]}}>18+ · Statistical estimates, not guarantees. Play responsibly.</text>']
OV.append((OUTRO, END, outro))

L = []
items = [(t0, 0, zoom(t0, t1, fx, fy, sc)) for (t0, t1, fx, fy, sc) in Z]
cutpts = sorted(z[0] for z in Z)
pieces = []
for (a, b, fn) in OV:
    pts = [a] + [c for c in cutpts if a + 0.05 < c < b - 0.05] + [b]
    for i in range(len(pts) - 1):
        pieces.append((pts[i], pts[i + 1], fn, i == 0, i == len(pts) - 2))
# all compose calls go in strict start order (zoom first on ties): the lane planner only looks at the start instant
for (a, b, fn, first, last) in pieces:
    d = round(b - a, 3)
    nodes = fn(a, d, first, last, first)
    items.append((round(a, 3), 1, 'p.compose([\n    ' + ',\n    '.join(nodes) + f'\n  ], {{ at: {round(a,3)}, dur: {d} }});'))
items.sort(key=lambda x: (x[0], x[1])); L = [x[2] for x in items]
edit = f'''export default async ({{ project }}) => {{
  const p = await project({{ dir: "/home/user/lb/proj", size: "{W}x{H}", fps: 30, background: "#000" }});
  const v = await p.add("/home/user/lb/in/tour_raw.mp4");
  const logo = await p.add("/home/user/lb/in/logo.png");
  p.cut(v, {{ from: 0, dur: {END} }});
''' + "\n".join("  " + x for x in L) + '''
};
'''
open("edit.jsx", "w").write(edit)
json.dump({"vo_at": VO_AT, "caps": caps}, open("timing.json", "w"), indent=1)
print("compose blocks:", len(L), "captions:", len(caps))
for c in caps[:6]: print(round(c[0],2), round(c[1],2), c[2])
