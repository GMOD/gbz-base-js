# API

## `GBZBase.open(source, opts?)`

```ts
import { RemoteFile } from 'generic-filehandle2'
import { GBZBase } from '@gmod/gbz-base'

const db = await GBZBase.open(new RemoteFile(url), {
  haplotypeIndex: new RemoteFile(indexUrl),
})
```

| option           | description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `haplotypeIndex` | companion database carrying the haplotype tables, as a source |
| `blockSize`      | bytes fetched per page block, 64 KiB by default               |
| `maxBlocks`      | blocks kept cached per database, 256 by default               |

Any object with `read(length, position)` and `stat()` works as a source, so
`LocalFile`, `RemoteFile` and `BlobFile` from `generic-filehandle2` all do.
Pages are fetched in blocks and cached, so a query reads only the parts of the
database it touches.

`open` refuses a companion built for a different graph — it records the graph's
path and node counts — and refuses a forward-only index with
`ForwardOnlyIndexError`. Both are described in
[haplotype-index.md](haplotype-index.md).

## Range queries

`getAlignmentsForRange(path, start, end, opts?)` and
`getSubgraphForRange(path, start, end, opts?)` take 0-based half-open offsets
along the path you named, so `('GRCh38#0#chr6', 31500000, 31501000)` is the same
window `gbz-base query --interval 31500000..31501000` gives.

The path is a PanSN `sample#haplotype#contig` string, or a bare contig for a
graph whose reference paths have no sample. `{ sample, haplotype, contig }`
works too, and `parsePathName` is the parser if you want it separately.

| option       | description                                                      |
| ------------ | ---------------------------------------------------------------- |
| `context`    | bp of graph context past the window, 100 by default              |
| `haplotypes` | which walks to extract, `all` by default (see below)             |
| `keep`       | predicate over each walk's `PathName`, needs the haplotype index |
| `limit`      | cap the subgraph at this many nodes, per fragment                |
| `snarls`     | `contained` or `overlapping`, `getSubgraphForRange` only         |
| `signal`     | `AbortSignal`, checked between range requests                    |

Both resolve haplotype names when the database can.

`haplotypes` is upstream's set of four. `all` keeps every walk crossing the
window and `distinct` merges the identical ones into one record carrying their
`weight` — those two are the ones `getAlignmentsForRange` accepts, since they
are the outputs that leave something to align against the reference.
`reference-only` drops every walk but the reference (it throws where there is no
reference to keep, as in a node query) and `none` extracts no walks at all,
leaving a subgraph of nodes and edges; both are subgraph outputs.

`keep` narrows the window to the reference walk, the walks it accepts and the
nodes those walks visit, so a query for a chosen set draws that set's private
sequence and nothing else's. It needs the haplotype index and throws without
one; what it costs, and the anchored route it takes on a companion carrying
anchors, is in [haplotype-index.md](haplotype-index.md#the-anchored-walk).

`context` does not decide how many records come back, since the pieces of a walk
that leaves the subgraph are joined again; it trades nodes read against pieces
to identify and join. [performance.md](performance.md#context) has the
measurements for picking it.

`signal` is checked between range requests, so an abort stops the next fetch
rather than the one in flight.

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

## Alignment records

`getAlignmentsForRange` returns one record per haplotype crossing the window:

```ts
for (const alignment of alignments) {
  const { refStart, refEnd, strand, cigar } = alignment
  if (alignment.resolved) {
    console.log(alignment.label, alignment.hapStart, alignment.hapEnd)
  }
}
```

The fields, how pieces of one walk are joined into a record, and what `resolved`
means are in [alignments.md](alignments.md).

## Subgraph output

```ts
const gfa = await subgraph.toGFA({ cigar: true, names: 'resolved' })
const json = subgraph.toSubgraphJson({ cigar: true, names: 'resolved' })
const compact = subgraph.toCompactSubgraph({ cigar: true, names: 'resolved' })
```

All three take the same options. `names: 'resolved'` needs `identifyPaths()` to
have run — the range queries run it for you when the database has the tables.
`keepHaplotypes(predicate)` narrows an identified subgraph the way the `keep`
option does. A named walk lists its steps in the haplotype's own direction,
whichever twin of the walk the extraction kept, so `start..end` and the steps
agree as the W line spec requires.

### Which of the two to take

`toSubgraphJson` is upstream's shape, field for field —
`gbz-base query --format json` output, held to it by the
[oracle tests](internals.md#fidelity-to-upstream). Take it when something
downstream already parses that format, and do not expect it to change.

`toCompactSubgraph` is this package's own shape and carries the same subgraph as
typed arrays:

```ts
interface CompactSubgraph {
  nodeIds: Int32Array // ascending
  nodeSequences: string[] // parallel to nodeIds
  edges: Int32Array // handle pairs, edges[2i] -> edges[2i + 1]
  paths: {
    name: string
    weight: number | undefined
    cigar: string | undefined
    steps: Int32Array // handles
  }[]
}
```

A step, and either end of an edge, is a **GBWT handle**: `2 * nodeId` forward,
`2 * nodeId + 1` reverse. The exported `nodes` helpers read the halves back:

```ts
import { nodes } from '@gmod/gbz-base'

for (const handle of compact.paths[1].steps) {
  console.log(nodes.nodeId(handle), nodes.isReverse(handle))
}
```

The upstream shape spends an object and a stringified id on every step of every
walk, and a 200 kb human window has about 350,000 of them. That is affordable to
build and ruinous to move: sending one across a worker boundary is a structured
clone of every one of those objects. Measured on HPRC chr20, `CHM13#0#chr20`
30.0–30.2 Mb, 5,943 nodes and 178 haplotypes, with CIGARs:

|                   | `toSubgraphJson` | `toCompactSubgraph` |
| ----------------- | ---------------- | ------------------- |
| build             | 99 ms            | 71 ms               |
| `structuredClone` | 295 ms           | 1.9 ms              |

Most of the 71 ms both pay is CIGAR generation; drop `cigar` and the compact
build is about 8 ms. For a `postMessage` the buffers can be transferred rather
than copied:

```ts
import { compactSubgraphTransferables } from '@gmod/gbz-base'

port.postMessage(compact, compactSubgraphTransferables(compact))
```

Transferring detaches the buffers, so the sending side must not read the
subgraph afterwards.

### Why only the steps are packed

bam-js hands back `NUMERIC_SEQ` and `NUMERIC_CIGAR` — the packed bytes as the
file holds them — and derives the strings lazily, because a nanopore read is
long enough that decoding one to compare twenty positions is waste. The same
trick was measured here on both remaining fields and is not worth it, because
what makes it pay is a _long_ per-record field and only the step list is long:

| field  | size here                 | packed  | strings | verdict              |
| ------ | ------------------------- | ------- | ------- | -------------------- |
| steps  | 346,993 per window        | 1.9 ms  | 295 ms  | packed, 155x         |
| CIGARs | 323 chars avg, 17,555 ops | 0.20 ms | 0.09 ms | strings clone faster |
| seqs   | 34 bp avg, 5,943 nodes    | 1.07 ms | 0.95 ms | about even           |

Node sequences pack 2.86x smaller, but a consumer drawing the graph wants the
string for every node anyway, and CIGARs packed into one `Int32Array` per path
clone _slower_ than the strings — 178 small typed arrays cost more than 178
strings. So `nodeSequences` and `cigar` stay strings, and the CIGAR phase is 103
ms of computing edits against 2 ms of building the string, which is not a
representation problem at all.

## Lower-level queries

The two range queries cover the interval query and hide where a contig is stored
split into path fragments. The four query functions underneath are what
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
```

`subgraphAtOffset` and `subgraphAroundNodes` are the other two;
`subgraphBetween` is described in [snarls.md](snarls.md). They throw for a
window that runs past the end of a path fragment, where `getAlignmentsForRange`
clamps.

## Command line

The command line mirrors the upstream tool for the query types it supports:

```
gbz-base-query graph.gbz.db --sample GRCh38 --contig chr6 --interval 31500000..31501000 --cigar
gbz-base-query https://host/graph.gbz.db --contig chrM --offset 1000 --context 50 --stats
```

| flag                                    | description                                      |
| --------------------------------------- | ------------------------------------------------ |
| `--sample` / `--haplotype` / `--contig` | the path to query                                |
| `--interval A..B` / `--offset`          | the window, in path offsets                      |
| `--node`                                | query around a node id instead of a path offset  |
| `--context`                             | bp of graph context past the window              |
| `--snarls` / `--extend-snarls`          | `contained` / `overlapping`                      |
| `--between 129+:160+`                   | everything between two oriented boundary handles |
| `--haplotype-index PATH`                | companion database with the haplotype tables     |
| `--resolve` / `--alignments`            | name the walks / emit alignment records          |
| `--keep SAMPLE[#HAP]`                   | restrict to these haplotypes, repeatable         |
| `--cigar`                               | include CIGAR strings in the output              |
| `--haplotypes` / `--limit`              | the walk set / the node cap                      |
| `--format` / `--block-size`             | output format / bytes per page block             |
| `--stats`                               | report requests, bytes and the route taken       |

## Reading the stats

`--stats` reports how many range requests a query made and how many bytes they
carried, and with `--resolve` or `--alignments` how identification went: index
scans, chains per haplotype, why each chain ended, companion seeks against graph
record lookups, and fragment lengths against the walk bound.

## Errors

Three error classes are exported, for the conditions worth catching by type
rather than by message:

| class                   | thrown by      | means                                                |
| ----------------------- | -------------- | ---------------------------------------------------- |
| `SchemaVersionError`    | `GBZBase.open` | not a gbz-base database, or not this reader's schema |
| `ForwardOnlyIndexError` | `GBZBase.open` | the companion was built with `--forward-only`        |
| `SubgraphLimitError`    | any query      | `limit` was reached before the window was covered    |

`SchemaVersionError.found` is the version string the database carried, or
`undefined` when its `Tags` table had none — the difference between a database
built by a different gbz-base and a file that is not one at all.
`SCHEMA_VERSION` is the string this reader understands, exported beside it.

`ForwardOnlyIndexError` is refused at open rather than at query time, because a
forward-only index cannot name the walks stored against their reference — about
half of them in a graph like HPRC's — and a half-named result should never reach
a caller. Rebuild the companion without `--forward-only`.

`SubgraphLimitError` carries the `limit` it hit, and for an interval query the
`windowBp` asked for against the `walkedBp` covered before it stopped, so a
caller can tell a limit that was slightly too low from one that stopped in the
first percent of a window inside a huge snarl. Raising `limit`, or narrowing
`snarls: 'overlapping'`, is the fix.

Everything else throws a plain `Error` with a message: a path name that matches
nothing, a path that exists but was never indexed for random access, `keep`
without a haplotype index, a companion whose path or node counts disagree with
the graph's, and a database missing a table a query needs.
