"""Windows aimed at what the keep route's stray rows have to get right.

python3 windows-targeted.py GRAPH.gbz.db INDEX.haplotype-index.db JUMPS.tsv OUT.json [SEED]

JUMPS.tsv comes from the `jumps` tool. Strata:
  stray       inside the bin of a random stray row, keeping that row's haplotype
  snarl       over the bin of a row for a path that lies inside one snarl
  jump        beside either end of an edge that joins two distant reference nodes
  binedge     on or beside a bin boundary
  anchoredge  on or beside an anchor
  large       150 kb to 500 kb
"""
import collections
import json
import math
import random
import sqlite3
import sys

graph_file, index_file, jumps_file, out_file = sys.argv[1:5]
rng = random.Random(int(sys.argv[5]) if len(sys.argv) > 5 else 20260930)
COMBOS = [[100, 'none'], [1000, 'contained'], [0, 'contained'], [1000, 'none']]
EIGHT = ['HG00097#1', 'HG00099#1', 'HG00128#1', 'HG00133#1', 'HG01109#1', 'HG01123#1', 'HG01960#1', 'HG02055#1']

g = sqlite3.connect(graph_file)
ix = sqlite3.connect(index_file)
tag = dict(ix.execute("select key, value from Tags"))
BIN = int(tag['haplotype_index_stray_bin'])
paths = {h: (s, c, hp, f) for h, s, c, hp, f in g.execute('select handle, sample, contig, haplotype, fragment from Paths')}
lengths = dict(ix.execute('select path_handle, length from HaplotypeLengths'))
haplotypes = sorted({f'{s}#{hp}' for s, c, hp, f in paths.values() if s not in ('GRCh38', 'CHM13')})
samples = sorted({h.split('#')[0] for h in haplotypes})
anchored = sorted({h for (h,) in ix.execute('select distinct path_handle from HaplotypeAnchors')})
grch38 = [h for h in anchored if paths[h][0] == 'GRCh38' and lengths[h] > 1_000_000]


def size(lo, hi):
    return int(math.exp(rng.uniform(math.log(lo), math.log(hi))))


def keep_sets(path=None):
    if path is None:
        hap = rng.choice(haplotypes)
        sample = rng.choice(samples)
    else:
        s, c, hp, f = paths[path]
        hap, sample = f'{s}#{hp}', s
    return [[f'hap {hap}', [hap]], [f'sample {sample}', [sample]], ['eight', EIGHT]]


def row(stratum, label, reference, start, end, path=None):
    s, c, hp, f = paths[reference]
    start = max(0, min(start, lengths[reference] - 2))
    end = max(start + 1, min(end, lengths[reference]))
    return dict(stratum=stratum, label=f'{stratum} {label}', sample=s, contig=c, start=f + start, end=f + end, combos=COMBOS, keepSets=keep_sets(path))


rows = []

strays = ix.execute('select reference_handle, bin, path_handle, path_start from HaplotypeStrays where snarl_high = 0 order by random() limit 4000').fetchall()
rng.shuffle(strays)
picked = collections.Counter()
for reference, b, path, path_start in strays:
    sample = paths[reference][0]
    if picked[sample] >= (400 if sample == 'GRCh38' else 100) or paths[path][0] in ('GRCh38', 'CHM13'):
        continue
    picked[sample] += 1
    w = size(300, 8000)
    start = b * BIN + rng.randint(0, max(0, BIN - w))
    rows.append(row('stray', f'{paths[reference][1]}:{start} path {path}@{path_start}', reference, start, start + w, path))

snarls = ix.execute('select reference_handle, bin, path_handle from HaplotypeStrays where snarl_high > 0 order by random() limit 2000').fetchall()
rng.shuffle(snarls)
n = 0
for reference, b, path in snarls:
    if n >= 200 or paths[path][0] in ('GRCh38', 'CHM13'):
        continue
    n += 1
    pad = rng.choice([0, 2000, 16384])
    rows.append(row('snarl', f'{paths[reference][1]} bin {b} path {path}', reference, b * BIN - pad, (b + 1) * BIN + pad, path))

by_name = {(s, c, f): h for h, (s, c, hp, f) in paths.items()}
jumps = []
for line in open(jumps_file):
    contig, fragment, a, b = line.rstrip('\n').split('\t')
    h = by_name.get(('GRCh38', contig, int(fragment)))
    if h is not None:
        jumps.append((h, int(a), int(b)))
for h, a, b in rng.sample(jumps, min(300, len(jumps))):
    w = size(300, 5000)
    side = rng.choice(['before', 'after', 'across'])
    start = a - w if side == 'before' else b if side == 'after' else a - w // 2
    rows.append(row('jump', f'{paths[h][1]}:{a}->{b} {side}', h, start, start + w))

for _ in range(150):
    h = rng.choice(grch38)
    k = rng.randint(1, lengths[h] // BIN - 1)
    w = size(50, 3000)
    shift = rng.choice([0, -w, -rng.randint(0, w), -1, 1])
    start = k * BIN + shift
    rows.append(row('binedge', f'{paths[h][1]} bin {k} shift {shift}', h, start, start + w))

anchors = ix.execute('select path_handle, anchor_offset, path_offset from HaplotypeAnchors').fetchall()
anchors = [a for a in anchors if a[0] in set(grch38)]
for h, multiple, at in rng.sample(anchors, 150):
    w = size(50, 3000)
    shift = rng.choice([0, -w, -rng.randint(0, w), rng.randint(0, 40000), -rng.randint(0, 40000)])
    rows.append(row('anchoredge', f'{paths[h][1]} anchor {at} shift {shift}', h, at + shift, at + shift + w))

for _ in range(30):
    h = rng.choice(grch38)
    w = size(150_000, 500_000)
    start = rng.randint(0, lengths[h] - w)
    r = row('large', f'{paths[h][1]}:{start}', h, start, start + w)
    r['combos'] = [[100, 'none'], [1000, 'contained']]
    rows.append(r)

json.dump(rows, open(out_file, 'w'))
print(collections.Counter(r['stratum'] for r in rows), len(rows), 'rows;', len(jumps), 'jump edges')
