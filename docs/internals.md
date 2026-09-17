# Internals

This reader answers the same subgraph queries as `gbz-base query`, reading only
the SQLite pages a query touches, so it queries a multi-gigabyte database on an
HTTP server through range requests without downloading it or compiling anything
to WebAssembly ([why-not-wasm.md](why-not-wasm.md) is that second half).

No SQLite library is involved. The reader walks the SQLite b-trees directly
(rowid lookups, index seeks, overflow chains) and decodes the GBWT node records
the same way gbwt-rs does. Databases are produced by unmodified upstream
`gbz-base construct`.

Pages are read through a pager that fetches fixed blocks (64 KiB by default) and
caches them, so the b-tree descents and index seeks of one query share a handful
of range requests rather than paying a round trip per page.
[dataflow.md](dataflow.md) draws the whole path, from the call down to the range
request.

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
node can be placed in order. The fragments where that fails — a walk looping
through a copy-number expansion, a rearrangement, a repeat — fall back to a
node-length-weighted LCS, and there the two readers part ways. Upstream runs
gbwt-rs's Myers-based search, whose state grows with the edit distance in bases:
at AMY1 on the HPRC graph, a walk of 13,303 steps and 230,857 bp against a
7,585-step reference exhausted a 3 GB heap in this reader's port of it. This
reader chains only the step pairs that share a node, as a heaviest increasing
subsequence, and splits the problem Hirschberg-style once those pairs outnumber
the steps, so memory stays linear in the two walks; the same fragment aligns in
8 ms. Both are weight-optimal, but they can pick different equal-weight
alignments.

The chaining search costs time where the Myers search cost memory: its cost
follows the number of step pairs that share a node, so two walks looping the
same node thousands of times make millions of pairs. The search matches a shared
prefix and suffix outright at every level of the split, which absorbs a loop
both walks enter from the same flank — 3,200 passes against 3,000 align in 4 ms
rather than 740. Loops the trim cannot reach still cost: with the flanking nodes
swapped, the same pair takes 400 ms.

One deliberate departure: where a reference walk is stored against node
orientation (upstream prints "the reference path is not in canonical
orientation" there), every other walk comes out in the opposite orientation, and
upstream aligns them handle for handle, giving all-insertion CIGARs against the
reference despite the nodes being shared. This reader aligns each walk in
whichever orientation shares more sequence with the reference and reports `-` on
such records. CHM13 on HPRC chr20 has one such region, right after the fragment
starting at 30368374.
