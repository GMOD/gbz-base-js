# Library API

The [command line](cli.md) runs the same queries from a shell.

## `GBZBase.open(source, opts?)`

```ts
import { RemoteFile } from 'generic-filehandle2'
import { GBZBase } from '@gmod/gbz-base'

const db = await GBZBase.open(new RemoteFile(url), {
  haplotypeIndex: new RemoteFile(indexUrl),
})
```

A source is any object with `read(length, position)` and `stat()`, such as
`LocalFile`, `RemoteFile` or `BlobFile` from `generic-filehandle2`.

| option           | description                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `haplotypeIndex` | a source for the [haplotype index](haplotype-index.md) file, which `gbz-haplotype-index` writes beside the database |
| `blockSize`      | bytes fetched per page block, 64 KiB by default                                                                     |
| `maxBlocks`      | blocks cached per database, 256 by default                                                                          |

## Range queries

```ts
const records = await db.getAlignmentsForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
)
const subgraph = await db.getSubgraphForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
)
```

Coordinates are 0-based half-open offsets along the path. The path is a PanSN
`sample#haplotype#contig` string, a bare contig, or
`{ sample, haplotype, contig }`. When the database was opened with a haplotype
index, both functions report the sample, haplotype and contig of every walk they
return.

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
alignment record. `getAlignmentsForRange` accepts `all` and `distinct`.

A query that uses the `keep` option returns the reference, the walks whose name
passes the predicate, and the nodes those walks visit
([haplotype-index.md](haplotype-index.md#querying-a-subset-of-the-haplotypes)).
With `distinct`, it merges the walks of the kept haplotypes, and each `weight`
counts kept haplotypes.

`getAlignmentsForRange` covers every path fragment the window overlaps.
`getSubgraphForRange` returns the subgraph for the first one, or `undefined`
when the path is unknown. `pathFragmentsForRange` lists the fragments, and
`hasPath` checks a path.

## Subgraph output

```ts
const gfa = await subgraph.toGFA({ cigar: true, names: 'resolved' })
const json = subgraph.toSubgraphJson({ cigar: true, names: 'resolved' })
const compact = subgraph.toCompactSubgraph({ cigar: true, names: 'resolved' })
```

With `names: 'resolved'`, each walk carries the `sample#haplotype#contig` name
that `identifyPaths()` found for it; without that option, or for a walk the
lookup could not identify, the walk prints as `unknown#N` like upstream.
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

A handle is `2 * nodeId` forward or `2 * nodeId + 1` reverse; the exported
`nodes.nodeId` and `nodes.isReverse` decode one. On a 200 kb HPRC chr20 window
(5,943 nodes, 178 haplotypes), the compact form structured-clones in 1.9 ms
against 295 ms for the JSON form. Transfer its buffers with
`port.postMessage(compact, compactSubgraphTransferables(compact))`.

## Lower-level queries

`subgraphInInterval`, `subgraphAtOffset`, `subgraphAroundNodes` and
`subgraphBetween` ([snarls.md](snarls.md#between-two-boundary-nodes)) are the
four query modes of upstream's `gbz-base query`, and of `gbz-base-query`'s
`--interval`, `--offset`, `--node` and `--between`. Each takes a window within
one path fragment and returns walks with no haplotype attached, so call
`identifyPaths()` afterwards to look the haplotypes up in the haplotype index:

```ts
import { subgraphInInterval } from '@gmod/gbz-base'

const subgraph = await subgraphInInterval(
  db,
  { sample: 'GRCh38', contig: 'chr6' },
  31500000,
  31501000,
  { context: 0 },
)
await subgraph.identifyPaths()
```

## Errors

| class                   | thrown by      | means                                                                        |
| ----------------------- | -------------- | ---------------------------------------------------------------------------- |
| `SchemaVersionError`    | `GBZBase.open` | a different schema version (`found`), or `undefined` for a non-gbz-base file |
| `ForwardOnlyIndexError` | `GBZBase.open` | the haplotype index was built with `--forward-only`; rebuild it              |
| `SubgraphLimitError`    | any query      | `limit` reached; carries `windowBp` and `walkedBp`                           |

Other errors are plain `Error`s with a message, for example an unknown path, a
path the database has no random-access index for, `keep` without a haplotype
index, `keep` over a walk that the haplotype index could not name, or a
haplotype index built for a different graph.
