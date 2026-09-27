# Internals

## Reading SQLite directly

This package walks the SQLite b-trees itself (rowid lookups, index seeks,
overflow pages) and decodes GBWT node records the way gbwt-rs does. It reads
databases built by stock `gbz-base construct`.

## Why not WebAssembly

gbz-base compiled to wasm can't read its own files. gbwt-rs stores some header
fields as `usize`, which varies in size by platform, and wasm is generally
32-bit. A TypeScript reader avoids the problem and makes HTTP range requests
through `generic-filehandle2`, like other JBrowse readers.

## Tests against upstream

`test/data/oracle/` holds the JSON that upstream `gbz-base query` writes for the
queries in `queries.txt`. The tests require identical output, CIGARs included.
`generate.sh` regenerates it with an upstream binary.

## Differences from upstream

- On walks that loop through shared nodes, this package uses a different
  weight-optimal search, which can pick a different alignment of equal weight
  ([optimizations.md](optimizations.md#aligning-a-walk-to-the-reference)).
- Where the reference is stored reversed relative to its nodes, this package
  aligns each walk in whichever orientation shares more sequence and marks those
  records `-`. Upstream warns that the reference path is not in canonical
  orientation and gives all-insertion CIGARs. CHM13's path fragment on HPRC
  chr20 starting at 30,368,374 begins in such a region.
