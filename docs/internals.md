# Internals

## Reading SQLite directly

This package walks the SQLite b-trees itself (rowid lookups, index seeks,
overflow pages) and decodes GBWT node records the way gbwt-rs does. The reader
takes databases built by stock `gbz-base construct`, with no conversion step.

## Why not WebAssembly

gbz-base compiled to wasm can't read files built on 64-bit machines. gbwt-rs
stores some header fields as `usize`, which varies in size by platform, and wasm
is generally 32-bit. A TypeScript reader avoids the problem and makes HTTP range
requests through `generic-filehandle2`, like other JBrowse readers.

## Tests against upstream

`test/data/oracle/` holds the JSON that upstream `gbz-base query` writes for the
queries in `queries.txt`. The tests require identical output, CIGARs included,
and the order of the walks, which sets their `unknown#N` names; the inversion
and stray-end queries hold walks that start on a reverse handle, where the two
implementations found them in different passes. `generate.sh` regenerates the
files with an upstream binary.

## Differences from upstream

- On walks that loop through shared nodes, this package uses a different
  weight-optimal search, which can pick a different alignment of equal weight
  ([optimizations.md](optimizations.md#aligning-a-walk-to-the-reference)).
- Where the reference is stored reversed relative to its nodes, this package
  aligns each walk in whichever orientation shares more sequence and marks those
  records `-`. Upstream warns that the reference path is not in canonical
  orientation and gives all-insertion CIGARs. CHM13's path fragment on HPRC
  chr20 starting at 30,368,374 begins in such a region.
- In such a region the reference walk's twin, the same walk read the other way,
  is the canonical orientation, and upstream prints it as an `unknown` walk
  beside the reference. A walk that starts and ends at one node in opposite
  orientations, as through a hairpin, is canonical both ways, and upstream
  prints both. This package drops a twin once identification names it as the
  same stretch of the same path as another walk, or as the reference over the
  reference interval, and aligns the walk that stays in whichever orientation
  shares more sequence. Without a haplotype index the twins stay, as upstream
  prints them. With `haplotypes: 'distinct'` and a haplotype index, the walks a
  twin would merge with, those of haplotypes stored against the reference and
  walks canonical both ways, merge after identification rather than before, so
  the merged record's name and weight are those of the walks that remain.
