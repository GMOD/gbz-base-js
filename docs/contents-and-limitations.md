# Contents and limitations

A GBZ file holds a pangenome graph and every haplotype's walk through it, stored
as a GBWT. gbz-base puts a GBZ into SQLite, with one row per node, a table of
paths, and an index from reference offsets to GBWT positions. This package reads
the rows around one reference region.

Alignments are computed from the walks at query time: to the reference by
`getAlignmentsForRange` ([alignments.md](alignments.md)), or between haplotypes
by `pairAlignments`. Walk names come from the haplotype index
([haplotype-index.md](haplotype-index.md)).

## Limitations

- Range queries take a reference path: GRCh38 or CHM13 in HPRC v2.1.
- A query extracts every node in the window, up to `limit`. For whole-chromosome
  alignments, HPRC publishes PAF files under `impg/pafs/all-vs-1/`.
- GAF-base, gbz-base's format for read alignments, is out of scope.
