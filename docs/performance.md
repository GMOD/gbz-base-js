# Measured

## Keeping a set of haplotypes

Measured against the HPRC v2.1 graph and its hosted companion, both over HTTPS,
`context: 1000`, contained snarls, the tutorial's eight haplotypes against all
464, on a fresh open after one warm-up window elsewhere and again with the
window's pages cached:

| Window       | Set   | Open       | Route    | Records | Nodes  | Graph           | Companion       | Time   |
| ------------ | ----- | ---------- | -------- | ------- | ------ | --------------- | --------------- | ------ |
| KIV-2 30 kb  | eight | after open | anchored | 8       | 3,140  | 9 req, 2.23 MB  | 9 req, 0.59 MB  | 3.08 s |
| KIV-2 30 kb  | eight | cached     | anchored | 8       | 3,140  | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 0.38 s |
| KIV-2 30 kb  | all   | after open | sampled  | 464     | 21,721 | 7 req, 1.57 MB  | 9 req, 0.59 MB  | 3.75 s |
| KIV-2 30 kb  | all   | cached     | sampled  | 464     | 21,721 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 2.17 s |
| KIV-2 130 kb | eight | after open | anchored | 8       | 7,383  | 11 req, 2.62 MB | 13 req, 0.85 MB | 2.87 s |
| KIV-2 130 kb | eight | cached     | anchored | 8       | 7,383  | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 0.51 s |
| KIV-2 130 kb | all   | after open | sampled  | 464     | 27,438 | 8 req, 1.90 MB  | 14 req, 0.92 MB | 4.80 s |
| KIV-2 130 kb | all   | cached     | sampled  | 464     | 27,438 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 3.74 s |
| AMY1         | eight | after open | anchored | 13      | 8,164  | 28 req, 3.21 MB | 15 req, 0.98 MB | 6.11 s |
| AMY1         | eight | cached     | anchored | 13      | 8,164  | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 0.48 s |
| AMY1         | all   | after open | sampled  | 1,395   | 12,240 | 23 req, 2.23 MB | 23 req, 1.51 MB | 8.43 s |
| AMY1         | all   | cached     | sampled  | 1,395   | 12,240 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 3.00 s |
| MHC class II | eight | after open | anchored | 8       | 31,008 | 11 req, 4.06 MB | 10 req, 0.66 MB | 5.46 s |
| MHC class II | eight | cached     | anchored | 8       | 31,008 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 0.97 s |
| MHC class II | all   | after open | sampled  | 463     | 43,540 | 12 req, 2.62 MB | 8 req, 0.52 MB  | 9.59 s |
| MHC class II | all   | cached     | sampled  | 463     | 43,540 | 0 req, 0.00 MB  | 0 req, 0.00 MB  | 9.16 s |

The "all" rows are the sampled route the same query takes without `keep`. The
two routes are described in
[haplotype-index.md](haplotype-index.md#the-anchored-walk).

## Context

`context` is the graph context in bp to extend past the window, 100 by default.
It does not decide how many records come back, since the pieces of a walk that
leaves the subgraph are joined again, so it trades nodes read against pieces to
identify and join.

A window inside a snarl much larger than itself (MHC class II on the HPRC graph)
is 1.1M pieces at `context: 0` and 464 walks at 1000, three times faster; a
window whose private stretches are short bubbles costs about the same either
way.

## A whole chromosome over HTTPS

Against a 134 MB HPRC chr20 `.gbz.db` served over HTTPS,
`--sample GRCh38 --contig chr20`:

| window | context | nodes | haplotype fragments | range requests | bytes read | time  |
| ------ | ------- | ----- | ------------------- | -------------- | ---------- | ----- |
| 500 bp | 0       | 17    | 11                  | 7              | 459 KB     | 1.4 s |
| 10 kb  | 0       | 627   | 1021                | 8              | 524 KB     | 2.1 s |
| 100 kb | 0       | 2051  | 3673                | 13             | 852 KB     | 1.7 s |
| 10 kb  | 100 bp  | 1086  | 35                  | 9              | 590 KB     | 0.8 s |

Most of the wall time in the small queries is sequential request latency, not
decoding.

## Measuring your own

`--stats` on the command line reports how many range requests a query made and
how many bytes they carried, and with `--resolve` or `--alignments` how
identification went: index scans, chains per haplotype, why each chain ended,
companion seeks against graph record lookups, and fragment lengths against the
walk bound. `scripts/measure-windows.mjs` and `scripts/time-phases.mjs` are what
produced the tables above.
