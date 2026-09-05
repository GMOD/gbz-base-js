#!/usr/bin/env bash
# Regenerates the oracle outputs with upstream gbz-base (jltsiren/gbz-base, unmodified).
# Usage: GBZ_BASE=/path/to/gbz-base ./generate.sh
set -euo pipefail
cd "$(dirname "$0")"
while IFS=$'\t' read -r name db args; do
  ${=GBZ_BASE:-gbz-base} query "../$db" ${=args} --format json > "$name.json" 2> "$name.stderr"
done < queries.txt
