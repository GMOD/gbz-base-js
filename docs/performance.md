# Performance

A query's time splits between request latency and CPU, and which one dominates
depends on the size of the window. A window of a few thousand nodes spends most
of its time waiting on range requests. A window at cohort scale, hundreds of
haplotypes over tens of thousands of nodes, spends most of it walking and
aligning steps, and `keep` is the largest saving there.

`--stats` on the command line reports the counters behind these tables for a
single query ([api.md](api.md#--stats)). `scripts/measure-windows.mjs` and
`scripts/time-phases.mjs` produced the tables. They predate the step-loop change
in [optimizations.md](optimizations.md#the-step-loops), which made warm queries
1.3-1.8x faster, so their CPU times are upper bounds.

## Keeping a set of haplotypes

Measured against the HPRC v2.1 graph and its hosted companion, both over HTTPS,
with `context: 1000` and contained snarls. Each window was queried for the
tutorial's eight haplotypes and for all 464, once on a fresh open after one
warm-up window elsewhere and again with the window's pages cached:

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

The "all" rows take the sampled route, as the same query does without `keep`.
[haplotype-index.md](haplotype-index.md#the-anchored-walk) describes the two
routes.

## Context

`context` is the graph context in bp past the window, 100 by default. It does
not change how many records come back, because the reader joins the pieces of a
walk that leaves the subgraph, so it trades nodes read against pieces to
identify and join.

A window inside a snarl much larger than itself, such as MHC class II on the
HPRC graph, comes back as 1.1M pieces at `context: 0` and as 464 walks at
`context: 1000`, which is three times faster. A window whose private stretches
are short bubbles costs about the same either way. The `snarls` option is the
other way to avoid the pieces ([snarls.md](snarls.md)).

## A whole chromosome over HTTPS

Against a 134 MB HPRC chr20 `.gbz.db` served over HTTPS,
`--sample GRCh38 --contig chr20`:

| window | context | nodes | haplotype fragments | range requests | bytes read | time  |
| ------ | ------- | ----- | ------------------- | -------------- | ---------- | ----- |
| 500 bp | 0       | 17    | 11                  | 7              | 459 KB     | 1.4 s |
| 10 kb  | 0       | 627   | 1021                | 8              | 524 KB     | 2.1 s |
| 100 kb | 0       | 2051  | 3673                | 13             | 852 KB     | 1.7 s |
| 10 kb  | 100 bp  | 1086  | 35                  | 9              | 590 KB     | 0.8 s |

Sequential request latency takes most of the wall time in these small queries.

## Where a window's time goes

A 200 kb window on the 232 MB haplotype-indexed HPRC chr20 build,
`CHM13#0#chr20`, `context: 100`, warm, from a local file: 5,943 nodes, 178
haplotypes, 346,993 steps, 852 KB in 9 range requests.

| phase                                   | time      |
| --------------------------------------- | --------- |
| `pathPosition`                          | 10 ms     |
| `aroundInterval` (walk + SQLite decode) | 66–94 ms  |
| `extractPaths` (GBWT walking)           | 70–109 ms |
| CIGARs, if asked for                    | 60–150 ms |
| `toCompactSubgraph`, no CIGARs          | 8 ms      |
| `toSubgraphJson`, no CIGARs             | 14–28 ms  |
| `JSON.stringify` of that                | 45–87 ms  |

No phase takes more than about a third of the time. The work spreads across
graph walking, SQLite page decoding, alignment and output.

The 200 kb chr20 window, with latency added to each read:

| read latency | query  | total   |
| ------------ | ------ | ------- |
| 0 ms         | 216 ms | 398 ms  |
| 30 ms        | 465 ms | 610 ms  |
| 80 ms        | 897 ms | 1049 ms |

Of the nine requests, `(897 − 465) / 50 ≈ 8.6` are serial. At a realistic
round-trip time, about two thirds of the query waits on the network, so cutting
round trips saves more than faster decoding would. The block size and the
reference-walk prefetch exist to cut round trips.

## Windows at cohort scale

A window at cohort scale has a different profile. MHC class II on the hosted
HPRC v2.1 pair is 43,540 nodes, 464 walks and 9.86 million steps, and walking
and aligning those steps takes most of the time. The same query, run twice in
one process so that the second run makes no requests:

| phase                   | cold    | warm, 0 requests |
| ----------------------- | ------- | ---------------- |
| `pathPosition`          | 3.19 s  | 0.00 s           |
| `prefetchReferenceWalk` | 0.30 s  | 0.00 s           |
| `aroundInterval`        | 2.95 s  | 0.54 s           |
| `extractSnarls`         | 0.36 s  | 0.09 s           |
| `extractPaths`          | 2.92 s  | 2.62 s           |
| `identifyPaths`         | 1.00 s  | 0.10 s           |
| `alignments`            | 2.45 s  | 2.14 s           |
| total                   | 13.18 s | 5.49 s           |

`extractPaths` and `alignments` take 87% of the warm query and make no requests,
so no window costs less than they do.

The warm column re-runs the identical window, which a user panning never does. A
window the session has not visited still fetches:

| MHC class II, 90 kb, all 464 | time   | requests | bytes   |
| ---------------------------- | ------ | -------- | ------- |
| first open                   | 9.97 s | 31       | 6.36 MB |
| the same window again        | 4.75 s | 0        | 0.00 MB |
| the adjacent 90 kb, first    | 5.36 s | 7        | 1.64 MB |
| that window again            | 3.69 s | 0        | 0.00 MB |

Panning at this scale is roughly a third network and two thirds CPU, and the
first window of a session about half each.

The CPU time grows with walks times steps, so choosing fewer haplotypes saves
more than any tuning underneath. Measured after the step-loop change, `keep` for
eight of the 464 haplotypes is 4.6x faster warm (0.90 s against 4.13 s), because
the query walks 170,000 steps instead of 9.86 million. Before the change the
ratio was 6.9x; the change halved the 464-haplotype time and left the
eight-haplotype time unchanged.

## Why a small window is not a cheap one

Warm, at the same locus, all 464 haplotypes, `context: 1000`, contained snarls:

| window | fragments | identify | walked steps | companion seeks / misses | median fragment |
| ------ | --------- | -------- | ------------ | ------------------------ | --------------- |
| 2 kb   | 687       | 7.14 s   | 570,850      | 481,353 / 480,915        | 3.5 kb          |
| 5 kb   | 687       | 3.90 s   | 506,919      | 480,420 / 479,982        | 5.4 kb          |
| 10 kb  | 1,125     | 4.85 s   | 629,369      | 433,998 / 433,674        | 6.5 kb          |
| 20 kb  | 1,130     | 4.21 s   | 468,658      | 433,998 / 433,674        | 4.5 kb          |
| 45 kb  | 464       | 0.48 s   | 0            | 0 / 0                    | 76 kb           |
| 90 kb  | 464       | 0.10 s   | 0            | 0 / 0                    | 95 kb           |
| 180 kb | 464       | 0.55 s   | 0            | 0 / 0                    | 166 kb          |

Below about 45 kb the walks arrive in pieces, up to 1,130 fragments for 464
haplotypes, and most pieces are shorter than the companion's sampling interval
of 16,384 bp. Such a piece holds no sample, so naming it falls back to scanning
the index and walking to a sample. From 45 kb up the reader joins the pieces,
the median fragment is 76 kb or longer, and every fragment contains a sample, so
`identifyPaths` makes no seek, walks no step and runs an order of magnitude
faster.

The threshold applies to the fragment, not the window: a 20 kb window is longer
than the interval, but its median fragment is 4.5 kb, so it is still slow. The
fragment count and the fragment length change together, and neither causes the
other. What changes at 45 kb is that the window comes to contain the snarl the
pieces were leaving.

The scans in the slow rows almost all miss: 480,915 of 481,353 seeks, 99.91%.
[optimizations.md](optimizations.md#what-is-left) notes the fix.
