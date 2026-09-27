# Internals

## Reading SQLite directly

The reader walks the SQLite b-trees itself (rowid lookups, index seeks, overflow
pages) and decodes GBWT node records the way gbwt-rs does. It reads databases
built by stock `gbz-base construct`.

## Tests against upstream

`test/data/oracle/` holds the JSON that upstream `gbz-base query` writes for the
queries in `queries.txt`. The tests require identical output, CIGARs included.
`generate.sh` regenerates it with an upstream binary.

## Differences from upstream

- On walks that loop through shared nodes, this reader uses a different
  weight-optimal search, which can pick a different alignment of equal weight
  ([optimizations.md](optimizations.md#aligning-a-walk-to-the-reference)).
- Where the reference is stored reversed relative to its nodes, this reader
  aligns each walk in whichever orientation shares more sequence and marks those
  records `-`. Upstream gives all-insertion CIGARs there. CHM13 on HPRC chr20
  has one such region, just after the path fragment starting at 30,368,374.
