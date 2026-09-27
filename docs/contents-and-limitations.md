# Contents and limitations

## What a database contains

An rGFA records which assembly each graph segment came from. A GBZ also records
every haplotype's walk through the graph, as a GBWT, the compressed index of
those walks. gbz-base stores a GBZ in SQLite, in four tables: `Nodes`, with one
row per oriented node holding its sequence and GBWT record; `Paths`;
`ReferenceIndex`, which maps offsets on the reference paths to GBWT positions;
and `Tags`. This package reads the rows around one reference region over HTTP.

rGFA and GBZ files contain no pairwise alignments. `getAlignmentsForRange`
computes each haplotype's alignment to the reference from the walks, and
`pairAlignments` computes one haplotype's alignment to another
([alignments.md](alignments.md)).

A walk extracted from a window does not record which path it belongs to. The
haplotype index adds the tables this package needs to name it
([haplotype-index.md](haplotype-index.md)). The `Nodes` rows also carry the
top-level chains of the snarl decomposition, which the `snarls` option uses
([snarls.md](snarls.md)).

## Limitations

- The range queries accept only a path that `gbz-base construct` indexed for
  random access. In HPRC v2.1 those are the GRCh38 and CHM13 paths, so neither
  query accepts a region given in a haplotype's coordinates.
- `getAlignmentsForRange` aligns each walk to the reference walk only. Aligning
  haplotypes to each other takes `pairAlignments`, which needs the haplotype
  index.
- The `limit` option caps the number of nodes a query extracts, and a database
  contains no lower-resolution summary for a region too wide to extract. For
  alignments across a whole chromosome, HPRC publishes PAF files under
  `impg/pafs/all-vs-1/`, one per haplotype, each with every other haplotype
  aligned to that haplotype.
- The package does not read GAF-base, gbz-base's format for read alignments.
