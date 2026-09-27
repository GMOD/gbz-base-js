# How a query flows

<img src="img/dataflow.svg" alt="gbz-base-js data flow" width="620">

The diagram's source is [dataflow.dot](img/dataflow.dot);
[CONTRIBUTING.md](../CONTRIBUTING.md) describes how to re-render it.

The main path through the diagram is `getAlignmentsForRange`.
`getSubgraphForRange`, the second entry point at the top, runs the same steps
down to `extractPaths` and returns the `Subgraph` without aligning it.

## The steps

**`pathFragmentsForRange`** finds the fragments of the named path that overlap
the window, since a contig can be stored as several path fragments with gaps
between them. `getAlignmentsForRange` concatenates the records from each.

**`pathPosition`** finds the path row and seeks `ReferenceIndex` for the GBWT
position at the window's start, where the reference walk begins. A path that
exists but was never indexed for random access throws here.

**Prefetching the reference walk** makes one range request per run of nearby
node ids, instead of one per node record the walk is about to read. A reference
walk can cross gaps of millions of node ids (AMY1's crosses two), so the
prefetch takes a handful of requests.

**`aroundInterval`** walks the reference from that position for the window's
length, then adds `context` bp of graph around it, breadth-first from both sides
of every node. `context` and `limit` bound this step, and the `Subgraph` caches
the node records it reads for every later step.

**`extractSnarls`** runs with the `snarls` option and adds whole snarls, using
the top-level chain links stored in the database ([snarls.md](snarls.md)).

**`extractPaths`** decodes the GBWT records of the nodes already read and
enumerates every walk crossing them. The walks have no names at this point,
which is as far as upstream goes, and why upstream prints `unknown#N`.

**`alignments()`** aligns each walk to the reference walk and joins the pieces
of one haplotype into a record ([alignments.md](alignments.md)).

## The two naming routes

The diagram branches in the middle, where the reader names the walks. The
sampled route reads the whole graph in the window, and the anchored route reads
only a chosen set of haplotypes.

- **Sampled.** `identifyPaths` scans `HaplotypeSamples` for the window's nodes,
  one scan per run of consecutive node ids, and chains each haplotype's
  fragments together, naming every walk in the window. A query without `keep`
  takes this route.
- **Anchored.** With `keep` and a companion carrying anchors,
  `walkHaplotypesFromAnchor` reads the rows at one anchor node before the window
  and walks only the kept paths forward from it. Nothing else is extracted or
  named, so the query's cost follows the size of the set.

The anchored route falls back to the sampled one for the whole window when a
walk cannot be completed, and `--stats` reports which route ran and why it fell
back. [haplotype-index.md](haplotype-index.md#the-sampled-walk) describes both
routes, and [performance.md](performance.md#keeping-a-set-of-haplotypes)
measures them.

## Storage

Every row those steps read comes from a b-tree descent over pages the pager
caches, and each `ByteSource.read` under the pager is one HTTP range request. No
layer above the pager distinguishes a local file from 10 GB on a server.

The graph database and the haplotype companion each get a separate pager and
source, so `--stats` reports their requests and bytes separately.

A query reads a few hundred KB of pages out of a multi-gigabyte database, so
sequential request latency takes most of its wall-clock time. That latency is
the reason for the prefetch step, and the reason the numbers in
[performance.md](performance.md) improve so much once a window's pages are
cached.
