# Contents and limitations

A GBZ file holds a pangenome graph and every haplotype's path through it, stored
as a GBWT. gbz-base puts a GBZ into SQLite, with one row per node orientation, a
table of paths, and an index from offsets along the reference and generic paths
to GBWT positions. This package reads the rows around one region of such a path.

This package computes alignments at query time. `getAlignments` aligns each walk
to the reference ([alignments.md](alignments.md)), and `pairAlignments` aligns
haplotypes to each other. The sample and haplotype of each walk come from the
haplotype index, a second file built once per graph
([haplotype-index.md](https://github.com/GMOD/gbz-haplotype-index/blob/main/docs/haplotype-index.md)).

## Limitations

- Range queries take a path gbz-base has indexed, a reference path such as
  GRCh38 or CHM13 in HPRC v2.1 or a generic path.
- A query extracts every node in the window, up to `limit`. For whole-chromosome
  alignments, HPRC publishes PAF files under `impg/pafs/all-vs-1/`.
- GAF-base, gbz-base's format for read alignments, is out of scope.
