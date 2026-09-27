# API

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

| option           | description                                     |
| ---------------- | ----------------------------------------------- |
| `haplotypeIndex` | companion database with the haplotype tables    |
| `blockSize`      | bytes fetched per page block, 64 KiB by default |
| `maxBlocks`      | blocks cached per database, 256 by default      |

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
`{ sample, haplotype, contig }`. Both queries name the walks when the database
has a haplotype index.

| option       | description                                                          |
| ------------ | -------------------------------------------------------------------- |
| `context`    | bp of graph around the window, 100 by default                        |
| `haplotypes` | `all` (default), `distinct`, `reference-only` or `none`              |
| `keep`       | predicate over each walk's `PathName`; needs a haplotype index       |
| `limit`      | maximum nodes per path fragment                                      |
| `snarls`     | `contained` or `overlapping` ([snarls.md](snarls.md)), subgraph only |
| `signal`     | `AbortSignal`, checked between range requests                        |

`haplotypes: 'distinct'` merges identical walks into one record with a `weight`.
`getAlignmentsForRange` accepts `all` and `distinct`.

`keep` reduces the window to the reference, the accepted walks and the nodes
they visit
([haplotype-index.md](haplotype-index.md#keeping-a-set-of-haplotypes)).

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

`names: 'resolved'` uses the names from `identifyPaths()`.
`subgraph.pairAlignments` aligns haplotypes to each other
([alignments.md](alignments.md#one-haplotype-against-another)).

### JSON or compact

`toSubgraphJson` is upstream's `gbz-base query --format json`, field for field.
`toCompactSubgraph` holds the same subgraph in typed arrays, for sending between
workers:

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
`subgraphBetween` ([snarls.md](snarls.md#between-two-boundary-nodes)) match
`gbz-base query`. They take a window within one path fragment, and naming is a
separate step:

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

## Command line

```
gbz-base-query graph.gbz.db --sample GRCh38 --contig chr6 --interval 31500000..31501000 --cigar
gbz-base-query https://host/graph.gbz.db --contig chrM --offset 1000 --context 50 --stats
```

| flag                                    | description                                       |
| --------------------------------------- | ------------------------------------------------- |
| `--sample` / `--haplotype` / `--contig` | the path to query                                 |
| `--interval A..B` / `--offset`          | the window, in path offsets                       |
| `--node`                                | query around a node id                            |
| `--context`                             | bp of graph around the window                     |
| `--snarls` / `--extend-snarls`          | `contained` / `overlapping`                       |
| `--between 129+:160+`                   | everything between two oriented boundary handles  |
| `--haplotype-index PATH`                | companion database with the haplotype tables      |
| `--resolve` / `--alignments`            | name the walks / print alignment records          |
| `--keep SAMPLE[#HAP]`                   | keep these haplotypes, repeatable                 |
| `--cigar`                               | include CIGAR strings                             |
| `--against SAMPLE#HAP` / `--stack A,B`  | PAF against one haplotype / each against the next |
| `--no-bases`                            | PAF from shared nodes alone                       |
| `--max-gap` / `--contig-lengths`        | `maxGap` / lengths for PAF columns 2 and 7        |
| `--haplotypes` / `--limit`              | the walk set / the node cap                       |
| `--format` / `--block-size`             | output format / bytes per page block              |
| `--stats`                               | requests, bytes, and how naming went              |

## Errors

| class                   | thrown by      | means                                                                        |
| ----------------------- | -------------- | ---------------------------------------------------------------------------- |
| `SchemaVersionError`    | `GBZBase.open` | a different schema version (`found`), or `undefined` for a non-gbz-base file |
| `ForwardOnlyIndexError` | `GBZBase.open` | the companion was built with `--forward-only`; rebuild it                    |
| `SubgraphLimitError`    | any query      | `limit` reached; carries `windowBp` and `walkedBp`                           |

Other errors are plain `Error`s with a message, for example an unknown path, a
path the database has no random-access index for, `keep` without a haplotype
index, or a companion built for a different graph.
