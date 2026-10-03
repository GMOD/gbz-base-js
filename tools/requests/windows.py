#!/usr/bin/env python3
"""Writes the window set for run.py as JSON on stdout.

Usage: windows.py [PER_CHR6] [PER_OTHER] [SEED]
       windows.py large [SEED]
"""
import json
import random
import sys

SIZES = [300, 1_000, 3_000, 10_000, 30_000, 100_000]

# GRCh38 lengths, and the centromere and heterochromatin spans a random window
# skips, since the reference path there is a run of N nodes
CONTIGS = {
    'chr6': (170_805_979, [(58_500_000, 62_600_000)]),
    'chr1': (248_956_422, [(121_700_000, 143_200_000)]),
    'chr17': (83_257_441, [(22_700_000, 26_900_000)]),
}

# Centers of segmental duplications and copy-number loci the team's sweeps used
SEGDUPS = [
    ('AMY1', 'chr1', 103_735_000),
    ('LPA KIV-2', 'chr6', 160_631_000),
    ('SMN1/SMN2', 'chr5', 70_939_000),
    ('C4A/C4B', 'chr6', 32_000_000),
]

# Unplaced and unlocalized contigs, each over 160 kb
UNPLACED = ['chr1_KI270706v1_random', 'chrUn_GL000220v1', 'chr14_GL000225v1_random']


def random_start(rng, contig, size):
    length, gaps = CONTIGS[contig]
    while True:
        start = rng.randrange(1_000_000, length - 1_000_000 - size)
        if all(start + size <= a or start >= b for a, b in gaps):
            return start


# Windows past the browser's usual reach, on chr6: (size, count), then the whole
# chromosome once
LARGE = [(300_000, 3), (1_000_000, 3), (3_000_000, 2), (10_000_000, 1)]


def large(rng):
    windows = []
    for size, n in LARGE:
        for i in range(n):
            start = random_start(rng, 'chr6', size)
            windows.append(dict(stratum='large', label=f'chr6-{i}', contig='GRCh38#0#chr6', start=start, end=start + size, size=size))
    length = CONTIGS['chr6'][0]
    windows.append(dict(stratum='large', label='chr6-whole', contig='GRCh38#0#chr6', start=0, end=length, size=length))
    return windows


def main():
    if sys.argv[1:2] == ['large']:
        json.dump(large(random.Random(int(sys.argv[2]) if len(sys.argv) > 2 else 1)), sys.stdout, indent=1)
        print()
        return
    per_chr6 = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    per_other = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    rng = random.Random(int(sys.argv[3]) if len(sys.argv) > 3 else 1)
    windows = []
    for size in SIZES:
        for contig, n in [('chr6', per_chr6), ('chr1', per_other), ('chr17', per_other)]:
            for i in range(n):
                start = random_start(rng, contig, size)
                windows.append(dict(stratum=f'random-{contig}', label=f'{contig}-{i}', contig=f'GRCh38#0#{contig}', start=start, end=start + size, size=size))
        for label, contig, center in SEGDUPS:
            start = center - size // 2
            windows.append(dict(stratum='segdup', label=label, contig=f'GRCh38#0#{contig}', start=start, end=start + size, size=size))
        for contig in UNPLACED:
            windows.append(dict(stratum='unplaced', label=contig, contig=f'GRCh38#0#{contig}', start=20_000, end=20_000 + size, size=size))
    json.dump(windows, sys.stdout, indent=1)
    print()


main()
