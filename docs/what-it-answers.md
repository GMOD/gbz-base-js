# What a database answers

A gbz-base database is a GBZ — a pangenome graph plus every haplotype's walk
through it — in SQLite, so a reader pulls the graph and the walks around a
reference position over HTTP; an rGFA has no walks, only each segment's origin
on one assembly, and neither stores alignments, which the reader derives from
the walks.

## What it does not answer directly

- **A window on a haplotype.** A query starts from a path indexed when the
  database was built, GRCh38's and CHM13's in HPRC v2.1.
- **An alignment between two haplotypes.** `alignments()` aligns each walk to
  the reference. `editsAgainst` accepts any two walks, but `refIndex` and
  `refPrefix` cache the first walk they see, so after `alignments()` a pair
  silently gets a wrong CIGAR. With both caches cleared, the 28 pairs of eight
  HPRC v2.1 haplotypes at the CFH cluster took 184 ms after an 8.19 s cut
  (2026-09-17, over HTTPS).
- **A whole chromosome.** `limit` bounds the cut and nothing coarser exists.
  HPRC's `impg/pafs/all-vs-1/` PAFs hold every haplotype aligned onto every
  other.
