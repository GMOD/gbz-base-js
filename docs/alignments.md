# Alignment records

`getAlignmentsForRange` returns one record per haplotype passage through the
window, aligned to the reference path you queried:

```ts
for (const alignment of alignments) {
  const { refStart, refEnd, strand, cigar } = alignment
  if (alignment.resolved) {
    console.log(alignment.label, alignment.hapStart, alignment.hapEnd)
  }
}
```

## One record is one haplotype's passage

A haplotype's walk can leave the window's subgraph and come back, through a
bubble whose nodes the window does not hold or through a private insertion. The
reader identifies the pieces on either side separately, then joins them into one
record when they are consecutive fragments of the same haplotype, on the same
strand, and in increasing order on both the reference and the haplotype. The
stretch between two joined pieces becomes an insertion and a deletion in the
record's CIGAR, scored the same way as diverging stretches inside the window.

Pieces that fail those tests stay separate records. Examples are an inversion
between two pieces, or a tandem repeat whose copies map to the same reference
interval. Fragments the haplotype index could not name also stay separate.

## Fields

| field                 | meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `refStart` / `refEnd` | the record's span on the reference path, running to node boundaries      |
| `cigar`               | the alignment to the reference                                           |
| `strand`              | `-` when the haplotype crosses the window against the reference          |
| `path`                | the walk as node handles, in subgraph order                              |
| `weight`              | the number of identical haplotypes merged, with `haplotypes: 'distinct'` |
| `start`               | the first piece's GBWT position                                          |
| `resolved`            | whether the haplotype index named the record, see below                  |

`refStart` and `refEnd` run to node boundaries, so a record can begin before the
window and end after it.

The reader computes `cigar` as upstream does: a node-length-weighted longest
common subsequence of the two walks' nodes, with the diverging stretches scored
using vg's match, mismatch and gap parameters. The CIGAR compares no bases: vg's
scoring sizes the `M` for the stretch between two shared nodes.

`strand` is `-` when the haplotype runs through the window in the opposite
direction to the reference, so a pair of paths reports the same strand whichever
of the two is the reference.

For a joined record, `path` is the pieces concatenated without the private
stretch between them, so it is not a contiguous walk through the graph.

`weight` is `undefined` unless the query set `haplotypes: 'distinct'`, the mode
that merges identical walks. In that mode a walk no other walk matched has a
weight of 1.

`start` is a property of the graph, so it stays the same when the same window is
fetched again.

## Named and unnamed records

Naming a record needs the [haplotype index](haplotype-index.md), so the record
type is a union on `resolved`. A record with `resolved: true` adds:

- `name`, the `PathName` of the haplotype
- `label`, its string form, such as
  `HG02723#1#JAHEOU010000100.1[4392999-4393486]`
- `pathHandle`
- `hapStart` and `hapEnd`, in that haplotype's own coordinates

A haplotype whose walk shares no node with the reference has
`refEnd <= refStart` and an all-insertion CIGAR. The reader returns it like any
other record.

## One haplotype against another

The `cigar` of a record above aligns a haplotype to the reference path, so two
haplotypes that share sequence the reference lacks have no alignment to each
other there. `subgraph.pairAlignments({ target, query })` aligns one haplotype's
walks to another's, comparing bases. The reference path is a walk like any other
and can be either side. With no `query`, every other named walk in the window is
aligned to the target:

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

Every walk has to be named, so `pairAlignments` needs the haplotype index. The
`pairAlignments` function in `pairAlignment.ts` does the same over two bare
walks of node handles, and takes a `minMatch` option in addition.

### Chaining shared nodes

A stretch of nodes both walks visit is a run of `=`. A record is the
best-scoring collinear chain of those stretches, found the way minimap2 chains
its seeds. The next record is the best chain over what no accepted record uses
on either haplotype, so a second copy of a repeat finds its target taken and an
inversion finds its target free.

A chain pays for the gap it spans out of the bases it matches, so by default
only the window bounds how far a record reaches. `maxGap` caps the private bp a
record skips on either walk, which bounds the work on a wide window. A record
matching fewer than 100 bases is dropped.

### Comparing bases between shared nodes

The reader aligns the bases between two stretches with the highest-scoring
global alignment under vg's parameters (match 1, mismatch -4, gap -6 and -1 per
further base), written as `=`, `X`, `I` and `D`. Because the scoring defines the
CIGAR, two stretches with nothing in common come out as one insertion and one
deletion, with no threshold deciding it.

When the two stretches' lengths multiply past 4,000,000, the reader seeds on
shared 15-mers in both orientations instead, chains the seeds the same way, and
aligns exactly between the matches. That aligns two long copies of one sequence
that the graph left on separate nodes. A chain on the opposite strand there is
an inversion, which the reader reports as a separate record, since a CIGAR
cannot hold one.

### Tandem repeats

Between a walk's first and last visit to a node it visits more than once, no
shared node anchors the alignment. A graph folds the copies of a tandem repeat
onto shared nodes, and that folding does not say which copy in one haplotype
pairs with which copy in the other, so the reader decides from the bases,
through the 15-mer chain. Pairing the copies as the graph does instead would
pair a 169 kb insertion with a 169 kb deletion inside one record of the HPRC
amylase window, where the copies line up one array apart.

### Overlapping records

A base aligns in one record at most. In a tandem array whose copies run both
ways, one query copy can align forward to one target copy and inverted to
another, and both are homology. Where two records align the same bases, the one
scoring higher over the shared stretch keeps them, and the other gives them up
as an insertion and a deletion. In the HPRC amylase window that stretch is
58,204 query bases of NA18608#2 against HG00232#1, where the inverted record
scores 93,009 and the forward one 6,271.

A tie goes to the record with more bases on shared nodes. Ties arise at an
inversion that a walk takes through shared nodes, because `pairAlignments` also
finds that inversion by its bases, in the gap of the forward record spanning it,
and aligns it identically. At the FLNA inversion on chrX, the two records of
HG01150#2 against GRCh38 match the same 37,586 bases, and `pairAlignments` keeps
the one with `sharedBases` 37,583.

### Record fields

`sharedBases` counts the `=` that came from shared nodes, so `matches` minus
`sharedBases` is what comparing bases found. The CLI writes `sharedBases` as the
PAF tag `ns:i:`.

`queryStart`/`queryEnd` and `targetStart`/`targetEnd` are in each haplotype's
own coordinates. The CIGAR of a `-` record reads along the target, as minimap2
writes one. A haplotype the window holds as several walks gives records per
walk, and no record spans two walks.

### Without comparing bases

With `bases: false`, `pairAlignments` chains the same shared nodes and writes
the query's private bp between two shared stretches as `I` and the target's as
`D`. A SNP bubble reads `1I1D`, or `1D1I` in a `-` record, and `matches` equals
`sharedBases`.

With `bases: false` the reader does not relate the private stretches to each
other. Two copies of one sequence on separate nodes come out as an insertion and
a deletion, as does a stretch where either walk revisits the nodes of a tandem
array. An inversion a walk takes through shared nodes is still a `-` record,
since a chain holds it, and an inversion on private nodes is part of an
insertion and a deletion.

### Command line

`--against` takes the target, and `--stack` takes a list and aligns each entry
to the next, which gives the pairs a stacked synteny view draws. Both print PAF
from one fetch of the window:

```
gbz-base-query graph.gbz.db --haplotype-index index.db --sample GRCh38 --contig chr6 \
  --interval 31940000..32090000 --context 0 \
  --stack 'HG01978#2,HG02004#2,GRCh38#0,HG02818#1,HG00146#1' --contig-lengths lengths.tsv
```

`--no-bases` sets `bases: false`, and the PAF then contains only `=`, `I` and
`D`, with `ns:i:` equal to column 10, the matches.

A window holds no contig lengths. `--contig-lengths` reads PAF columns 2 and 7
from a chrom.sizes or `.fai` file, keyed by contig or by
`sample#haplotype#contig`. Without it, each record's own end fills those
columns.
