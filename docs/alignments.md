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
