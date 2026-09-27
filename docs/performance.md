# Performance

A query on a small window spends most of its time waiting on request latency. A
query on a window with hundreds of haplotypes spends most of its time walking
and aligning steps, and that is where `keep` saves the most time, because the
library then walks and aligns only the haplotypes you asked for.
`gbz-base-query --stats` reports the counters for one query, and
`scripts/measure-windows.mjs` and `scripts/time-phases.mjs` produced the tables
below. The tables predate the
[step-loop change](optimizations.md#the-step-loops), which made warm queries
1.3-1.8x faster.

## A subset of the haplotypes

We queried the HPRC v2.1 graph and its hosted haplotype index over HTTPS, with
`context: 1000` and contained snarls. "First" is a fresh open after one warm-up
window elsewhere; "cached" has the window's pages in memory.

| Window       | Haplotypes | Route    | Nodes  | First  | Cached |
| ------------ | ---------- | -------- | ------ | ------ | ------ |
| KIV-2 30 kb  | 8          | anchored | 3,140  | 3.08 s | 0.38 s |
| KIV-2 30 kb  | 464        | sampled  | 21,721 | 3.75 s | 2.17 s |
| KIV-2 130 kb | 8          | anchored | 7,383  | 2.87 s | 0.51 s |
| KIV-2 130 kb | 464        | sampled  | 27,438 | 4.80 s | 3.74 s |
| AMY1         | 8          | anchored | 8,164  | 6.11 s | 0.48 s |
| AMY1         | 464        | sampled  | 12,240 | 8.43 s | 3.00 s |
| MHC class II | 8          | anchored | 31,008 | 5.46 s | 0.97 s |
| MHC class II | 464        | sampled  | 43,540 | 9.59 s | 9.16 s |

A first query makes 16-46 range requests and reads 2.2-4.7 MB across both files.

## Context

With a larger `context`, the query reads more nodes and returns each haplotype
in fewer pieces, so the library has fewer pieces to identify and join. MHC class
II lies inside a snarl much larger than the window: the query returns 1.1M
pieces at `context: 0` and 464 whole walks at `context: 1000`, and the second
query runs three times faster. The `snarls` option is the other way to get whole
walks ([snarls.md](snarls.md)).

## A small window

We queried `GRCh38#0#chr20` on HPRC chr20 (134 MB) over HTTPS:

| window | context | nodes | range requests | bytes read | time  |
| ------ | ------- | ----- | -------------- | ---------- | ----- |
| 500 bp | 0       | 17    | 7              | 459 KB     | 1.4 s |
| 10 kb  | 0       | 627   | 8              | 524 KB     | 2.1 s |
| 100 kb | 0       | 2051  | 13             | 852 KB     | 1.7 s |
| 10 kb  | 100 bp  | 1086  | 9              | 590 KB     | 0.8 s |

A 200 kb window on the local indexed chr20 build (5,943 nodes, 178 haplotypes)
takes 216 ms warm. With 30 ms of latency added to each read the query takes 465
ms, and with 80 ms, 897 ms, so nearly all nine requests run one after another.
At a realistic round trip, two thirds of the query is network, which is why the
pager reads 64 KiB blocks and prefetches the reference walk.

## A large window

MHC class II on HPRC v2.1 has 43,540 nodes, 464 walks and 9.86 million steps. We
ran the query twice in one process, the second time with every page cached:

| phase                   | cold    | cached |
| ----------------------- | ------- | ------ |
| `pathPosition`          | 3.19 s  | 0.00 s |
| `prefetchReferenceWalk` | 0.30 s  | 0.00 s |
| `aroundInterval`        | 2.95 s  | 0.54 s |
| `extractSnarls`         | 0.36 s  | 0.09 s |
| `extractPaths`          | 2.92 s  | 2.62 s |
| `identifyPaths`         | 1.00 s  | 0.10 s |
| `alignments`            | 2.45 s  | 2.14 s |
| total                   | 13.18 s | 5.49 s |

`extractPaths` and `alignments` are 87% of the cached time. Panning to an
adjacent 90 kb window takes 5.36 s and 7 requests, of which about a third is
network time.

CPU time grows with walks times steps. Measured after the step-loop change, MHC
class II with `keep` for eight haplotypes is 4.6x faster than all 464 (0.90 s
against 4.13 s), because the library walks 170,000 of the 9.86 million steps.

## Small windows at the same locus

We queried all 464 haplotypes with the pages cached and `context: 1000`:

| window | fragments | identification time | median fragment |
| ------ | --------- | ------------------- | --------------- |
| 2 kb   | 687       | 7.14 s              | 3.5 kb          |
| 20 kb  | 1,130     | 4.21 s              | 4.5 kb          |
| 45 kb  | 464       | 0.48 s              | 76 kb           |
| 90 kb  | 464       | 0.10 s              | 95 kb           |

Below 45 kb the query returns walks in pieces shorter than the 16,384 bp
interval between samples in the haplotype index. A piece with no sample on it
sends the library to the haplotype index for a lookup, and 99.91% of those
lookups miss. From 45 kb the window contains the whole snarl, each walk is one
piece, and identification is an order of magnitude faster.
