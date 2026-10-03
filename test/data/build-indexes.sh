#!/bin/bash
# Rebuilds the fixture haplotype indexes that carry anchors, from the committed
# .gbz.db files. Usage: build-indexes.sh [path to gbz-haplotype-index]
# Reports a fixture whose samples, anchors or lengths change.
set -eu
cd "$(dirname "$0")"
indexer=${1:-gbz-haplotype-index}
summary() {
  sqlite3 "$1" "select count(*), sum(node_handle), sum(node_offset), sum(path_handle), sum(path_offset), sum(orientation) from HaplotypeSamples; select count(*), sum(node_handle), sum(path_offset) from HaplotypeAnchors; select count(*), sum(length) from HaplotypeLengths"
}
build() {
  name=$1
  shift
  before=$(summary "$name.haplotype-index.db")
  "$indexer" "$@" --overwrite --from-db "$name.gbz.db" "$name.haplotype-index.db" 2>&1 | tail -1
  if [ "$before" != "$(summary "$name.haplotype-index.db")" ]; then
    echo "the samples, anchors or lengths of $name changed"
  fi
}
build split-contig --interval 200 --anchor-spacing 300 --page-size 4096
build far-stretch --interval 65536 --anchor-spacing 16384 --reference-interval 1024 --page-size 4096
build two-copies --interval 65536 --anchor-spacing 16384 --page-size 4096
build far-pass --interval 65536 --anchor-spacing 16384 --page-size 4096
build unplaced --interval 65536 --anchor-spacing 16384 --page-size 4096
build inversion --interval 4096 --anchor-spacing 65536 --page-size 4096
build micb-kir3dl1 --interval 1000 --anchor-spacing 2500 --overview-bin 100 --overview-chunk 4
build stray-end --interval 256 --anchor-spacing 2048 --stray-context 100 --stray-bin 1024 --stray-bound 2048 --stray-gap 64 --page-size 4096
build anchor-at-bound --interval 1000 --anchor-spacing 500 --stray-context 1000 --stray-bin 1000 --stray-bound 2000 --stray-gap 64 --page-size 4096
build keep-bounds --interval 4096 --anchor-spacing 1000 --stray-context 1 --stray-bin 2000 --stray-bound 1000 --stray-gap 64 --page-size 4096
build reverse-reference --interval 16384 --page-size 4096
build shared-hairpin --interval 16384 --page-size 4096
# Indexes without anchors, and one with one orientation, which open refuses.
"$indexer" --interval 1000 --anchor-spacing 0 --page-size 4096 --overwrite --from-db detour.gbz.db detour.haplotype-index.db 2>&1 | tail -1
"$indexer" --interval 1000 --anchor-spacing 0 --page-size 4096 --overwrite --from-db micb-kir3dl1.gbz.db micb-kir3dl1.sampled.haplotype-index.db 2>&1 | tail -1
"$indexer" --interval 1000 --anchor-spacing 0 --forward-only --page-size 4096 --overwrite --from-db micb-kir3dl1.gbz.db micb-kir3dl1.forward-only.haplotype-index.db 2>&1 | tail -1
"$indexer" --interval 3 --anchor-spacing 0 --page-size 4096 --overwrite --from-db example.gbz.db example.haplotype-index.db 2>&1 | tail -1
"$indexer" --interval 3 --anchor-spacing 0 --page-size 4096 --overwrite --from-db example-v3.gbz.db example-v3.haplotype-index.db 2>&1 | tail -1
