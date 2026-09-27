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

A source is any object with `read(length, position)` and `stat()`, which
includes `LocalFile`, `RemoteFile` and `BlobFile` from `generic-filehandle2`.
The reader fetches pages in blocks and caches them, so a query reads only the
parts of the database it touches.

`open` refuses a companion built for a different graph, which it detects from
the path and node counts the companion records, and refuses a forward-only index
with `ForwardOnlyIndexError` ([haplotype-index.md](haplotype-index.md)).

## Range queries

`getAlignmentsForRange(path, start, end, opts?)` and
`getSubgraphForRange(path, start, end, opts?)` take 0-based half-open offsets
along the named path, so `('GRCh38#0#chr6', 31500000, 31501000)` is the window
`gbz-base query --interval 31500000..31501000` gives.

The path is a PanSN `sample#haplotype#contig` string, a bare contig for a graph
whose reference paths have no sample, or an object
`{ sample, haplotype, contig }`. `parsePathName` converts the string form to the
object.

| option       | description                                                      |
| ------------ | ---------------------------------------------------------------- |
| `context`    | bp of graph context past the window, 100 by default              |
| `haplotypes` | which walks to extract, `all` by default                         |
| `keep`       | predicate over each walk's `PathName`, needs the haplotype index |
| `limit`      | cap the subgraph at this many nodes, per fragment                |
| `snarls`     | `contained` or `overlapping`, `getSubgraphForRange` only         |
| `signal`     | `AbortSignal`, checked between range requests                    |

The range queries name the walks when the database has a haplotype index.

`haplotypes` takes upstream's four values. `all` keeps every walk crossing the
window, and `distinct` merges identical walks into one record carrying their
`weight`; `getAlignmentsForRange` accepts only these two, since the other two
leave nothing to align. `reference-only` drops every walk but the reference, and
throws where there is no reference, as in a node query. `none` extracts no walks
and leaves a subgraph of nodes and edges.

`keep` narrows the window to the reference walk, the walks the predicate
accepts, and the nodes those walks visit, so the result contains that set's
private sequence and no other. It throws without a haplotype index. On a
companion with anchors it takes a faster route
([haplotype-index.md](haplotype-index.md#the-anchored-walk)).

`context` does not change how many records `getAlignmentsForRange` returns,
because the reader joins the pieces of a walk that leaves the subgraph. A larger
`context` reads more nodes and leaves fewer pieces to identify and join
([performance.md](performance.md#context)).

`snarls` adds whole variation sites instead of a bp radius
([snarls.md](snarls.md)).

An abort through `signal` stops the next fetch; the request in flight completes.

### Records or a subgraph

A contig can be stored as several path fragments with gaps between them.
`getAlignmentsForRange` queries each fragment the window overlaps and
concatenates the records, which is safe because a record's `refStart` and
`refEnd` are offsets on the whole path.

`getSubgraphForRange` returns a `Subgraph`, and two disjoint fragments do not
merge into one graph, so it answers for the first fragment overlapping the
window, clamped to it. It returns `undefined` when the path is unknown or no
fragment overlaps the window. `subgraph.referenceInterval` is the reference walk
the subgraph holds; it runs to node boundaries and through `context`, so it is
wider than the window on both sides. `pathFragmentsForRange` returns the
fragment bounds, and `hasPath` checks whether a path exists.

A path that exists but was never indexed for random access throws, because the
database needs rebuilding to answer it.

## Pair alignments

`getAlignmentsForRange` returns one record per haplotype passage, aligned to the
reference ([alignments.md](alignments.md)). `subgraph.pairAlignments` aligns the
window's walks to a chosen haplotype instead
([alignments.md](alignments.md#one-haplotype-against-another)).

| option   | description                                                              |
| -------- | ------------------------------------------------------------------------ |
| `target` | `{ sample, haplotype }` to align to                                      |
| `query`  | `{ sample, haplotype }` to align, every other named walk if unset        |
| `maxGap` | cap on the private bp a record skips on either walk, none by default     |
| `bases`  | whether to compare the bases between two shared nodes, `true` by default |

## Subgraph output

```ts
const gfa = await subgraph.toGFA({ cigar: true, names: 'resolved' })
const json = subgraph.toSubgraphJson({ cigar: true, names: 'resolved' })
const compact = subgraph.toCompactSubgraph({ cigar: true, names: 'resolved' })
```

The three output methods take the same options. `names: 'resolved'` needs
`identifyPaths()` to have run, and the range queries run it when the database
has a haplotype index. `keepHaplotypes(predicate)` narrows an identified
subgraph the way the `keep` option does. A named walk lists its steps in the
haplotype's own direction, so its `start..end` and its steps agree, as the GFA W
line requires.

### JSON or compact

`toSubgraphJson` writes upstream's format field for field, the output of
`gbz-base query --format json`, and the
[oracle tests](internals.md#fidelity-to-upstream) hold it to that. Use it when
something downstream already parses the format.

`toCompactSubgraph` writes this package's own format, the same subgraph as typed
arrays:

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

A step, and each end of an edge, is a **GBWT handle**: `2 * nodeId` forward,
`2 * nodeId + 1` reverse. The exported `nodes` helpers split a handle:

```ts
import { nodes } from '@gmod/gbz-base'

for (const handle of compact.paths[1].steps) {
  console.log(nodes.nodeId(handle), nodes.isReverse(handle))
}
```

The upstream format has an object with a stringified id for every step of every
walk, about 350,000 of them in a 200 kb human window, and sending it to another
worker structured-clones every one. On HPRC chr20, `CHM13#0#chr20` 30.0-30.2 Mb,
5,943 nodes and 178 haplotypes, with CIGARs:

|                   | `toSubgraphJson` | `toCompactSubgraph` |
| ----------------- | ---------------- | ------------------- |
| build             | 99 ms            | 71 ms               |
| `structuredClone` | 295 ms           | 1.9 ms              |

CIGAR generation takes most of the 71 ms; without `cigar` the compact build
takes about 8 ms. A `postMessage` can transfer the buffers instead of copying
them:

```ts
import { compactSubgraphTransferables } from '@gmod/gbz-base'

port.postMessage(compact, compactSubgraphTransferables(compact))
```

Transferring detaches the buffers, so the sender must not read the subgraph
afterwards. [optimizations.md](optimizations.md#the-compact-output-format)
explains why node sequences and CIGARs stay strings.

## Lower-level queries

The range queries resolve a window to path fragments and name the walks. The
four query functions underneath do what `gbz-base query` does: they take a
window within one fragment and leave naming to the caller.

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

The other two are `subgraphAtOffset` and `subgraphAroundNodes`, and
[snarls.md](snarls.md#between-two-boundary-nodes) covers `subgraphBetween`. All
four throw for a window that runs past the end of a path fragment, where the
range queries clamp.

## Command line

`gbz-base-query` mirrors the upstream tool for the query types it supports:

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
| `--against SAMPLE#HAP` / `--stack A,B`  | PAF against one haplotype / of each against next |
| `--no-bases`                            | PAF from shared nodes alone, no bases compared   |
| `--max-gap` / `--contig-lengths`        | private bp a PAF record skips / PAF cols 2 and 7 |
| `--haplotypes` / `--limit`              | the walk set / the node cap                      |
| `--format` / `--block-size`             | output format / bytes per page block             |
| `--stats`                               | report requests, bytes and the route taken       |

### `--stats`

`--stats` reports how many range requests a query made and how many bytes they
carried, separately for the graph database and the companion. With `--resolve`
or `--alignments` it also reports how naming went: index scans, chains per
haplotype, why each chain ended, companion seeks against graph record lookups,
fragment lengths against the walk bound, and which route a `keep` query took.

## Errors

The package exports three error classes for the conditions worth catching by
type:

| class                   | thrown by      | means                                                |
| ----------------------- | -------------- | ---------------------------------------------------- |
| `SchemaVersionError`    | `GBZBase.open` | not a gbz-base database, or not this reader's schema |
| `ForwardOnlyIndexError` | `GBZBase.open` | the companion was built with `--forward-only`        |
| `SubgraphLimitError`    | any query      | `limit` was reached before the window was covered    |

`SchemaVersionError.found` is the version string the database carried, or
`undefined` when its `Tags` table had none. A string means a database from a
different gbz-base version, and `undefined` means a file that is not a gbz-base
database. `SCHEMA_VERSION`, exported beside it, is the version this reader
understands.

A forward-only index has no sample for a walk on a contig stored against its
reference, which is about half the contigs in a graph like HPRC's, so `open`
throws `ForwardOnlyIndexError` instead of returning half-named results. Rebuild
the companion without `--forward-only`.

`SubgraphLimitError` carries the `limit` it hit and, for an interval query, the
`windowBp` requested and the `walkedBp` covered before it stopped. A caller can
use them to tell a limit set slightly too low from one hit early in a window
inside a huge snarl. Raise `limit`, or use `snarls: 'contained'` in place of
`'overlapping'`.

Other failures throw a plain `Error` with a message: a path name that matches
nothing, a path that exists but was never indexed for random access, `keep`
without a haplotype index, a companion whose path or node counts disagree with
the graph's, and a database missing a table a query needs.
