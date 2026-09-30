"""Compares the sampled route's pieces with gbz-truth's.

python3 truth-compare.py OUTDIR truth.tsv

OUTDIR holds the *.pieces.tsv files of a sweep run with TRUTH=1. A piece is
(query, path, start, end). The sampled route keeps a piece in both
orientations when both are canonical, so its pieces are compared as a set.
"""
import collections
import glob
import sys

out, truth_file = sys.argv[1], sys.argv[2]
truth = collections.defaultdict(set)
for line in open(truth_file):
    query, path, start, end = line.rstrip('\n').split('\t')
    truth[query].add((int(path), int(start), int(end)))
sampled = collections.defaultdict(set)
unnamed = collections.Counter()
for f in glob.glob(f'{out}/out/*.pieces.tsv'):
    for line in open(f):
        query, path, start, end = line.rstrip('\n').split('\t')
        if path == '-1':
            unnamed[query] += 1
        else:
            sampled[query].add((int(path), int(start), int(end)))
queries = sorted(set(truth) | set(sampled))
missing = extra = pieces = bad = 0
for query in queries:
    lost = truth[query] - sampled[query]
    added = sampled[query] - truth[query]
    pieces += len(truth[query])
    missing += len(lost)
    extra += len(added)
    if lost or added or unnamed[query]:
        bad += 1
        if bad <= 20:
            print(query, 'missing', sorted(lost)[:5], 'extra', sorted(added)[:5], 'unnamed', unnamed[query])
print(f'{len(queries)} subgraphs, {pieces} pieces in the GBZ; the sampled route misses {missing}, adds {extra}, leaves {sum(unnamed.values())} unnamed; {bad} subgraphs differ')
sys.exit(1 if bad else 0)
