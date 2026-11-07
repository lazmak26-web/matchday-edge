#!/usr/bin/env python3
"""Second logo layer (after FCLOGO): club logos from https://github.com/JoseArroyave/football-logos (MIT)
rendered to 96px WebP, plus country flags from https://github.com/lipis/flag-icons (MIT) for national teams.
Writes public/logos/x/ (club webp) + index.json and public/logos/flags/ + index.json (country name -> iso2).
Usage: python3 scripts/build-logos-extra.py <jose-football-logos> <flag-icons>"""
import os, sys, re, json, shutil, subprocess, unicodedata
from multiprocessing import Pool
jose, flagrepo = sys.argv[1], sys.argv[2]
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'logos')
X, F = os.path.join(root, 'x'), os.path.join(root, 'flags')
def key(n):
    n = unicodedata.normalize('NFD', str(n).lower().replace('_', ' ')); n = ''.join(c for c in n if not unicodedata.combining(c))
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9 ]', '', n.replace('-', ' '))).strip()
def conv(a):
    src, dst = a
    r = subprocess.run(['rsvg-convert', '-h', '96', '-f', 'png', src], capture_output=True)
    if r.returncode != 0 or not r.stdout: return None
    w = subprocess.run(['convert', 'png:-', '-define', 'webp:method=6', '-quality', '82', dst], input=r.stdout, capture_output=True)
    return dst if w.returncode == 0 and os.path.isfile(dst) else None
if __name__ == '__main__':
    shutil.rmtree(X, ignore_errors=True); os.makedirs(X)
    jobs, idx = [], {}
    base = os.path.join(jose, 'logos')
    for country in sorted(os.listdir(base)):
        cd = os.path.join(base, country)
        if not os.path.isdir(cd): continue
        for f in sorted(os.listdir(cd)):
            if not f.lower().endswith('.svg'): continue
            nm = f[:-4]; slug = key(nm).replace(' ', '-') or 'club'
            out = '%s.webp' % slug
            if os.path.exists(os.path.join(X, out)) or any(j[1].endswith('/' + out) for j in jobs): out = '%s-%s.webp' % (slug, country)
            jobs.append((os.path.join(cd, f), os.path.join(X, out)))
            k = key(nm)
            if len(k) >= 3 and k not in idx: idx[k] = out
    with Pool(2) as p: done = set(p.map(conv, jobs, chunksize=40))
    idx = {k: v for k, v in idx.items() if os.path.join(X, v) in done}
    json.dump(idx, open(os.path.join(X, 'index.json'), 'w'), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    print('club logos', len([d for d in done if d]), 'names', len(idx), 'bytes', sum(os.path.getsize(d) for d in done if d))
    # flags
    shutil.rmtree(F, ignore_errors=True); os.makedirs(F)
    names = {}
    for c in json.load(open(os.path.join(flagrepo, 'country.json'))):
        code = c.get('code'); svg = os.path.join(flagrepo, 'flags', '4x3', '%s.svg' % code)
        if code and os.path.isfile(svg):   # includes gb-eng / gb-sct / gb-wls / gb-nir
            shutil.copy(svg, os.path.join(F, code + '.svg')); names[key(c.get('name', ''))] = code
    for alias, code in {'usa': 'us', 'united states of america': 'us', 'south korea': 'kr', 'korea republic': 'kr', 'north korea': 'kp', 'ivory coast': 'ci', 'cote d ivoire': 'ci',
                        'czech republic': 'cz', 'czechia': 'cz', 'turkey': 'tr', 'turkiye': 'tr', 'iran': 'ir', 'dr congo': 'cd', 'congo dr': 'cd', 'cape verde': 'cv', 'cabo verde': 'cv',
                        'north macedonia': 'mk', 'bosnia herzegovina': 'ba', 'bosnia and herzegovina': 'ba', 'curacao': 'cw', 'england': 'gb-eng', 'scotland': 'gb-sct', 'wales': 'gb-wls',
                        'northern ireland': 'gb-nir', 'russia': 'ru', 'china pr': 'cn', 'uae': 'ae', 'hong kong': 'hk', 'chinese taipei': 'tw', 'taiwan': 'tw'}.items():
        if os.path.isfile(os.path.join(F, code + '.svg')): names.setdefault(alias, code)
    json.dump(names, open(os.path.join(F, 'index.json'), 'w'), separators=(',', ':'), sort_keys=True)
    print('flags', len(os.listdir(F)) - 1, 'names', len(names))
