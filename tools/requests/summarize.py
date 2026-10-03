#!/usr/bin/env python3
"""Flattens run.py's JSON lines to CSV and prints median tables in Markdown.

Usage: summarize.py RESULTS.jsonl OUT.csv [LARGE.jsonl LARGE.csv]
"""
import csv
import json
import sys
from statistics import median

PHASES = ['open', 'paths', 'extract', 'identify', 'gfa']
SIZES = [300, 1_000, 3_000, 10_000, 30_000, 100_000]
ROUTES = ['sampled', 'keep1', 'keep8']
RANDOM = ('random-chr6', 'random-chr1', 'random-chr17')

def status(r):
    return r.get('status') or ('error' if not r['ok'] else 'fallback' if r.get('keepFallback') else 'ok')


def flatten(rows):
  flat = []
  for r in rows:
    f = {k: r.get(k) for k in ['stratum', 'label', 'contig', 'start', 'end', 'size', 'route', 'prefetch', 'context', 'snarls', 'limit', 'blockSize', 'ok', 'error', 'fragments', 'nodes', 'paths', 'gfaBytes', 'graphRequests', 'graphBytes', 'indexRequests', 'indexBytes', 'pagerGraphFetches', 'pagerIndexFetches', 'companionSeeks', 'graphLookups', 'keepFallback', 'keepPieces', 'totalMs', 'maxRssMb', 'wallS']}
    f['status'] = status(r)
    f['prefetch'] = 'on' if r['prefetch'] else 'off'
    for p in PHASES:
        ph = (r.get('phases') or {}).get(p, {})
        for k in ['ms', 'graphRequests', 'graphBytes', 'indexRequests', 'indexBytes']:
            f[f'{p}_{k}'] = ph.get(k)
    keep_ms = r.get('keepMs') or {}
    for k in ['scan', 'walks', 'check', 'twins']:
        f[f'keep_{k}_ms'] = round(keep_ms[k]) if k in keep_ms else None
    progress = r.get('lastProgress') or {}
    for k in ['graphRequests', 'graphBytes', 'indexRequests', 'indexBytes']:
        if f[k] is None and k in progress:
            f[k] = progress[k]
    if f['totalMs'] is None and r.get('wallS') is not None:
        f['totalMs'] = round(r['wallS'] * 1000)
    flat.append(f)
  return flat


def write_csv(flat, path):
    with open(path, 'w', newline='') as out:
        w = csv.DictWriter(out, fieldnames=list(flat[0]))
        w.writeheader()
        w.writerows(flat)


flat = flatten(json.loads(line) for line in open(sys.argv[1]) if line.strip())
write_csv(flat, sys.argv[2])

ok = [f for f in flat if f['ok']]
failed = [f for f in flat if not f['ok']]
print(f'{len(flat)} queries, {len(failed)} failed')
for f in failed:
    print(f"  FAILED {f['stratum']} {f['contig']}:{f['start']}-{f['end']} {f['route']} prefetch {f['prefetch']}: {(f['error'] or '')[:160]}")


def mb(b):
    return f'{b / 1e6:.2f}'


def med(sel, key):
    return median(f[key] for f in sel)


def window_only(f, kind):
    return sum(f[f'{p}_{kind}'] or 0 for p in ['extract', 'identify', 'gfa'])


for f in ok:
    for kind in ['graphRequests', 'indexRequests', 'graphBytes', 'indexBytes']:
        f[f'win_{kind}'] = window_only(f, kind)
    f['requests'] = f['graphRequests'] + f['indexRequests']
    f['bytes'] = f['graphBytes'] + f['indexBytes']
    f['win_requests'] = f['win_graphRequests'] + f['win_indexRequests']
    f['win_bytes'] = f['win_graphBytes'] + f['win_indexBytes']


def table(strata, prefetch, title):
    print(f'\n### {title}\n')
    print('| route | window | n | requests (graph + index) | MB (graph + index) | window-only requests | window-only MB | nodes | ms |')
    print('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for route in ROUTES:
        for size in SIZES:
            sel = [f for f in ok if f['route'] == route and f['size'] == size and f['prefetch'] == prefetch and f['stratum'] in strata]
            if not sel:
                continue
            print(f"| {route} | {size:,} | {len(sel)} | {med(sel, 'requests'):g} ({med(sel, 'graphRequests'):g} + {med(sel, 'indexRequests'):g}) | {mb(med(sel, 'bytes'))} ({mb(med(sel, 'graphBytes'))} + {mb(med(sel, 'indexBytes'))}) | {med(sel, 'win_requests'):g} ({med(sel, 'win_graphRequests'):g} + {med(sel, 'win_indexRequests'):g}) | {mb(med(sel, 'win_bytes'))} | {med(sel, 'nodes'):,.0f} | {med(sel, 'totalMs'):,.0f} |")


def phase_table(strata, prefetch):
    print(f'\n### Median requests and ms per phase, prefetch {prefetch}\n')
    print('| route | window | ' + ' | '.join(PHASES) + ' |')
    print('| --- | ---: |' + ' ---: |' * len(PHASES))
    for route in ROUTES:
        for size in SIZES:
            sel = [f for f in ok if f['route'] == route and f['size'] == size and f['prefetch'] == prefetch and f['stratum'] in strata]
            if not sel:
                continue
            cells = []
            for p in PHASES:
                g = median(f[f'{p}_graphRequests'] for f in sel)
                i = median(f[f'{p}_indexRequests'] for f in sel)
                ms = median(f[f'{p}_ms'] for f in sel)
                cells.append(f'{g:g}+{i:g} / {ms:,.0f} ms')
            print(f"| {route} | {size:,} | " + ' | '.join(cells) + ' |')


for prefetch in ['on', 'off']:
    table(RANDOM, prefetch, f'Random windows (chr6, chr1, chr17), prefetch {prefetch}')
phase_table(RANDOM, 'on')
for stratum in ['segdup', 'unplaced']:
    table((stratum,), 'on', f'{stratum} windows, prefetch on')

print('\n### Prefetch on against off, random windows, median of per-window ratios\n')
print('| route | window | requests on | requests off | off / on | ms on | ms off |')
print('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
by_key = {(f['contig'], f['start'], f['end'], f['route'], f['prefetch']): f for f in ok}
for route in ROUTES:
    for size in SIZES:
        pairs = [(f, by_key.get((f['contig'], f['start'], f['end'], route, 'off'))) for f in ok if f['route'] == route and f['size'] == size and f['prefetch'] == 'on' and f['stratum'] in RANDOM]
        pairs = [(a, b) for a, b in pairs if b]
        if not pairs:
            continue
        print(f"| {route} | {size:,} | {median(a['requests'] for a, _ in pairs):g} | {median(b['requests'] for _, b in pairs):g} | {median(b['requests'] / a['requests'] for a, b in pairs):.2f} | {median(a['totalMs'] for a, _ in pairs):,.0f} | {median(b['totalMs'] for _, b in pairs):,.0f} |")

fallbacks = [f for f in ok if f['route'] != 'sampled' and f['keepFallback']]
print(f'\n{len(fallbacks)} keep queries fell back to identifying every walk')
for f in fallbacks[:20]:
    print(f"  {f['stratum']} {f['contig']}:{f['start']}-{f['end']} {f['route']}: {f['keepFallback']}")

if len(sys.argv) > 4:
    large = flatten(json.loads(line) for line in open(sys.argv[3]) if line.strip())
    write_csv(large, sys.argv[4])
    print('\n### Large windows on chr6, prefetch on, no node limit\n')
    print('| window | route | status | requests (graph + index) | MB (graph + index) | nodes | paths | ms (open / paths / extract / identify / gfa) | total s | peak RSS MB |')
    print('| ---: | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |')
    for f in sorted(large, key=lambda f: (f['size'], f['route'] != 'sampled', f['start'])):
        req = f"{(f['graphRequests'] or 0) + (f['indexRequests'] or 0)} ({f['graphRequests']} + {f['indexRequests']})" if f['graphRequests'] is not None else '-'
        byt = f"{mb((f['graphBytes'] or 0) + (f['indexBytes'] or 0))} ({mb(f['graphBytes'] or 0)} + {mb(f['indexBytes'] or 0)})" if f['graphBytes'] is not None else '-'
        phase_ms = ' / '.join('-' if f[f'{p}_ms'] is None else f"{f[f'{p}_ms']:,}" for p in PHASES)
        note = f['status'] if f['status'] in ('ok',) else f"{f['status']}: {(f['keepFallback'] or f['error'] or '').splitlines()[0][:80] if (f['keepFallback'] or f['error']) else ''}"
        print(f"| {f['size']:,} | {f['route']} | {note} | {req} | {byt} | {f['nodes'] if f['nodes'] is not None else '-'} | {f['paths'] if f['paths'] is not None else '-'} | {phase_ms} | {(f['totalMs'] or 0) / 1000:.1f} | {f['maxRssMb']} |")
