"""Summary of a sweep: python3 summarize.py OUTDIR [wrong queries to print]"""
import collections
import glob
import json
import re
import sys

out = sys.argv[1]
show = int(sys.argv[2]) if len(sys.argv) > 2 else 12
rows = [json.loads(line) for f in sorted(glob.glob(f'{out}/out/*.jsonl')) for line in open(f) if line.strip()]
by = collections.defaultdict(collections.Counter)
reasons = collections.Counter()
wrong = []
ms = collections.defaultdict(lambda: [[], []])
for r in rows:
    c = by[r['stratum']]
    c['queries'] += 1
    if r.get('error'):
        c['error'] += 1
        reasons['ERROR ' + r['error'][:100]] += 1
        continue
    if r['route'] == 'keep':
        c['keep'] += 1
        ms[r['stratum']][0].append(r['msKeep'])
        ms[r['stratum']][1].append(r['msSampled'])
    else:
        c['fallback'] += 1
        reasons[re.sub(r'\d+', 'N', r['route'])[:100]] += 1
    if r['unresolved']:
        c['unresolved'] += 1
    if r['keepOnly'] and not r['sampledOnly']:
        c['KEEP-ONLY'] += 1
    if not (r['gfaEqual'] and r['alignmentsEqual']):
        c['WRONG'] += 1
        c['dropped'] += len(r['sampledOnly'])
        wrong.append(r)
cols = ['queries', 'keep', 'fallback', 'WRONG', 'dropped', 'KEEP-ONLY', 'unresolved', 'error']
print('stratum'.ljust(12) + ''.join(k.rjust(11) for k in cols) + '   median ms keep/sampled, keep-route queries')
total = collections.Counter()
for stratum, c in sorted(by.items()):
    total.update(c)
    a, b = sorted(ms[stratum][0]), sorted(ms[stratum][1])
    median = f'{a[len(a) // 2]}/{b[len(b) // 2]}' if a else ''
    print(stratum.ljust(12) + ''.join(str(c[k]).rjust(11) for k in cols) + '   ' + median)
print('total'.ljust(12) + ''.join(str(total[k]).rjust(11) for k in cols))
print()
for reason, n in reasons.most_common(15):
    print(n, reason)
print()
for r in wrong[:show]:
    print(r['stratum'], r['label'], 'ctx', r['context'], r['snarls'], r['set'], '| route', r['route'][:70])
    for piece in r['sampledOnly'][:4]:
        print('    missing', piece)
    for piece in r['keepOnly'][:2]:
        print('    extra  ', piece)
