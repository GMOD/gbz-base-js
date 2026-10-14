# Library API

The [command line](cli.md) runs the same queries from a shell.

Every query takes one options object.

## `GBZBase.open({ source, ... })`

```ts
import { RemoteFile } from 'generic-filehandle2'
import { GBZBase } from '@gmod/gbz-base'

const db = await GBZBase.open({
  source: new RemoteFile(url),
  haplotypeIndex: new RemoteFile(indexUrl),
})
```

A source is any object with `read(length, position)`, such as `LocalFile`,
`RemoteFile` or `BlobFile` from `generic-filehandle2`. The reader takes the file
size from the SQLite header, so opening a file costs one request.

| option           | description                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `source`         | the `.gbz.db` file                                                                                                                                                             |
| `haplotypeIndex` | a source for the [haplotype index](https://github.com/GMOD/gbz-haplotype-index/blob/main/docs/haplotype-index.md) file, which `gbz-haplotype-index` writes beside the database |
| `blockSize`      | bytes fetched per page block, 64 KiB by default                                                                                                                                |
| `maxBlocks`      | blocks cached per database, 256 by default                                                                                                                                     |

## Range queries

```ts
const window = { path: 'GRCh38#0#chr6', start: 31500000, end: 31501000 }
const records = await db.getAlignments(window)
const subgraphs = await db.getSubgraphs({ ...window, context: 0 })
```

`start` and `end` are 0-based half-open offsets along `path`, which is a PanSN
`sample#haplotype#contig` string, a bare contig, or
`{ sample, haplotype, contig }`. A bare contig names the generic path
`_gbwt_ref#0#contig`. When the database was opened with a haplotype index, both
functions report the sample, haplotype and contig of every walk they return.

Offsets, `context`, `limit`, node ids and handles must be non-negative whole
numbers; a query throws on anything else.

| option       | description                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `context`    | bp of graph around the window, 100 by default                                                                    |
| `haplotypes` | `all` (default), `distinct`, `reference-only` or `none`                                                          |
| `keep`       | a predicate on `PathName`; the query returns the walks that pass it, plus the reference. Needs a haplotype index |
| `limit`      | maximum nodes in the subgraph                                                                                    |
| `snarls`     | `contained` or `overlapping` ([snarls.md](snarls.md)), subgraph only                                             |
| `signal`     | `AbortSignal`, checked between range requests                                                                    |

`haplotypes: 'distinct'` merges identical walks into one record with a `weight`.
A walk identical to the reference walk merges into the reference, so it has no
alignment record. `getAlignments` accepts `all` and `distinct`.

A query that uses the `keep` option returns the reference, the walks whose name
passes the predicate, and the nodes those walks visit
([haplotype-index.md](https://github.com/GMOD/gbz-haplotype-index/blob/main/docs/haplotype-index.md#querying-a-subset-of-the-haplotypes)).
With `distinct`, it merges the walks of the kept haplotypes, and each `weight`
counts kept haplotypes.

A contig can be stored as several fragments with gaps between them, and a
subgraph holds one reference walk. `getSubgraphs` returns one subgraph per
fragment the window overlaps, in path order, and `getAlignments` concatenates
their records. For a window inside a gap or past the end of the path they return
`[]`, and for a path the graph lacks they throw `UnknownPathError`.
`getPathFragments` lists the fragments, and `hasPath(path)` checks a path.

## Subgraph output

```ts
const gfa = await subgraph.toGFA({ cigar: true })
const json = subgraph.toSubgraphJson({ cigar: true })
const compact = subgraph.toCompactSubgraph({ cigar: true })
```

Each walk has the `sample#haplotype#contig` name that `identifyPaths()` found
for it. A walk the lookup could not identify prints as `unknown#N` like
upstream, and `names: 'anonymous'` prints every walk that way.
`subgraph.pairAlignments` aligns haplotypes to each other
([alignments.md](alignments.md#one-haplotype-against-another)).

### JSON or compact

`toSubgraphJson` writes the same fields as upstream's
`gbz-base query --format json`. `toCompactSubgraph` stores the same subgraph in
typed arrays, for sending between workers:

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

A handle is `2 * nodeId` forward or `2 * nodeId + 1` reverse. The exported
`nodeId` and `isReverse` decode one, and `encodeNode(id, orientation)` builds
one. On a 200 kb HPRC chr20 window (5,943 nodes, 178 haplotypes), the compact
form structured-clones in 1.9 ms against 295 ms for the JSON form. Transfer its
buffers with `port.postMessage(compact, compactSubgraphTransferables(compact))`.

The JSON form's walks are `SubgraphPath`s, and the compact form's
`CompactPath`s.

`compactSubgraphTransferables` returns the buffers of `nodeIds`, `edges` and
every path's `steps`. Transferring them detaches them, so the sending thread
cannot read the subgraph afterwards.

### `Subgraph` members

| member                    | description                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| `nodeCount`               | nodes in the subgraph                                                             |
| `pathCount`               | walks in the subgraph, including the reference walk                               |
| `referenceInterval`       | `{ name, start, end }` of the reference walk on its contig, or `undefined`        |
| `hasNode(id)`             | `true` when the subgraph holds node `id`                                          |
| `hasHandle(handle)`       | `true` when the subgraph holds the node of `handle`                               |
| `identifyPaths()`         | looks up each walk's haplotype in the haplotype index                             |
| `mergeDistinct()`         | merges identical walks into one with a `weight`, as `haplotypes: 'distinct'` does |
| `keepHaplotypes(wanted)`  | keeps the reference walk and the walks whose `PathName` passes `wanted`           |
| `alignments()`            | the walks aligned to the reference walk, as `getAlignments` returns them          |
| `pairAlignments(opts)`    | haplotypes aligned to each other                                                  |
| `walkSpans()`             | a `WalkSpan` of `name`, `start` and `end` for each identified walk                |
| `stableName()`            | a SHA-256 hex digest of the nodes and edges                                       |
| `toGFA(opts)`             | GFA 1.1 text, with each walk as a `W` line                                        |
| `toSubgraphJson(opts)`    | a `SubgraphJson`                                                                  |
| `toCompactSubgraph(opts)` | a `CompactSubgraph`                                                               |

`referenceInterval` is `undefined` when the subgraph has no reference walk, as
after a node query. `walkSpans` leaves out the reference walk and gives each
span on the haplotype's contig. `keepHaplotypes` also drops the nodes that only
the discarded walks visit. It throws when a walk has no name or the walks are
merged, so call `identifyPaths()` before it and `mergeDistinct()` after it.
`toGFA` writes the `stableName` digest as the graph name.

`toGFA`, `toSubgraphJson` and `toCompactSubgraph` take a
`SubgraphOutputOptions`:

| option  | description                                                        |
| ------- | ------------------------------------------------------------------ |
| `cigar` | writes each walk's CIGAR against the reference, `false` by default |
| `names` | `resolved` (default) or `anonymous`                                |

## Lower-level queries

Four `GBZBase` methods run the query modes of upstream's `gbz-base query`, and
of `gbz-base-query`'s `--interval`, `--offset`, `--node` and `--between`:

| method                                        | window                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `subgraphInInterval({ path, start, end })`    | an interval within one path fragment                                               |
| `subgraphAtOffset({ path, offset })`          | `context` bp around one offset                                                     |
| `subgraphAroundNodes({ nodeIds })`            | `context` bp around node ids                                                       |
| `subgraphBetween({ startHandle, endHandle })` | every node between two handles ([snarls.md](snarls.md#between-two-boundary-nodes)) |

Each returns walks with no haplotype attached, so call `identifyPaths()`
afterwards to look the haplotypes up in the haplotype index.
`subgraphInInterval` also takes `keep`, and then returns named walks:

```ts
const subgraph = await db.subgraphInInterval({
  path: { sample: 'GRCh38', contig: 'chr6' },
  start: 31500000,
  end: 31501000,
  context: 0,
})
await subgraph.identifyPaths()
```

`offset` is a 0-based offset along `path`, `nodeIds` is an array of node ids,
and `startHandle` and `endHandle` are the handles of the two boundary nodes.
`subgraphAroundNodes` and `subgraphBetween` take `haplotypes` as a
`NodeHaplotypeOutput`, which leaves out `reference-only`. `subgraphBetween`
takes no `context` or `snarls`.

`db.fetchStats()` reports the range requests and bytes each file has cost.

## Overview

The subgraph of 3 Mb of chr22 costs about 70 requests and 17 MB, so a window of
megabases, or a whole chromosome, is too much graph to read. For such views the
haplotype index holds an overview, which `haplotypeOverview` reads in about 7
requests whatever the window:

```ts
const overview = await db.haplotypeOverview({
  path: { sample: 'GRCh38', contig: 'chr22' },
  start: 0,
  end: 50818468,
  bpPerPixel: 25000,
})
```

The index holds the overview at zoom levels a factor of four apart, from
`--overview-bin` bp (4,096 by default). The query takes the coarsest level whose
bins are no larger than `bpPerPixel`, or `level` directly, clamped to the levels
the index holds. It checks a `signal` option between range requests, as the
queries above do. The result is `undefined` when the index has no overview, or
none for this path, which is then not a reference path of a sample with anchors.
Otherwise:

| field        | holds                                                                                                                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`      | the level chosen                                                                                                                                                                                                                                                                                                       |
| `bin`        | its bin size in bp                                                                                                                                                                                                                                                                                                     |
| `haplotypes` | every haplotype of the graph as `{ sample, haplotype }`, in the order of the cells                                                                                                                                                                                                                                     |
| `bins`       | the bins the window touches: `start` and `end` on the path, `classes` as the count of haplotypes that are absent, reference-like, partial and variant there, `excursions` and `variants` as the number of stretches off the reference that start in the bin, the latter of 50 bp or more, and `longestExcursion` in bp |
| `cells`      | a `Uint8Array` of `bins.length × haplotypes.length` entries, bin by bin: the class in the low two bits (`OVERVIEW_ABSENT`, `OVERVIEW_REFERENCE`, `OVERVIEW_PARTIAL`, `OVERVIEW_VARIANT`), and for a variant cell a bucket of how many variant marks the bin holds in the next two: 1, 2 to 3, 4 to 15, 16 or more      |

A haplotype is absent from a bin when none of its contigs covers it, partial
when they cover less than nine tenths of it, variant when one of them leaves the
reference for 50 bp or more there, turns against its own direction along the
reference, steps back or jumps to another reference path, and reference-like
otherwise; a contig aligned on either strand is an alignment. The whole of chr22
for the 464 HPRC haplotypes at 16 kb bins is 3,102 bins, 1.4 MB.
[`tools/overview/`](../tools/overview/README.md) draws it, to a PNG from Node or
on a canvas in a page, with the requests each view costs.

## Paths and metadata

| member                                   | returns                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `paths()`                                | every path of the graph as a `GbzPath`, read once and cached                |
| `hasPath(path)`                          | `true` when the graph has a path of that name                               |
| `getPathFragments({ path, start, end })` | the `PathFragment` objects of `path` that overlap the window, in path order |
| `tags()`                                 | the database's `Tags` table as a `Map`                                      |
| `tag(key)`                               | one value of the `Tags` table, or `undefined`                               |
| `graphName()`                            | the graph's name and relationships as a `GraphName`                         |
| `hasChainLinks()`                        | `true` when the `chain_links` tag is above 0 ([snarls.md](snarls.md))       |
| `hasHaplotypeIndex`                      | `true` when `open` received a `haplotypeIndex`                              |
| `fetchStats()`                           | `{ graph, haplotypeIndex }`, each a `FetchStats`                            |

A `FetchStats` counts the reads sent to the source in `fetches` and the bytes
they returned in `bytesFetched`. `haplotypeIndex` is `undefined` when the
database was opened without one.

A `GbzPath` has three fields: `handle` is the path's row in the `Paths` table,
`name` is a `PathName`, and `isIndexed` is `true` when the database holds a
random-access index for the path. A `PathFragment` has the fragment's `path`,
and its `start` and `end` on the contig.

| `PathName` field | holds                                                              |
| ---------------- | ------------------------------------------------------------------ |
| `sample`         | the sample name, `GENERIC_SAMPLE` (`_gbwt_ref`) for a generic path |
| `haplotype`      | the haplotype number                                               |
| `contig`         | the contig name                                                    |
| `fragment`       | the offset on the contig of the fragment's first base              |

A `PathQuery` names a path by `contig`, with `sample` defaulting to
`GENERIC_SAMPLE` and `haplotype` to 0. A `PathRef` is a `PathQuery` or a name
string.

A `GraphName` holds the graph's `pggname` tag as `name`, or `undefined`, and the
`subgraph` and `translation` relationships as maps from a graph name to a set of
other graph names. `graphName()` reads them from the database tags that start
with `gbz_`, and returns an empty name when the parser rejects those tags.

## Alignments

`getAlignments` and `subgraph.alignments()` return `HaplotypeAlignment` records,
which have the fields of an `AlignmentSpan`: `refStart`, `refEnd`, `strand`,
`cigar`, `weight`, `path` and `start`.

`subgraph.pairAlignments(opts)` takes a `PairAlignmentOptions` with `target`,
`query`, `maxGap`, `minMatch` and `bases`. `target` and `query` are
`HaplotypeRef`s, `{ sample, haplotype }`, and `minMatch` is the minimum matching
bases per record, 100 by default. It returns `PairAlignment` records with
`query`, `target`, `queryStart`, `queryEnd`, `targetStart`, `targetEnd`,
`strand`, `cigar`, `matches`, `columns` and `sharedBases`, where `columns` is
the total length of the CIGAR operations.

[alignments.md](alignments.md) describes the other fields and options, and how
the library aligns walks.

The exported `pairAlignments(opts)` aligns two walks without a database
([alignments.md](alignments.md#walks-from-another-source)). Its `PairOptions`
take `query` and `target` as arrays of handles, a `sequenceOf` function that
returns the sequence of a node id, and `maxGap`, `minMatch` and `bases` as
above. It returns `PairChain` objects with `queryStart`, `queryEnd`,
`targetStart`, `targetEnd`, `strand` and `sharedBases` counted from each walk's
first base, and `edits` as a list of `PairEdit` pairs `[op, length]`, where a
`PairOp` is `=`, `X`, `I` or `D`. `pairCigar(edits)` joins the edits into a
CIGAR string.

`weightedLcs(a, b, weight)` takes two handle arrays and a function that gives a
handle's weight. It returns `[pairs, weight]`, the index pairs of the heaviest
common subsequence and its total weight.

## Errors

| class                   | thrown by      | means                                                                        |
| ----------------------- | -------------- | ---------------------------------------------------------------------------- |
| `SchemaVersionError`    | `GBZBase.open` | a different schema version (`found`), or `undefined` for a non-gbz-base file |
| `ForwardOnlyIndexError` | `GBZBase.open` | the haplotype index was built with `--forward-only`; rebuild it              |
| `UnknownPathError`      | range queries  | the graph has no path of that name; `path` holds the resolved path           |
| `SubgraphLimitError`    | any query      | `limit` reached; an interval query sets `windowBp` and `walkedBp`            |

Each error class sets `name` to the class name.

`SubgraphLimitError` counts `walkedBp` from the start of the window the caller
asked for, across every fragment before the one that reached the limit.

Other errors are plain `Error`s with a message, for example a path the database
has no random-access index for, `keep` without a haplotype index, `keep` over a
walk that the haplotype index could not name, or a haplotype index built for a
different graph.

## Exports

The package root also exports these names.

| export                                              | what it is                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `SCHEMA_VERSION`                                    | the schema version string `GBZBase.open` accepts                                               |
| `GENERIC_SAMPLE`                                    | `_gbwt_ref`, the sample of a generic path                                                      |
| `formatPathName(name)`                              | writes a `PathName` as `sample#haplotype#contig`, plus `[fragment-end]` when `name.end` is set |
| `parsePathName(name)`                               | reads a PanSN name or a bare contig into a `PathQuery`, dropping a `[start-end]` suffix        |
| `nodeOrientation(handle)`                           | the `Orientation` of a handle, `forward` or `reverse`                                          |
| `flipNode(handle)`                                  | the handle of the same node in the other orientation                                           |
| `OpenOptions`                                       | the options of `GBZBase.open`                                                                  |
| `ByteSource`                                        | an object whose `read(length, position)` resolves to a `Uint8Array`                            |
| `PathWindow`                                        | `{ path, start, end }`                                                                         |
| `QueryOptions`                                      | `context`, `haplotypes`, `snarls`, `limit` and `signal`                                        |
| `IntervalQuery`, `WindowQuery`                      | a `PathWindow` with `QueryOptions` and `keep`, for `getSubgraphs` and `subgraphInInterval`     |
| `AlignmentQuery`                                    | the options of `getAlignments`                                                                 |
| `OffsetQuery`, `NodesQuery`, `BetweenQuery`         | the options of the other lower-level queries                                                   |
| `HaplotypeOutput`                                   | the values of `haplotypes`                                                                     |
| `SnarlOutput`                                       | the values of `snarls`: `none`, `contained` or `overlapping`                                   |
| `OverviewQuery`, `HaplotypeOverview`, `OverviewBin` | the overview query and its result                                                              |
| `Pos`                                               | a GBWT position, `{ node, offset }`                                                            |
