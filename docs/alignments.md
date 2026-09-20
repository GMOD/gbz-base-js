# Alignment records

`getAlignmentsForRange` returns one record per haplotype crossing the window:

```ts
for (const alignment of alignments) {
  const { refStart, refEnd, strand, cigar } = alignment
  if (alignment.resolved) {
    console.log(alignment.label, alignment.hapStart, alignment.hapEnd)
  }
}
```

## One record is one haplotype's passage

A record is one haplotype's passage through the window. Where a haplotype's walk
leaves the subgraph and comes back (a bubble whose nodes the window does not
hold, a private insertion), the pieces on either side are identified separately
and then joined back into one record when they are the same haplotype's
consecutive fragments, on the same strand and monotone on both the reference and
the haplotype; the stretch between them becomes the record's insertion and
deletion, scored the way the diverging stretches inside the window are. Pieces
that fail those tests (an inversion between them, a tandem repeat mapping both
to the same reference interval) stay separate records, as do fragments the index
could not name.

## The fields

`refStart`/`refEnd` are the record's span on the reference path you queried.
They run to node boundaries, so a record can begin before the window you asked
for and end after it.

`cigar` is its alignment to that reference, computed like upstream: a
node-length-weighted LCS, with the diverging stretches scored using vg's match,
mismatch and gap parameters.

`strand` is `-` when the haplotype runs through the window in the opposite
direction to the reference, so the same pair of paths reports the same strand
whichever of the two is the reference.

`path` is the walk as node handles, in subgraph order; for a joined record it is
the pieces concatenated, with the private stretch between them absent, so it is
not a contiguous walk through the graph.

`weight` is how many identical haplotypes the record stands for, and is
`undefined` unless the query asked for `haplotypes: 'distinct'` — that is the
mode that merges identical walks, and in it a walk nothing matched has a weight
of 1.

`start` is the first piece's GBWT position, which is a property of the graph and
so is stable across refetches of the same window.

## `resolved` is a union, not optional fields

Naming a fragment needs the [haplotype index](haplotype-index.md), and a
database without one cannot do it, so the record is a union on `resolved` rather
than a handful of separately-undefined fields. A resolved one adds the
`PathName` as `name`, its `HG02723#1#JAHEOU010000100.1[4392999-4393486]`
rendering as `label`, the `pathHandle`, and `hapStart`/`hapEnd` in that
haplotype's own coordinates.

## Haplotypes sharing no node

A haplotype whose walk shares no node with the reference has
`refEnd <= refStart` and an all-insertion CIGAR; those come back like any other,
to drop or keep as you like.

## One haplotype against another

`cigar` above aligns a haplotype to the reference path and compares no bases:
the stretch between two shared nodes is an `M` sized by vg's scoring. Two
haplotypes that share sequence the reference lacks have no record of it there.

`subgraph.pairAlignments({ target, query })` aligns one haplotype's walks to
another's instead. The reference path is a walk like any other, on either side,
and with no `query` every other named walk in the window is one:

```ts
const subgraph = await subgraphForHaplotypes(db, query, start, end, { keep })
const target = { sample: 'HG02004', haplotype: 2 }
for (const r of subgraph.pairAlignments({ target })) {
  console.log(
    r.query,
    r.queryStart,
    r.queryEnd,
    r.strand,
    r.targetStart,
    r.cigar,
  )
}
```

A node both walks visit is a run of `=`. The bases between two shared nodes get
the highest-scoring global alignment under vg's parameters (match 1, mismatch
-4, gap -6 and -1 per further base), written as `=`, `X`, `I` and `D`. The
scoring defines the CIGAR, so two stretches with nothing in common come out as
one insertion and one deletion with no threshold deciding it. A pair whose
lengths multiply past 4,000,000 is not aligned and is written the same way.

A record is a run of shared nodes whose order on the target moves one way, and
`maxGap` (10,000 by default) is the most private bp it skips on either walk, so
raise it to keep a large insertion inside one record. `queryStart`/`queryEnd`
and `targetStart`/`targetEnd` are each haplotype's own coordinates, and a `-`
record's CIGAR reads along the target, the way minimap2 writes one. A haplotype
the window holds as several walks gives records per walk, and none spans two.

Every walk has to be named, so this needs the
[haplotype index](haplotype-index.md). `pairAlignments` in `pairAlignment.ts` is
the same thing over two bare walks of node handles.

On the command line `--against` takes the target and `--stack` takes a list,
aligning each entry to the next, which is the set of pairs a stacked synteny
view draws. Both print PAF from one fetch of the window:

```
gbz-base-query graph.gbz.db --haplotype-index index.db --sample GRCh38 --contig chr6 \
  --interval 31940000..32090000 --context 0 --max-gap 200000 \
  --stack 'HG01978#2,HG02004#2,GRCh38#0,HG02818#1,HG00146#1' --contig-lengths lengths.tsv
```

A window holds no contig lengths. `--contig-lengths` reads PAF columns 2 and 7
from a chrom.sizes or `.fai`, keyed by contig or by `sample#haplotype#contig`;
without it they are each record's own end.
