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

## Where a window's time goes

A 200 kb window on the 232 MB haplotype-indexed HPRC chr20 build,
`CHM13#0#chr20`, `context: 100`, warm, from a local file — 5,943 nodes, 178
haplotypes, 346,993 steps, 852 KB in 9 range requests:

| phase                                   | time      |
| --------------------------------------- | --------- |
| `pathPosition`                          | 10 ms     |
| `aroundInterval` (walk + SQLite decode) | 66–94 ms  |
| `extractPaths` (GBWT walking)           | 70–109 ms |
| CIGARs, if asked for                    | 60–150 ms |
| `toCompactSubgraph`, no CIGARs          | 8 ms      |
| `toSubgraphJson`, no CIGARs             | 14–28 ms  |
| `JSON.stringify` of that                | 45–87 ms  |

Nothing dominates: the work is spread across graph walking, SQLite page
decoding, alignment and output, none above about a third.

The same query with latency added to each read shows what that is worth against
the network:

| read latency | query  | total   |
| ------------ | ------ | ------- |
| 0 ms         | 216 ms | 398 ms  |
| 30 ms        | 465 ms | 610 ms  |
| 80 ms        | 897 ms | 1049 ms |

Nine requests, and `(897 − 465) / 50 ≈ 8.6` of them serial. At a realistic RTT
about two thirds of the query is waiting on the network, so cutting round trips
is worth more than making the decoding faster — which is what the block size and
the prefetching are for.

## Where that inverts

The window above is 5,943 nodes and 178 haplotypes. A window at cohort scale is
a different query, and the conclusion above does not carry to it. MHC class II
on the hosted HPRC v2.1 pair is 43,540 nodes, 464 walks and **9.86 million
steps**, and what it spends its time on is walking and aligning those steps. The
same query run twice in one process, so the second makes no request at all:

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

`extractPaths` and `alignments` are 87% of the warm query and neither touches
the network, so a window is never cheaper than they are.

That is not the same as saying the network stopped mattering, and the warm row
above is the least representative case there is — it re-runs the _identical_
window. A window the session has not visited still fetches:

| MHC class II, 90 kb, all 464 | time   | requests | bytes   |
| ---------------------------- | ------ | -------- | ------- |
| first open                   | 9.97 s | 31       | 6.36 MB |
| the same window again        | 4.75 s | 0        | 0.00 MB |
| the adjacent 90 kb, first    | 5.36 s | 7        | 1.64 MB |
| that window again            | 3.69 s | 0        | 0.00 MB |

So panning is roughly a third network and two thirds CPU, and the first window
of a session about half each. What changes past the small-window regime is that
the CPU half stops being negligible, not that the network does.

The CPU half is O(walks × steps), which is why a selection is worth more than
any amount of tuning underneath it: `keep` for eight haplotypes of the 464 is
**4.6x** faster warm (4.13 s against 0.90 s), because it is 170,000 steps rather
than 9.86 million. That ratio was 6.9x before the change below, which halved the
464-haplotype side and left the eight-haplotype side alone; an earlier draft of
this section said 9.5x, which came from a run with snarls left at their default
rather than `contained` and should not have been compared against this table.

## What the step loops cost

Two data shapes were most of the rest of it, and both were about how a step is
reached rather than what is done with it.

`extractPaths` reads a successor on every step. Held as an `Int32Array` per node
— forty thousand separate buffers for a window like this — each of those reads
is a pointer chase into scattered memory; held as one flat pair indexed by
`rowStart[node] + offset` it is an add and a load. `orderedMatches` allocated a
closure per step for `Array.find` and returned a two-element array per match,
and it scanned each reference node's occurrence list from the front, which a
repeat locus makes long.

Measured warm on the five tutorial loci, both files hosted, `context: 1000`,
contained snarls. Both builds are opened in ONE process and alternated, median
of five each, because measuring the two in separate runs credited the change
with machine load: that method reported 1.4-2.1x, and CFH's 2.12x does not
reproduce. Absolute times here are higher than a single-build run because two
databases share the process's page cache; the ratio is what the interleaving
buys.

| Window       | Nodes  | Walks | Steps | Before   | After   | Ratio |
| ------------ | ------ | ----- | ----- | -------- | ------- | ----- |
| C4           | 1,173  | 464   | 0.20M | 0.085 s  | 0.059 s | 1.44x |
| CFH cluster  | 16,372 | 466   | 4.47M | 4.841 s  | 3.273 s | 1.48x |
| KIV-2        | 27,438 | 465   | 6.15M | 5.480 s  | 3.903 s | 1.40x |
| MHC class II | 43,540 | 464   | 9.86M | 10.516 s | 5.928 s | 1.77x |
| AMY1         | 12,240 | 1,913 | 4.59M | 2.819 s  | 2.236 s | 1.26x |

So 1.3-1.8x, best where the steps are most concentrated and worst at AMY1 —
which is the locus with the most walks, so the per-walk allocation savings are
not what is paying. The alignment records and the GFA cut hash identically
before and after at every locus, over outputs from 2 MB to 101 MB.

The tables above this section were measured before that change and are the
conservative numbers.

Decoding the BWT bytecode once instead of twice in `decompressArrays` was tried
on the same window and is not here: it measured no better than the two-pass it
replaced, so the second pass is not what that function spends its time on.

## Why there is no wasm in the decoding path

[why-not-wasm.md](why-not-wasm.md) is about not compiling upstream's Rust.
Writing a small wasm kernel by hand, the way bgzf-filehandle and bbi-js do for
inflate, is a separate question, and the measurements say no: there is no kernel
here big enough to be worth a boundary. The two routines shaped like one, timed
over the whole subgraph above, are `decodeSequence` at **6.9 ms** for 408,976
bases and `GbwtRecord.decompressArrays` at **19.9 ms** for 693,986 entries — 27
ms of a ~400 ms query, across 11,886 separate records. `weightedLcs`, the one
quadratic routine and the obvious candidate, is never reached on this data:
`--stats` reports 177 ordered and 0 LCS alignments at every locus tried, because
`orderedMatches` succeeds. The rest of the time is Map lookups, small-object
allocation, string building and `JSON.stringify`, which is already native.

This is why the output shape got the attention instead: 295 ms to structured-
clone the upstream shape against 1.9 ms for the compact one is a bigger win than
any decoding kernel here could offer, and it needed no new runtime.

## Measuring your own

`--stats` on the command line reports how many range requests a query made and
how many bytes they carried, and with `--resolve` or `--alignments` how
identification went: index scans, chains per haplotype, why each chain ended,
companion seeks against graph record lookups, and fragment lengths against the
walk bound. `scripts/measure-windows.mjs` and `scripts/time-phases.mjs` are what
produced the tables above.
