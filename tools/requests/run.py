#!/usr/bin/env python3
"""Runs query.ts once per window, route and prefetch setting, each in a fresh
node process, and appends one JSON line per query to OUT.

Usage: run.py WINDOWS.json OUT.jsonl [WORKERS]

ROUTES (default sampled,keep1,keep8) and PREFETCH (default on,off) narrow the
sweep. TIMEOUT (default 600 s) and HEAP (node's old-space cap, default 8000 MB)
bound each query; /usr/bin/time records its peak RSS. A query that dies leaves
its status (timeout, oom, killed, error), its finished phases and its last
heartbeat. A query already in OUT is skipped, so an interrupted run resumes.
"""
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

here = os.path.dirname(os.path.abspath(__file__))
windows = json.load(open(sys.argv[1]))
out = sys.argv[2]
workers = int(sys.argv[3]) if len(sys.argv) > 3 else 6
routes = os.environ.get('ROUTES', 'sampled,keep1,keep8').split(',')
prefetch = [p == 'on' for p in os.environ.get('PREFETCH', 'on,off').split(',')]
TIMEOUT = int(os.environ.get('TIMEOUT', 600))
HEAP = int(os.environ.get('HEAP', 8000))


def key(q):
    return (q['contig'], q['start'], q['end'], q['route'], q['prefetch'])


done = set()
if os.path.exists(out):
    done = {key(json.loads(line)) for line in open(out) if line.strip()}
queries = [dict(w, route=r, prefetch=p) for w in windows for r in routes for p in prefetch]
queries = [q for q in queries if key(q) not in done]
print(f'{len(queries)} queries, {len(done)} already done', file=sys.stderr)


def last_json(lines, tag):
    found = [json.loads(line[len(tag) + 1:]) for line in lines if line.startswith(tag + ' ')]
    return found


def run(q):
    cmd = ['/usr/bin/time', '-v', 'timeout', '-k', '10', str(TIMEOUT), 'node', '--no-warnings', f'--max-old-space-size={HEAP}', f'{here}/query.ts', json.dumps(q)]
    t0 = time.monotonic()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.monotonic() - t0
    err = proc.stderr.splitlines()
    rss = [int(line.split(':')[1]) for line in err if 'Maximum resident set size' in line]
    extra = dict(maxRssMb=round(rss[0] / 1024) if rss else None, exitCode=proc.returncode, wallS=round(elapsed, 1))
    out = proc.stdout.strip().splitlines()
    if out:
        result = dict(json.loads(out[-1]), **extra)
        result['status'] = 'ok' if result['ok'] and not result.get('keepFallback') else 'fallback' if result['ok'] else 'error'
        return json.dumps(result)
    phases = {p.pop('phase'): p for p in last_json(err, 'PHASE')}
    progress = last_json(err, 'PROGRESS')
    text = '\n'.join(line for line in err if not line.startswith(('PHASE', 'PROGRESS', '\t')))
    status = 'oom' if 'heap out of memory' in text else 'timeout' if elapsed >= TIMEOUT else 'killed' if proc.returncode == 137 else 'error'
    return json.dumps(dict(q, ok=False, status=status, error=text[-500:], phases=phases, lastProgress=progress[-1] if progress else None, **extra))


with ThreadPoolExecutor(workers) as pool, open(out, 'a') as f:
    for i, line in enumerate(pool.map(run, queries)):
        f.write(line + '\n')
        f.flush()
        if (i + 1) % 25 == 0:
            print(f'{i + 1}/{len(queries)}', file=sys.stderr)
