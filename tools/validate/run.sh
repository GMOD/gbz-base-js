#!/bin/bash
# Splits a rows file into configs and runs sweep.ts over them in parallel.
# Usage: run.sh OUTDIR ROWS.json [all]
#   "all" replaces each row's keep sets with every haplotype and lifts the cap
#   on chosen paths, so every omission shows.
# Environment:
#   GRAPH, INDEX   the graph database and the haplotype index (required)
#   GBZ_SRC        the library's src/ (default: this checkout's)
#   WORKERS        processes (default 8)
#   PER            rows per process (default 5, or 1 with "all")
#   CONTIG, STRATA keep only rows of this contig, or of these comma-separated strata
#   TRUTH=1        also write each subgraph's nodes and the sampled route's
#                  pieces, for gbz-truth and truth-compare.py
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=$1
rows=$2
mode=${3:-}
mkdir -p "$out/cfg" "$out/out"
OUT="$out" ROWS="$rows" MODE="$mode" python3 - <<'PY'
import json, os
out, mode = os.environ['OUT'], os.environ['MODE']
rows = json.load(open(os.environ['ROWS']))
contig = os.environ.get('CONTIG')
if contig:
    rows = [r for r in rows if r['contig'] == contig]
strata = os.environ.get('STRATA')
if strata:
    rows = [r for r in rows if r['stratum'] in strata.split(',')]
unlimited = mode == 'all'
if unlimited:
    rows = [dict(r, keepSets=[['all', ['all']]]) for r in rows]
per = int(os.environ.get('PER', 1 if unlimited else 5))
for i in range(0, len(rows), per):
    config = dict(graph=os.environ['GRAPH'], index=os.environ['INDEX'], unlimited=unlimited, rows=rows[i:i + per])
    json.dump(config, open(f'{out}/cfg/{i // per:04d}.json', 'w'))
print(len(rows), 'rows')
PY
echo "GBZ_SRC=${GBZ_SRC:-default} INDEX=$INDEX GRAPH=$GRAPH mode=$mode" > "$out/setup.txt"
export TRUTH=${TRUTH:-}
ls "$out"/cfg/*.json | xargs -P "${WORKERS:-8}" -I{} sh -c '
  b=$(basename {} .json)
  if [ -n "$TRUTH" ]; then export TRUTH_PREFIX='"$out"'/out/$b; fi
  nice -n 10 timeout 3h node --no-warnings --max-old-space-size=8000 '"$here"'/sweep.ts {} > '"$out"'/out/$b.jsonl 2> '"$out"'/out/$b.err'
echo DONE > "$out/DONE"
