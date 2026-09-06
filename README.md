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

// one record per haplotype fragment crossing the window
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

Both take `{ context, haplotypes, snarls, limit, signal }` and both resolve
haplotype names when the database can. `signal` is an `AbortSignal`; a query
checks it between range requests, so an abort stops the next fetch rather than
the one in flight.

### One returns records, the other a query object

`getAlignmentsForRange` hands back data, and spans path fragments — a window
crossing a boundary queries each fragment and concatenates, which is
coordinate-correct because a record's `refStart`/`refEnd` are absolute.

`getSubgraphForRange` hands back the `Subgraph` itself, because two disjoint
fragments do not merge into one graph. It answers for the first fragment
overlapping the window, clamped to it, and `subgraph.referenceInterval` says
which interval that was. It is `undefined` when the path is unknown, when no
fragment overlaps the window, or when the clamped window is empty. Use
`pathFragmentsForRange` to see the fragments yourself, and `hasPath` to ask
about a path alone.

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

`refStart`/`refEnd` are the fragment's span on the reference path you queried.
They run to node boundaries, so a record can begin before the window you asked
for and end after it. `cigar` is its alignment to that reference, computed like
upstream: a node-length-weighted LCS, with the diverging stretches scored using
vg's match, mismatch and gap parameters. `path` is the walk as node handles,
`weight` is how many identical haplotypes it stands for, and `start` is its GBWT
position, which is a property of the graph and so is stable across refetches of
the same window.

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
carried.

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
./target/release/gbz-haplotype-index --interval 4096 graph.gbz graph.gbz.db
./target/release/gbz-haplotype-index --interval 4096 --from-db graph.gbz.db
```

The second form walks the paths through the database's own node records, so a
database whose GBZ is no longer at hand can still be augmented; the two forms
write identical tables. Walking a GBZ uses every core (`--threads`).

With `--output index.db` the tool writes the same tables into a standalone
companion database instead, and the reader opens the two side by side:

```
./target/release/gbz-haplotype-index --interval 16384 --output graph.haplotype-index.db graph.gbz
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
records the graph's path count and the reader refuses one built for a different
graph.

`HaplotypeSamples` holds one GBWT position every `--interval` bp along every
path in both orientations, with the path handle and the forward coordinate of
that node, and `HaplotypeLengths` holds each path's length. The upstream `query`
binary keeps working on the augmented database.

At query time `subgraph.identifyPaths()` loads the samples for the window's node
range in one index scan, chains each haplotype's fragments to the next through
the private nodes between them, and walks at most one interval past the window
for a chain that met no sample inside it. This is what fills in the `resolved`
half of a feature: PanSN name, haplotype interval in that contig's coordinates,
and the path handle. `getAlignmentsForRange` and `getSubgraphForRange` run it
for you when the database has the tables; on the lower-level path you call it
yourself before `alignments()` or `toSubgraphJson({ names: 'resolved' })`. On
the command line, `--resolve` and `--alignments`.

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
