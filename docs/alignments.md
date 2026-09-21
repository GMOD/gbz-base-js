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

A stretch of nodes both walks visit is a run of `=`, and a record is the
best-scoring collinear chain of those stretches, found the way minimap2 chains
its seeds. The next record is the best chain over what no accepted record uses
on either haplotype, so a second copy of a repeat finds its target taken and an
inversion finds its target free.

The bases between two stretches get the highest-scoring global alignment under
vg's parameters (match 1, mismatch -4, gap -6 and -1 per further base), written
as `=`, `X`, `I` and `D`. The scoring defines the CIGAR, so two stretches with
nothing in common come out as one insertion and one deletion with no threshold
deciding it. A pair whose lengths multiply past 4,000,000 is seeded on shared
15-mers in both orientations instead and chained the same way, with the exact
alignment between the matches. That aligns two long copies of one sequence the
graph left on separate nodes, and a chain on the opposite strand there is an
inversion, reported as a record of its own since no CIGAR holds one.

A base aligns in one record at most. In a tandem array whose copies run both
ways, one query copy can align forward to one target copy and inverted to
another, and both are homology. Where two records align the same bases, the one
scoring higher over the stretch the two share keeps them, and the other gives
them up as an insertion and a deletion. In the HPRC amylase window that stretch
is 58,204 query bases of NA18608#2 against HG00232#1, where the inverted record
scores 93,009 and the forward one 6,271.

Between a walk's first and last visit to a node it visits more than once, no
node anchors anything. A graph folds the copies of a tandem repeat onto shared
nodes, which says nothing about which copy of one haplotype pairs with which
copy of the other, so the bases decide there, through the 15-mer chain. Taking
the graph's pairing instead pairs a 169 kb insertion with a 169 kb deletion
inside one record of the HPRC amylase window, where the copies line up one array
apart.

`sharedBases` counts the `=` that came off shared nodes, so `matches` less
`sharedBases` is what comparing bases found, and the CLI writes it as the PAF
tag `ns:i:`. A chain pays for the gap it spans out of the bases it matches, so
by default nothing bounds how far a record reaches but the window; `maxGap` caps
the private bp a record skips on either walk, which bounds the work on a wide
one. A record matching fewer than `minMatch` bases (100) is dropped.
`queryStart`/`queryEnd` and `targetStart`/`targetEnd` are each haplotype's own
coordinates, and a `-` record's CIGAR reads along the target, the way minimap2
writes one. A haplotype the window holds as several walks gives records per
walk, and none spans two.

Every walk has to be named, so this needs the
[haplotype index](haplotype-index.md). `pairAlignments` in `pairAlignment.ts` is
the same thing over two bare walks of node handles.

On the command line `--against` takes the target and `--stack` takes a list,
aligning each entry to the next, which is the set of pairs a stacked synteny
view draws. Both print PAF from one fetch of the window:

```
gbz-base-query graph.gbz.db --haplotype-index index.db --sample GRCh38 --contig chr6 \
  --interval 31940000..32090000 --context 0 \
  --stack 'HG01978#2,HG02004#2,GRCh38#0,HG02818#1,HG00146#1' --contig-lengths lengths.tsv
```

A window holds no contig lengths. `--contig-lengths` reads PAF columns 2 and 7
from a chrom.sizes or `.fai`, keyed by contig or by `sample#haplotype#contig`;
without it they are each record's own end.
