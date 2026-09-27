# Alignment records

`getAlignmentsForRange` returns one record each time a haplotype crosses the
window, aligned to the reference path you queried.

```ts
for (const alignment of alignments) {
  const { refStart, refEnd, strand, cigar } = alignment
  if (alignment.resolved) {
    console.log(alignment.label, alignment.hapStart, alignment.hapEnd)
  }
}
```

| field                 | meaning                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `refStart` / `refEnd` | span on the reference, extended to node boundaries                                  |
| `cigar`               | alignment to the reference                                                          |
| `strand`              | `-` when the haplotype runs opposite to the reference                               |
| `path`                | the walk as node handles                                                            |
| `weight`              | the number of identical walks merged into the record, with `haplotypes: 'distinct'` |
| `start`               | GBWT position of the walk's start, stable across refetches                          |
| `resolved`            | `true` when the library named the record from the haplotype index                   |

A resolved record also has `name` (a `PathName`), `label` (such as
`HG02723#1#JAHEOU010000100.1[4392999-4393486]`), `pathHandle`, and
`hapStart`/`hapEnd` in the haplotype's coordinates.

## Joined pieces

A haplotype can leave the window and come back, for example through an
insertion. The library joins the two pieces into one record when they are
consecutive, on the same strand and in order on both paths, and writes the
sequence between them as an insertion and a deletion. When an inversion or a
repeat lies between the pieces, the library keeps them as separate records.

## The CIGAR

The CIGAR is a node-length-weighted longest common subsequence of the walk and
the reference path, as upstream computes it. Between shared nodes, the library
matches any common prefix and suffix, then scores the rest with vg's parameters.

## One haplotype against another

`subgraph.pairAlignments({ target, query })` aligns haplotypes to each other,
comparing bases. The reference path can be the target or the query. Without
`query`, `pairAlignments` aligns every other named walk to the target. It needs
the haplotype index.

```ts
const target = { sample: 'HG02004', haplotype: 2 }
for (const r of subgraph.pairAlignments({ target })) {
  console.log(
    r.query,
    r.queryStart,
    r.queryEnd,
    r.strand,
    r.targetStart,
    r.cigar,
  )
}
```

A record is the best-scoring chain of runs of shared nodes, chained the way
minimap2 chains seeds. The library aligns the bases between two runs globally,
with vg's scores (match 1, mismatch -4, gap -6 and -1 per extra base). Where the
bases between two runs are long on both walks, the library chains shared 15-mers
first, which also finds inversions. Each base aligns in at most one record.

| field                       | meaning                                      |
| --------------------------- | -------------------------------------------- |
| `queryStart` / `queryEnd`   | span in the query haplotype's coordinates    |
| `targetStart` / `targetEnd` | span in the target haplotype's coordinates   |
| `cigar`                     | `=`, `X`, `I` and `D`, read along the target |
| `matches`                   | matching bases                               |
| `sharedBases`               | matching bases on nodes both walks visit     |

| option   | meaning                                                                              |
| -------- | ------------------------------------------------------------------------------------ |
| `maxGap` | the most bases a record may skip on nodes only one walk visits, unlimited by default |
| `bases`  | `false` writes the sequence between shared nodes as `I` and `D`                      |

## PAF output

The command line prints `pairAlignments` records as PAF, with `sharedBases` as
the tag `ns:i:`. `--against HAP` aligns every walk to one haplotype, and
`--stack A,B,C` aligns each haplotype to the next, which are the pairs a stacked
synteny view draws.

```bash
gbz-base-query graph.gbz.db --haplotype-index index.db --sample GRCh38 --contig chr6 \
  --interval 31940000..32090000 --context 0 \
  --stack 'HG01978#2,HG02004#2,GRCh38#0,HG02818#1,HG00146#1' --contig-lengths lengths.tsv
```

`--contig-lengths` takes a chrom.sizes or `.fai` file for PAF columns 2 and 7.
`--no-bases` and `--max-gap` set `bases: false` and `maxGap`.
