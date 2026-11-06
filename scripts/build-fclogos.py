#!/usr/bin/env python3
"""Builds public/logos/fc/ (one logo per club) + index.json (normalised name -> file) from a clone of https://github.com/FCLOGO/fclogo.top (MIT).
Usage: python3 scripts/build-fclogos.py <path-to>/fclogo.top
Picks, per club, the newest non-outdated COLOUR logo. SVG is copied when small, bigger ones are rasterised to a 128px PNG (rsvg-convert) so pages stay light."""
import os, sys, re, json, shutil, subprocess, unicodedata, yaml
src = os.path.join(sys.argv[1], 'src', 'data', 'logos'); out = os.path.join(os.path.dirname(__file__), '..', 'public', 'logos', 'fc')
shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
def key(n):
    n = unicodedata.normalize('NFD', str(n).lower()); n = ''.join(c for c in n if not unicodedata.combining(c))
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', '', n.replace('-', ' '))).strip()
def load(p):
    try: return yaml.safe_load(open(p, encoding='utf8')) or []
    except Exception: return []
index, n_clubs, total = {}, 0, 0
for fed in sorted(os.listdir(src)):
    if fed == 'backup': continue
    base = os.path.join(src, fed, 'clubs')
    if not os.path.isdir(base): continue
    for root, dirs, files in os.walk(base):
        if 'logo.yaml' not in files or 'svg' not in dirs: continue
        logos = [l for l in load(os.path.join(root, 'logo.yaml')) if isinstance(l, dict) and l.get('data') == 'logo' and l.get('style') == 'color' and not l.get('isOutdated') and l.get('svgPath')]
        if not logos: continue
        best = max(logos, key=lambda l: (not l.get('isDoubtful'), int(l.get('version') or 0)))   # newest, certain logos first; a 'doubtful' one only if nothing else
        svg = os.path.join(root, best['svgPath'])
        if not os.path.isfile(svg): continue
        folder = re.sub(r'^\d+[_-]', '', os.path.basename(root))
        slug = key(folder).replace(' ', '-') or 'club'
        info = load(os.path.join(root, 'info', 'info.yaml'))
        names = {folder}; fed_nat = None
        for blk in info:
            if isinstance(blk, dict):
                fed_nat = blk.get('nation') or fed_nat
                for i in blk.get('info') or []:
                    for k in ('fullName', 'localName', 'shortName'):
                        if i.get(k): names.add(i[k])
        fn = slug + '.svg'; k = 2
        while os.path.exists(os.path.join(out, fn)) or os.path.exists(os.path.join(out, fn[:-4] + '.png')): fn = '%s-%d.svg' % (slug, k); k += 1
        if os.path.getsize(svg) <= 20_000: shutil.copy(svg, os.path.join(out, fn))
        else:
            fn = fn[:-4] + '.png'
            r = subprocess.run(['rsvg-convert', '-h', '128', '-o', os.path.join(out, fn), svg], capture_output=True)
            png = os.path.join(root, best.get('pngPath') or '')
            if r.returncode != 0:   # broken SVG namespaces: use the club's own PNG, downscaled
                if not os.path.isfile(png): continue
                subprocess.run(['convert', png, '-resize', 'x128', os.path.join(out, fn)], check=True)
        for nm in names:
            kk = key(nm)
            if len(kk) >= 3 and kk not in index: index[kk] = fn
        n_clubs += 1; total += os.path.getsize(os.path.join(out, fn))
json.dump(index, open(os.path.join(out, 'index.json'), 'w'), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
print('clubs', n_clubs, 'names', len(index), 'bytes', total)
