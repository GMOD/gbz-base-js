# How it works

It answers the same subgraph queries as `gbz-base query`, reading only the
SQLite pages a query touches, so a multi-gigabyte database on an HTTP server is
queried through range requests without downloading it or compiling anything to
WebAssembly ([why-not-wasm.md](why-not-wasm.md) is that second half).

No SQLite library is involved. The reader walks the SQLite b-trees directly
(rowid lookups, index seeks, overflow chains) and decodes the GBWT node records
the same way gbwt-rs does. Databases are produced by unmodified upstream
`gbz-base construct`.

Pages are read through a pager that fetches fixed blocks (64 KiB by default) and
caches them, so the b-tree descents and index seeks of one query share a handful
of range requests rather than paying a round trip per page.

## Fidelity to upstream

`test/data/oracle/` holds JSON written by upstream `gbz-base query` for the
queries listed in `queries.txt`, over databases built from gbwt-rs's test graphs
(`micb-kir3dl1.gbz`, a 46-sample HPRC slice; `example.gbz`; `example-v3.gbz`).
The test suite requires this library's output to be deep equal to every one of
them, CIGAR strings included. `generate.sh` regenerates the oracle with an
upstream binary.

Not ported: GAF-base.

## Where the CIGARs differ

CIGARs are computed by matching each shared node to its earliest usable
occurrence on the reference walk, which is weight-optimal whenever every shared
node can be placed in order; the Myers-based weighted LCS from gbwt-rs runs only
for the fragments where that fails (inversions, repeats). The two can pick
different equal-weight alignments only when the reference walk repeats a node.

One deliberate departure: where a reference walk is stored against node
orientation (upstream prints "the reference path is not in canonical
orientation" there), every other walk comes out in the opposite orientation, and
upstream aligns them handle for handle, giving all-insertion CIGARs against the
reference despite the nodes being shared. This reader aligns each walk in
whichever orientation shares more sequence with the reference and reports `-` on
such records. CHM13 on HPRC chr20 has one such region, right after the fragment
starting at 30368374.
