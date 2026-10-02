# Command line

`gbz-base-query` runs one query with the [library](api.md) and prints the
result. The program takes the flags of upstream's `gbz-base query`, and adds
flags for the haplotype index, alignment records and PAF. The database and the
haplotype index can each be a local path or an `http(s)://` URL.

```bash
npx -p @gmod/gbz-base gbz-base-query --help   # run without installing
npm install -g @gmod/gbz-base                 # or put it on your PATH
```

## Examples

```bash
# the subgraph around a window, as upstream's JSON
gbz-base-query graph.gbz.db --sample GRCh38 --contig chr6 \
  --interval 31500000..31501000 --cigar

# the same window as GFA
gbz-base-query graph.gbz.db --sample GRCh38 --contig chr6 \
  --interval 31500000..31501000 --format gfa

# 50 bp around one offset of a remote database, with request counts
gbz-base-query https://host/graph.gbz.db --contig chrM --offset 1000 \
  --context 50 --stats

# named alignment records, from a remote database and haplotype index
gbz-base-query https://host/graph.gbz.db \
  --haplotype-index https://host/graph.haplotype-index.db \
  --sample GRCh38 --contig chr6 --interval 31500000..31501000 --alignments
```

## Output

| flags                    | stdout                                                    |
| ------------------------ | --------------------------------------------------------- |
| none                     | the subgraph as JSON, matching upstream's `--format json` |
| `--format gfa`           | the subgraph as GFA                                       |
| `--alignments`           | a JSON array of [alignment records](alignments.md)        |
| `--against` or `--stack` | [PAF](alignments.md#paf-output), one line per alignment   |

`--stats` writes request and byte counts to stderr, with how many walks the
library identified and how many it could not. For a query that uses the `keep`
option it also prints what each step of the keep route found and read, or the
reason the query identified every walk. On an error, `gbz-base-query` prints the
message to stderr and exits with status 1.

## Flags

| flag                                | meaning                                                             | library equivalent                            |
| ----------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| `--sample` `--haplotype` `--contig` | the path to query; `--haplotype` defaults to 0                      | `path: { sample, haplotype, contig }`         |
| `-i`, `--interval A..B`             | the half-open window, in path offsets                               | `subgraphInInterval({ start, end })`          |
| `-o`, `--offset N`                  | a window around one offset                                          | `subgraphAtOffset({ offset })`                |
| `-n`, `--node ID`                   | a window around a node id, repeatable                               | `subgraphAroundNodes({ nodeIds })`            |
| `-b`, `--between A:B`               | every node between two oriented handles, such as `129+:160+`        | `subgraphBetween({ startHandle, endHandle })` |
| `--context N`                       | bp of graph around the window, 100 by default                       | `context`                                     |
| `--snarls`                          | add contained top-level [snarls](snarls.md)                         | `snarls: 'contained'`                         |
| `--extend-snarls`                   | add overlapping top-level snarls                                    | `snarls: 'overlapping'`                       |
| `--limit N`                         | maximum nodes per path fragment                                     | `limit`                                       |
| `--haplotypes SEL`                  | `all` (default), `distinct`, `reference-only` or `none`             | `haplotypes`                                  |
| `--cigar`                           | include CIGAR strings                                               | `cigar: true`                                 |
| `--format json\|gfa`                | the subgraph's output format                                        | `toSubgraphJson`, `toGFA`                     |
| `--haplotype-index F`               | the haplotype index file, a path or URL                             | `haplotypeIndex`                              |
| `--resolve`                         | look up the haplotype of each walk in the haplotype index           | `identifyPaths()`                             |
| `--keep SAMPLE[#HAP]`               | return only these haplotypes, repeatable; implies `--resolve`       | `keep`                                        |
| `--alignments`                      | print alignment records; implies `--resolve`                        | `alignments()`, `getAlignments`               |
| `--against SAMPLE#HAP`              | PAF of every other named walk against this haplotype                | `pairAlignments({ target })`                  |
| `--stack A,B,C`                     | PAF of each haplotype against the next in the list                  | `pairAlignments({ query, target })`           |
| `--no-bases`                        | compare shared nodes only; write the bases between them as `I`, `D` | `bases: false`                                |
| `--max-gap N`                       | the most bases a PAF record may skip on nodes only one walk visits  | `maxGap`                                      |
| `--contig-lengths F`                | chrom.sizes or `.fai` file for PAF columns 2 and 7                  |                                               |
| `--block-size N`                    | bytes per page block, 65536 by default                              | `blockSize`                                   |
| `--stats`                           | print fetch and identification statistics to stderr                 | `db.fetchStats()`                             |
