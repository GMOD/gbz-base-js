# Internals

## Reading SQLite without SQLite

This reader answers the same subgraph queries as `gbz-base query` and uses no
SQLite library. It walks the SQLite b-trees directly, with rowid lookups, index
seeks and overflow chains, and decodes the GBWT node records the same way
gbwt-rs does. Unmodified upstream `gbz-base construct` produces the databases it
reads.

A pager reads the file in fixed blocks, 64 KiB by default, and caches them, so
the b-tree descents and index seeks of one query share a handful of range
requests instead of making one per page. [dataflow.md](dataflow.md) draws the
path from the query call down to the range request.

## Fidelity to upstream

`test/data/oracle/` holds JSON that upstream `gbz-base query` wrote for the
queries listed in `queries.txt`, over databases built from gbwt-rs's test
graphs: `micb-kir3dl1.gbz`, a 46-sample HPRC slice; `example.gbz`; and
`example-v3.gbz`. The test suite requires this library's output to deep-equal
every one of them, CIGAR strings included. `generate.sh` regenerates the oracle
with an upstream binary.

## Where the CIGARs differ from upstream

This reader and upstream both compute a weight-optimal alignment of each walk to
the reference, and they agree on every oracle query. On walks that loop or
reorder shared nodes they use different searches, which can pick different
alignments of equal weight. Upstream runs gbwt-rs's Myers-based search, whose
memory grows with the edit distance in bases; this reader chains the step pairs
that share a node, in memory linear in the two walks.
[optimizations.md](optimizations.md#aligning-a-walk-to-the-reference) describes
the search and its measurements.

The readers also differ at a reference walk stored against node orientation,
where upstream prints "the reference path is not in canonical orientation".
Every other walk there comes out in the opposite orientation. Upstream aligns
them handle for handle, which gives all-insertion CIGARs even though the walks
share nodes with the reference. This reader aligns each walk in whichever
orientation shares more sequence with the reference, and reports `-` on those
records. CHM13 on HPRC chr20 has one such region, right after the fragment
starting at 30368374.
