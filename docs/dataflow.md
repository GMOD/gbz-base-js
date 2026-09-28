# How a query flows

![gbz-base-js data flow](img/dataflow.svg)

The source is [dataflow.dot](img/dataflow.dot); see
[CONTRIBUTING.md](../CONTRIBUTING.md#the-data-flow-diagram) to re-render it.

`getAlignmentsForRange` runs every step below. `getSubgraphForRange` stops after
step 7 and returns the `Subgraph`. A query that uses the `keep` option replaces
steps 6 and 7 with the keep route, which finds the walks of the chosen
haplotypes in the same subgraph from the haplotype index
([haplotype-index.md](haplotype-index.md#keep)).

1. **`pathFragmentsForRange`** finds the path fragments overlapping the window.
   A contig can be stored as several fragments with gaps between them.
2. **`pathPosition`** looks up the GBWT position at the window's start in
   `ReferenceIndex`.
3. **Prefetch** reads the reference walk's node records, one range request per
   run of nearby node ids.
4. **`aroundInterval`** walks the reference across the window and adds `context`
   bp of graph around it. `limit` caps this step.
5. **`extractSnarls`** adds whole snarls when `snarls` is set
   ([snarls.md](snarls.md)).
6. **`extractPaths`** lists every walk crossing the window's nodes.
7. **Identification** finds the haplotype of each walk
   ([haplotype-index.md](haplotype-index.md#how-a-query-identifies-walks)).
8. **`alignments()`** aligns each walk to the reference and joins pieces of one
   haplotype into a record ([alignments.md](alignments.md)).

Under every step, a pager reads the database in 64 KiB blocks and caches them,
and each block read is one HTTP range request. The library opens a separate
pager for the graph database and for the haplotype index, and
`gbz-base-query --stats` reports the request count of each file separately.
