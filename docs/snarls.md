# Snarls

A snarl is a site of variation: a region between two boundary nodes that every
haplotype crossing it enters and leaves through. A SNP bubble is a small snarl;
a large deletion can be a snarl spanning megabases. A chain is a series of
top-level snarls laid end to end. `gbz-base construct` stores the top-level
chains as links between boundary nodes.

## The `snarls` option

`context` extends a window by a bp radius. The `snarls` option extends it by
whole snarls instead, using the stored chains.

| `snarls`      | CLI               | adds                                                                            |
| ------------- | ----------------- | ------------------------------------------------------------------------------- |
| `contained`   | `--snarls`        | every top-level snarl with both boundary nodes in view                          |
| `overlapping` | `--extend-snarls` | also snarls with one boundary in view, or the snarl containing the whole window |

A top-level snarl includes every snarl nested inside it.

```ts
const subgraph = await db.getSubgraphForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
  {
    context: 0,
    snarls: 'contained',
  },
)
```

On the `micb-kir3dl1` test database, the 1 kb window above returns these counts:

| `context` | `snarls`    | nodes | walks |
| --------- | ----------- | ----- | ----- |
| 0         | `none`      | 31    | 468   |
| 0         | `contained` | 47    | 91    |
| 100       | `none`      | 54    | 91    |

With `context: 0` the window holds only the reference's nodes, so the query
returns each haplotype that leaves the reference as several pieces: 468 walks
for 91 haplotypes. `contained` adds the 16 nodes of the skipped bubbles, and the
query returns each haplotype as one walk.

A snarl can be far larger than the window, so pair `overlapping` with `limit`.

`getSubgraphForRange` and the lower-level `subgraphInInterval`,
`subgraphAtOffset` and `subgraphAroundNodes` take `snarls`. A query that uses
the `keep` option takes it too, and returns the walks of the same subgraph for
the chosen haplotypes.

## Between two boundary nodes

`subgraphBetween` returns every node between two oriented node handles, usually
the boundaries of a snarl. The command-line equivalent is `--between`, as in
upstream.

```ts
import { nodes, subgraphBetween } from '@gmod/gbz-base'

const subgraph = await subgraphBetween(
  db,
  nodes.encodeNode(129, 'forward'),
  nodes.encodeNode(160, 'forward'),
)
await subgraph.identifyPaths()
```

```bash
gbz-base-query graph.gbz.db --between 129+:160+
```
