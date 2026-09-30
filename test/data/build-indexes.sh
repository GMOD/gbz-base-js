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
build split-contig --interval 200 --anchor-spacing 300
build far-stretch --interval 65536 --anchor-spacing 16384 --reference-interval 1024
build two-copies --interval 65536 --anchor-spacing 16384
build far-pass --interval 65536 --anchor-spacing 16384
build unplaced --interval 65536 --anchor-spacing 16384
build inversion --interval 4096 --anchor-spacing 65536
build micb-kir3dl1 --interval 1000 --anchor-spacing 2500
build stray-end --interval 256 --anchor-spacing 2048 --stray-context 100 --stray-bin 1024 --stray-bound 2048 --stray-gap 64
build anchor-at-bound --interval 1000 --anchor-spacing 500 --stray-context 1000 --stray-bin 1000 --stray-bound 2000 --stray-gap 64
