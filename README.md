# @gmod/gbz-base

[![NPM version](https://img.shields.io/npm/v/@gmod/gbz-base.svg?style=flat-square)](https://npmjs.org/package/@gmod/gbz-base)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/gbz-base-js/publish.yml?branch=main)

A pure TypeScript reader for [gbz-base](https://github.com/jltsiren/gbz-base)
pangenome databases (`.gbz.db`).

## Usage

```ts
import { RemoteFile } from 'generic-filehandle2'
import { GBZBase } from '@gmod/gbz-base'

const db = await GBZBase.open(
  new RemoteFile('https://example.org/graph.gbz.db'),
)

// one record per haplotype crossing the window
const alignments = await db.getAlignmentsForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
)

// the same window as a subgraph, for a pangenome view
const subgraph = await db.getSubgraphForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
)
const gfa = await subgraph?.toGFA({ names: 'resolved' })
```

Coordinates are 0-based half-open, and are offsets along the path you named, so
`('GRCh38#0#chr6', 31500000, 31501000)` is the same window
`gbz-base query --interval 31500000..31501000` gives.

The path is a PanSN `sample#haplotype#contig` string, or a bare contig for a
graph whose reference paths have no sample. `{ sample, haplotype, contig }`
works too, and `parsePathName` is the parser if you want it separately.

Both take `{ context, haplotypes, keep, limit, signal }`, and
`getSubgraphForRange` also `snarls`; both resolve haplotype names when the
database can. For alignments `haplotypes` is `all` or `distinct`, the two
outputs that leave something to align against the reference.

`keep` is a predicate over the `PathName` of each walk: the window comes back
with the reference walk, the walks it accepts and the nodes those walks visit,
so a query for a chosen set draws that set's private sequence and nothing
else's. It needs the haplotype index and throws without one. With a companion
that carries anchors (see below) the wanted haplotypes are walked from the
anchor before the window and nothing else is extracted or named, so the cost is
the set's; with an older companion every walk is named first and the predicate
only trims the alignment and the output. Measured against the HPRC v2.1 graph
and its hosted companion, both over HTTPS, context 1000, contained snarls, the
tutorial's eight haplotypes against all 464, on a fresh open after one warm-up
window elsewhere and again with the window's pages cached:

| Window       | Set   | Open       | Route    | Records | Nodes  | Graph           | Companion       | Time   |
| ------------ | ----- | ---------- | -------- | ------- | ------ | --------------- | --------------- | ------ |
| KIV-2 30 kb  | eight | after open | anchored | 8       | 3,140  | 9 req, 2.23 MB  | 9 req, 0.59 MB  | 3.08 s |
| KIV-2 30 kb  | eight | cached     | anchored | 8       | 3,140  | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 0.38 s |
| KIV-2 30 kb  | all   | after open | sampled  | 464     | 21,721 | 7 req, 1.57 MB  | 9 req, 0.59 MB  | 3.75 s |
| KIV-2 30 kb  | all   | cached     | sampled  | 464     | 21,721 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 2.17 s |
| KIV-2 130 kb | eight | after open | anchored | 8       | 7,383  | 11 req, 2.62 MB | 13 req, 0.85 MB | 2.87 s |
| KIV-2 130 kb | eight | cached     | anchored | 8       | 7,383  | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 0.51 s |
| KIV-2 130 kb | all   | after open | sampled  | 464     | 27,438 | 8 req, 1.90 MB  | 14 req, 0.92 MB | 4.80 s |
| KIV-2 130 kb | all   | cached     | sampled  | 464     | 27,438 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 3.74 s |
| AMY1         | eight | after open | anchored | 13      | 8,164  | 28 req, 3.21 MB | 15 req, 0.98 MB | 6.11 s |
| AMY1         | eight | cached     | anchored | 13      | 8,164  | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 0.48 s |
| AMY1         | all   | after open | sampled  | 1,395   | 12,240 | 23 req, 2.23 MB | 23 req, 1.51 MB | 8.43 s |
| AMY1         | all   | cached     | sampled  | 1,395   | 12,240 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 3.00 s |
| MHC class II | eight | after open | anchored | 8       | 31,008 | 11 req, 4.06 MB | 10 req, 0.66 MB | 5.46 s |
| MHC class II | eight | cached     | anchored | 8       | 31,008 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 0.97 s |
| MHC class II | all   | after open | sampled  | 463     | 43,540 | 12 req, 2.62 MB | 8 req, 0.52 MB  | 9.59 s |
| MHC class II | all   | cached     | sampled  | 463     | 43,540 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 9.16 s |

The "all" rows are the sampled route the same query takes without `keep`.

`context` is the graph context in bp to extend past the window, 100 by default.
It does not decide how many records come back, since the pieces of a walk that
leaves the subgraph are joined again (see below); it trades nodes read against
pieces to identify and join. A window inside a snarl much larger than itself
(MHC class II on the HPRC graph) is 1.1M pieces at `context: 0` and 464 walks at
1000, three times faster; a window whose private stretches are short bubbles
costs about the same either way. `limit` caps the subgraph at that many nodes,
per fragment. `signal` is an `AbortSignal`; a query checks it between range
requests, so an abort stops the next fetch rather than the one in flight.

### One returns records, the other a query object

`getAlignmentsForRange` hands back data, and spans path fragments — a window
crossing a boundary queries each fragment and concatenates, which is
coordinate-correct because a record's `refStart`/`refEnd` are absolute.

`getSubgraphForRange` hands back the `Subgraph` itself, because two disjoint
fragments do not merge into one graph. It answers for the first fragment
overlapping the window, clamped to it, and is `undefined` when the path is
unknown or no fragment overlaps the window. `subgraph.referenceInterval` is the
reference walk the subgraph holds, which runs to node boundaries and through
`context`, so it is wider than the clamped window on both sides. Use
`pathFragmentsForRange` to see the fragment bounds themselves, and `hasPath` to
ask about a path alone.

A path that exists but was never indexed for random access throws rather than
returning nothing — that is a database that needs rebuilding, not an empty
window.

### What an alignment is

```ts
for (const alignment of alignments) {
  const { refStart, refEnd, strand, cigar } = alignment
  if (alignment.resolved) {
    console.log(alignment.label, alignment.hapStart, alignment.hapEnd)
  }
}
```

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

`refStart`/`refEnd` are the record's span on the reference path you queried.
They run to node boundaries, so a record can begin before the window you asked
for and end after it. `cigar` is its alignment to that reference, computed like
upstream: a node-length-weighted LCS, with the diverging stretches scored using
vg's match, mismatch and gap parameters. `strand` is `-` when the haplotype runs
through the window in the opposite direction to the reference, so the same pair
of paths reports the same strand whichever of the two is the reference. `path`
is the walk as node handles, in subgraph order; for a joined record it is the
pieces concatenated, with the private stretch between them absent, so it is not
a contiguous walk through the graph. `weight` is how many identical haplotypes
it stands for, and `start` is the first piece's GBWT position, which is a
property of the graph and so is stable across refetches of the same window.

Naming a fragment needs the haplotype index described below, and a database
without one cannot do it, so the record is a union on `resolved` rather than a
handful of separately-undefined fields. A resolved one adds the `PathName` as
`name`, its `HG02723#1#JAHEOU010000100.1[4392999-4393486]` rendering as `label`,
the `pathHandle`, and `hapStart`/`hapEnd` in that haplotype's own coordinates.

A haplotype whose walk shares no node with the reference has
`refEnd <= refStart` and an all-insertion CIGAR; those come back like any other,
to drop or keep as you like.

### Sources

Any object with `read(length, position)` and `stat()` works as a source, so
`LocalFile`, `RemoteFile` and `BlobFile` from `generic-filehandle2` all do.
Pages are fetched in blocks (64 KiB by default, `blockSize` in the open options)
and cached.

### Lower-level queries

The two above cover the interval query and hide where a contig is stored split
into path fragments. The four query functions underneath are what
`gbz-base query` itself does, take a window you have already resolved, and leave
identification to you:

```ts
import { subgraphAtOffset, subgraphInInterval } from '@gmod/gbz-base'

const subgraph = await subgraphInInterval(
  db,
  { sample: 'GRCh38', contig: 'chr6' },
  31500000,
  31501000,
  { context: 0, haplotypes: 'all' },
)
await subgraph.identifyPaths()
const graph = subgraph.toSubgraphJson({ cigar: true, names: 'resolved' })
const gfa = await subgraph.toGFA({ cigar: true, names: 'resolved' })
```

`subgraphAtOffset` and `subgraphAroundNodes` are the other two;
`subgraphBetween` is described under Snarls. They throw for a window that runs
past the end of a path fragment, where `getAlignmentsForRange` clamps.

The command line mirrors the upstream tool for the query types it supports:

```
gbz-base-query graph.gbz.db --sample GRCh38 --contig chr6 --interval 31500000..31501000 --cigar
gbz-base-query https://host/graph.gbz.db --contig chrM --offset 1000 --context 50 --stats
```

`--stats` reports how many range requests a query made and how many bytes they
carried, and with `--resolve` or `--alignments` how identification went: index
scans, chains per haplotype, why each chain ended, companion seeks against graph
record lookups, and fragment lengths against the walk bound.

## Snarls

A `.gbz.db` built by upstream `gbz-base construct` stores the top-level chains
of the snarl decomposition as `next` links on the boundary node records (the
`chains` and `chain_links` tags say how many). The query functions take a
`snarls` option that uses them the way upstream's `--snarls` and
`--extend-snarls` do:

- `contained` adds every top-level snarl whose two boundary nodes are both in
  the subgraph. With `context: 0` an interval query returns only the reference
  walk, and this is what brings the variation back without a bp radius.
- `overlapping` also follows a boundary node whose partner lies outside the
  subgraph, and, when the subgraph holds no chain link at all, walks out to the
  snarl containing it. The subgraph must be connected, so a node query may give
  only one node. A snarl can be far larger than the window (a large deletion, a
  centromere), so set `limit` when using this mode.

`subgraphBetween(db, start, end)` is upstream's `--between`: everything between
two oriented boundary handles of one chain, with no context. On the command line
these are `--snarls`, `--extend-snarls` and `--between 129+:160+`.

## Naming haplotypes

Upstream gbz-base cannot say which haplotype a subgraph path belongs to, so it
emits `unknown#N`. This package adds that with two side tables that a small Rust
tool writes into an existing database, built on the unmodified upstream crates:

```
cd tools/haplotype-index && cargo build --release
./target/release/gbz-haplotype-index --interval 4096 --anchor-spacing 131072 graph.gbz graph.gbz.db
./target/release/gbz-haplotype-index --interval 4096 --anchor-spacing 131072 --from-db graph.gbz.db
```

The second form walks the paths through the database's own node records, so a
database whose GBZ is no longer at hand can still be augmented; the two forms
write identical tables. Walking a GBZ uses every core (`--threads`).

With `--output index.db` the tool writes the same tables into a standalone
companion database instead, and the reader opens the two side by side:

```
./target/release/gbz-haplotype-index --interval 16384 --anchor-spacing 131072 --output graph.haplotype-index.db graph.gbz
gbz-base-query https://host/graph.gbz.db --haplotype-index https://host/graph.haplotype-index.db ...
```

```ts
const db = await GBZBase.open(new RemoteFile(graphUrl), {
  haplotypeIndex: new RemoteFile(indexUrl),
})
```

This is how a database someone else publishes gets haplotype names without
anyone rehosting it: HPRC publishes `hprc-v2.1-mc-grch38.gbz.db` (10 GB) beside
its graphs, and the companion for it is built from the 5 GB GBZ. The companion
records the graph's path and node counts and the reader refuses one built for a
different graph.

`HaplotypeSamples` holds one GBWT position every `--interval` bp along every
path in both orientations, with the path handle and the forward coordinate of
that node, and `HaplotypeLengths` holds each path's length. `HaplotypeAnchors`
names one anchor node per multiple of `--anchor-spacing` along every path the
database indexes for random access (its reference paths): the path's first node
for the multiple 0, and otherwise the node with the most GBWT positions among
those overlapping the half spacing before the multiple, so it is a node most
haplotypes of that stretch pass rather than whichever node happens to contain
the multiple, which in a variable region can be a rare allele. Every path's
visit through an anchor node is written to `HaplotypeSamples` as well, in both
orientations, so the rows at one node list every haplotype passing that point of
the reference with its own coordinate. On the HPRC v2.1 graph at the default
131,072 bp that is 45,557 anchors over the 292 GRCh38 and CHM13 paths, and the
companion grows from 7.0 to about 7.9 GB. `--anchor-spacing 0` writes none, and
the `Tags` table records the spacing and the rule. The upstream `query` binary
keeps working on the augmented database. Both orientations are needed: about
half the contigs of a graph like HPRC's are stored against their reference, and
a walk of one of those meets no sample from a forward-only index. `GBZBase.open`
refuses an index the tool wrote with `--forward-only` (its
`haplotype_index_orientations` tag says `forward`) with `ForwardOnlyIndexError`,
so the half-named result never reaches a caller.

At query time `subgraph.identifyPaths()` loads the samples for the window's
nodes with one index scan per run of consecutive node ids (a window whose nodes
sit in far-apart id ranges, as a tandem repeat's do, is not one scan across the
gap), chains each haplotype's fragments to the next through the private nodes
between them, and for a chain that met no sample inside the window walks on
until it finds one, up to four intervals past the last fragment it linked. This
is what fills in the `resolved` half of a feature: PanSN name, haplotype
interval in that contig's coordinates, and the path handle.
`getAlignmentsForRange` and `getSubgraphForRange` run it for you when the
database has the tables; on the lower-level path you call it yourself before
`alignments()` or `toSubgraphJson({ names: 'resolved' })`. On the command line,
`--resolve` and `--alignments`.

A query with `keep` on a companion that carries anchors takes a different route,
and `--stats` reports it as the anchored walk. The reader looks up the anchor
for the multiple of the spacing at or before the window, walks the reference
from that node to a little past the window to learn which nodes are the
reference's and where, reads the rows at the anchor node, and for each row whose
path the predicate wants walks that path with `lf()` from its own position
through the window, so its identity and coordinate come from the row and no
chain walk or index scan is needed. A path through a duplicated stretch has
several rows at the anchor node, one per visit, and only one visit is followed
by the window: the reader tries the visit whose row sits nearest the reference's
own first (GBWT rows are ordered by the sequence before them) and stops at the
first that goes through, so HG01109#1's second amylase copy costs nothing where
it used to walk 30,000 steps to the bound. A wanted contig with no row at the
anchor, because it bypasses that node or starts inside the window, is found the
way the sampled route finds every haplotype, from its per-path samples on the
window's nodes: one sample of the orientation that runs with the reference (both
are indexed, and the other would walk out of the window backwards) is followed
back to the reference before the window and the walk starts there. When a walk
cannot be completed, the whole window falls back to the sampled route and
`--stats` says why. A companion without `HaplotypeAnchors` takes the sampled
route and trims it, as does `haplotypes: 'distinct'`.

A named walk in GFA or JSON output lists its steps in the haplotype's own
direction, whichever twin of the walk the extraction kept, so `start..end` and
the steps agree as the W line spec requires. `keepHaplotypes(name => ...)`
narrows an identified subgraph to the reference walk and the walks whose PanSN
name the predicate accepts, dropping every node only the other walks visited; it
is what the range queries' `keep` option calls, and on the command line
`--keep SAMPLE` or `--keep SAMPLE#HAP` (repeatable). This is how a cut for a
chosen set of haplotypes is written once and drawn as it is.

The tests check every resolved fragment against an independent backward walk
through the bidirectional GBWT to the path's recorded start position.

## Technical notes

It answers the same subgraph queries as `gbz-base query`, reading only the
SQLite pages a query touches, so a multi-gigabyte database on an HTTP server is
queried through range requests without downloading it or compiling anything to
WebAssembly.

No SQLite library is involved. The reader walks the SQLite b-trees directly
(rowid lookups, index seeks, overflow chains) and decodes the GBWT node records
the same way gbwt-rs does. Databases are produced by unmodified upstream
`gbz-base construct`.

## Fidelity

`test/data/oracle/` holds JSON written by upstream `gbz-base query` for the
queries listed in `queries.txt`, over databases built from gbwt-rs's test graphs
(`micb-kir3dl1.gbz`, a 46-sample HPRC slice; `example.gbz`; `example-v3.gbz`).
The test suite requires this library's output to be deep equal to every one of
them, CIGAR strings included. `generate.sh` regenerates the oracle with an
upstream binary.

Not ported: GAF-base.

CIGARs are computed by matching each shared node to its earliest usable
occurrence on the reference walk, which is weight-optimal whenever every shared
node can be placed in order; the Myers-based weighted LCS from gbwt-rs runs only
for the fragments where that fails (inversions, repeats). The two can pick
different equal-weight alignments only when the reference walk repeats a node.

One deliberate departure: where a reference walk is stored against node
orientation (upstream prints "the reference path is not in canonical
orientation" there), every other walk comes out in the opposite orientation, and
upstream aligns them handle for handle, giving all-insertion CIGARs against the
reference despite the nodes being shared. This reader aligns each walk in
whichever orientation shares more sequence with the reference and reports `-` on
such records. CHM13 on HPRC chr20 has one such region, right after the fragment
starting at 30368374.

## Measured

Against a 134 MB HPRC chr20 `.gbz.db` served over HTTPS,
`--sample GRCh38 --contig chr20`:

| window | context | nodes | haplotype fragments | range requests | bytes read | time  |
| ------ | ------- | ----- | ------------------- | -------------- | ---------- | ----- |
| 500 bp | 0       | 17    | 11                  | 7              | 459 KB     | 1.4 s |
| 10 kb  | 0       | 627   | 1021                | 8              | 524 KB     | 2.1 s |
| 100 kb | 0       | 2051  | 3673                | 13             | 852 KB     | 1.7 s |
| 10 kb  | 100 bp  | 1086  | 35                  | 9              | 590 KB     | 0.8 s |

Most of the wall time in the small queries is sequential request latency, not
decoding.

## Footnote

Started from ideas at MemPanG 26! Earlier work considered WASM cross compilation
of the rust code but gbwt-rs and simple-sds serialize `usize` at native width,
so their wasm32 builds misread files written on 64-bit hosts, and the maintainer
declined a 32-bit port. wasm64 fixes that for gbwt-rs but cannot carry gbz-base,
whose bundled SQLite has no wasm64 libc. A TypeScript reader has neither problem
and runs in a JBrowse RPC worker with the file access layer JBrowse already has.
