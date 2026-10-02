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

| option       | description                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `context`    | bp of graph around the window, 100 by default                                                                    |
| `haplotypes` | `all` (default), `distinct`, `reference-only` or `none`                                                          |
| `keep`       | a predicate on `PathName`; the query returns the walks that pass it, plus the reference. Needs a haplotype index |
| `limit`      | maximum nodes per path fragment                                                                                  |
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
their records. A window inside a gap or past the end of the path returns `[]`,
and a path the graph lacks throws `UnknownPathError`. `getPathFragments` lists
the fragments, and `hasPath(path)` checks a path.

## Subgraph output

```ts
const gfa = await subgraph.toGFA({ cigar: true })
const json = subgraph.toSubgraphJson({ cigar: true })
const compact = subgraph.toCompactSubgraph({ cigar: true })
```

Each walk carries the `sample#haplotype#contig` name that `identifyPaths()`
found for it. A walk the lookup could not identify prints as `unknown#N` like
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

`db.fetchStats()` reports the range requests and bytes each file has cost.

## Errors

| class                   | thrown by      | means                                                                        |
| ----------------------- | -------------- | ---------------------------------------------------------------------------- |
| `SchemaVersionError`    | `GBZBase.open` | a different schema version (`found`), or `undefined` for a non-gbz-base file |
| `ForwardOnlyIndexError` | `GBZBase.open` | the haplotype index was built with `--forward-only`; rebuild it              |
| `UnknownPathError`      | range queries  | the graph has no path of that name; carries the resolved `path`              |
| `SubgraphLimitError`    | any query      | `limit` reached; an interval query sets `windowBp` and `walkedBp`            |

`SubgraphLimitError` counts `walkedBp` from the start of the window the caller
asked for, across every fragment before the one that tripped.

Other errors are plain `Error`s with a message, for example a path the database
has no random-access index for, `keep` without a haplotype index, `keep` over a
walk that the haplotype index could not name, or a haplotype index built for a
different graph.
