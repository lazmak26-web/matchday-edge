import json, os, sys
d = os.path.dirname(os.path.abspath(__file__)); idx = json.load(open(os.path.join(d, 'index.json')))
with open(os.path.join(d, 'list.txt'), 'w') as f:
    for i, (fn, ts) in enumerate(idx):
        dur = (idx[i + 1][1] - ts) if i + 1 < len(idx) else 0.1
        f.write(f"file 'frames/{fn}'\nduration {max(dur, 0.001):.4f}\n")
    f.write(f"file 'frames/{idx[-1][0]}'\n")
print('total', round(idx[-1][1] - idx[0][1], 2), 's', len(idx), 'frames')
