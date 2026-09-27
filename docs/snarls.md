# Snarls

A snarl is a site of variation in the graph: a region bounded by two nodes that
every haplotype crossing it enters through one and leaves through the other. A
SNP bubble is a small snarl, and a large deletion or a centromere can be a snarl
spanning megabases. Snarls nest, and a chain is a series of top-level snarls
laid end to end along the graph, each sharing a boundary node with the next.

`gbz-base construct` stores the top-level chains in the database. Each boundary
node record carries a `next` link to the boundary node at the other end of its
snarl, and the `chains` and `chain_links` tags in the `Tags` table count them. A
database without those links still answers queries, and the snarl options below
then add nothing.

## Filling snarls around a window

An interval query walks the reference for the window's length and then adds
`context` bp of graph around it, breadth-first. A bp radius is a poor fit for
variation: a radius too small cuts a bubble in half, and a radius large enough
for the largest bubble in the window reads far more than the window everywhere
else. The `snarls` option adds whole snarls instead, using the stored chain
links. The query adds them after the context step and before it extracts walks,
so the walks through a filled snarl come back like any others.

| `snarls`      | CLI               | adds                                                   |
| ------------- | ----------------- | ------------------------------------------------------ |
| `none`        |                   | nothing, the default                                   |
| `contained`   | `--snarls`        | every top-level snarl with both boundary nodes in view |
| `overlapping` | `--extend-snarls` | also snarls with one boundary node in view, see below  |

Filling a top-level snarl adds every node between its two boundaries, so the
snarls nested inside it come along.

On the `micb-kir3dl1` test database, the 1 kb window `GRCh38#0#chr6`
31,500,000-31,501,000 extracts:

| `context` | `snarls`    | nodes | walks |
| --------- | ----------- | ----- | ----- |
| 0         | `none`      | 31    | 468   |
| 0         | `contained` | 47    | 91    |
| 100       | `none`      | 54    | 91    |
| 100       | `contained` | 54    | 91    |

With `context: 0` the window holds only the reference walk's nodes, so each
haplotype that leaves the reference inside it comes back as several pieces: 468
walks from 91 haplotype passages. `contained` restores the 16 nodes of the
bubbles the reference skips, and each haplotype then crosses the window as one
walk. At `context: 100` the radius already covers those bubbles and `contained`
adds nothing. The `chr19` window 54,817,000-54,818,000 behaves the same way: 46
nodes and 690 walks at `context: 0`, 67 nodes and 78 walks with `contained`.

`overlapping` goes further in two cases. When a boundary node in view is the
entry to a snarl whose other boundary lies outside the subgraph, it fills that
snarl too. When the subgraph holds no chain link at all, because it sits wholly
inside one snarl, it searches outward for the snarl containing it and fills
that. A node query for node 200 on the same database returns 1 node with `none`
or `contained` and 6 with `overlapping`. A snarl can be far larger than the
window, so pair `overlapping` with `limit`; a query that reaches the limit
throws `SubgraphLimitError`.

A node query with more than one node rejects `overlapping`, as upstream does,
because the nodes need not form one connected subgraph.

```ts
const subgraph = await db.getSubgraphForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
  { context: 0, snarls: 'contained' },
)
```

```
gbz-base-query graph.gbz.db --sample GRCh38 --contig chr6 \
  --interval 31500000..31501000 --context 0 --snarls
```

## Where the options apply

`getSubgraphForRange` and the lower-level `subgraphInInterval`,
`subgraphAtOffset` and `subgraphAroundNodes` take `snarls`.
`getAlignmentsForRange` does not, and its type rejects the option: it joins the
pieces of a haplotype that leaves the subgraph back into one record, so filling
snarls would change how many pieces it joins and not the records it returns
([alignments.md](alignments.md#one-record-is-one-haplotypes-passage)).

A `keep` query on a companion with anchors takes the anchored route, which walks
each kept haplotype through the window from an anchor and never consults the
chain links, so `snarls` has no effect there. If that route falls back to the
sampled one, the fallback honours `snarls`
([haplotype-index.md](haplotype-index.md#the-anchored-walk)).

## Between two boundary nodes

`subgraphBetween(db, start, end)` is upstream's `--between`. It collects the two
boundary nodes and every node reachable from them inward without passing through
either boundary, with no context and no reference walk, then extracts the walks
through those nodes. `start` and `end` are oriented GBWT handles, `2 * nodeId`
forward and `2 * nodeId + 1` reverse, and normally the two boundaries of one
snarl or of a stretch of one chain.

```ts
import { nodes, subgraphBetween } from '@gmod/gbz-base'

const subgraph = await subgraphBetween(
  db,
  nodes.encodeNode(129, 'forward'),
  nodes.encodeNode(160, 'forward'),
)
```

```
gbz-base-query graph.gbz.db --between 129+:160+
```

On `micb-kir3dl1`, `129+:160+` gives 32 nodes and `154-:150-` gives 5.
`subgraphBetween` takes `haplotypes`, `limit` and `signal`, and rejects
`haplotypes: 'reference-only'` because it has no reference walk to keep. It does
not name the walks; call `identifyPaths()` on the result, as with the other
[lower-level queries](api.md#lower-level-queries).
