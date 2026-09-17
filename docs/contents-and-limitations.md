# Contents and limitations

An rGFA records which assembly each graph segment came from, and a GBZ also
records every haplotype's walk through the graph; gbz-base stores a GBZ in
SQLite so that this package can read the part of it around one reference region
over HTTP.

rGFA and GBZ files contain no pairwise alignments. `getAlignmentsForRange`
computes each haplotype's alignment to the reference from the walks.

## Limitations

- `getSubgraphForRange` and `getAlignmentsForRange` accept only a path that was
  indexed when the database was built. In HPRC v2.1 those are the GRCh38 and
  CHM13 paths, so neither function accepts a region on a haplotype.
- `alignments()` aligns each walk to the reference walk only.
  `Subgraph.editsAgainst` accepts any two walks, but `refIndex` and `refPrefix`
  store the index of the first walk passed to them and return that index on
  every later call. After `alignments()` has run, a call with two haplotype
  walks returns a wrong CIGAR and raises no error. With both caches cleared
  between calls, aligning all 28 pairs of eight HPRC v2.1 haplotypes at the CFH
  cluster took 184 ms, after 8.19 s to open the database and extract the region
  over HTTPS (2026-09-17).
- The `limit` option caps the number of nodes a query extracts, and a database
  contains no lower-resolution summary for a region too wide to extract. For
  alignments across a whole chromosome, HPRC publishes PAF files under
  `impg/pafs/all-vs-1/`, one per haplotype, each with every other haplotype
  aligned to that haplotype.
