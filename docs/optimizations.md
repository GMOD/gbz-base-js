# Optimizations

This page records why the alignment search, the anchored walk, the step loops
and the compact output format are built the way they are, with the measurements
behind each choice. [dataflow.md](dataflow.md) shows where each sits in a query,
and [performance.md](performance.md) measures whole queries.

Unless a section says otherwise, the measurements ran over HTTPS against the
HPRC v2.1 graph and the hosted anchored companion
(`https://jbrowse.org/demos/hprc/hprc-v2.1-mc-grch38.haplotype-index.anchored.db`),
with `--keep`, `--cigar` and `--stats`.

## Aligning a walk to the reference

### Ordered matching first

`editsAgainst` first matches each shared node to its earliest usable occurrence
on the reference walk. That takes linear time and is weight-optimal whenever
every shared node can be placed in order. Only a walk that visits shared nodes
out of reference order falls back to `weightedLcs`, a node-length-weighted
longest common subsequence. On the HPRC graph only AMY1 reaches the fallback:
keeping all 231 samples sends 100 of 957 records to it. KIV-2, RHD and CYP2D6
send none, and neither do MHC class II and SMN1/2 with 14 samples kept.

### Chaining shared pairs in linear space

gbwt-rs runs a Myers-style search that keeps state for every edit distance it
reaches, measured in bases. At AMY1, the walks of HG00408#2 and NA18620#2
include a 13,303-step, 230,857 bp fragment to align against the 7,585-step,
90,183 bp reference, and this reader's first port of that search exhausted a 3
GB heap on it in about 30 s.

`weightedLcs` instead chains only the step pairs that share a node, as a
heaviest increasing subsequence over a Fenwick tree of column maxima. Once those
pairs outnumber the two walks' steps, `solve` halves the first walk and finds
the best column at which to cut the second, Hirschberg-style, so memory stays
linear in the walks. The AMY1 fragments of both haplotypes align in 3-8 ms, and
the whole query peaks at 230-294 MB.

Two alternatives lost on the same fragments. A linear-space Hirschberg DP took
419 and 155 ms. Anchoring on nodes unique to both walks left a gap of 11,375 by
850 steps still to align.

The chaining search and upstream's Myers search are both weight-optimal, but
they can pick different alignments of equal weight. The `looping-walk` fixture's
CIGARs still match upstream's, and each of the 99 unordered walks in the
all-samples AMY1 query, the longest 26,809 steps, gets the weight a full DP
gives it.

### Trimming shared ends at every split

The chaining search's cost follows the number of shared step pairs, and two
walks looping through the same node thousands of times make millions of them.
`solve` therefore matches the shared prefix and suffix outright before chaining
or splitting, at every level of the recursion. Once a split lands inside a
shared loop, both halves begin or end with the same run, and the trim removes
it. On synthetic walks:

| Input                                        | Untrimmed | Trimmed |
| -------------------------------------------- | --------- | ------- |
| One node looped 3,200 against 3,000 times    | 740 ms    | 4 ms    |
| Identical 5,000-step homopolymers            | 1.9 s     | 1 ms    |
| Two nodes alternating, 20,000 against 10,000 | 7.7 s     | 3 ms    |
| The 3,200/3,000 loop with its flanks swapped | 680 ms    | 400 ms  |
| AMY1-like: 8 variant copies against 3        | 9 ms      | 6 ms    |

The trim cannot reach the swapped-flank pattern: no split lands where both
halves share an end until the chaining has already processed those pairs. No
HPRC locus we queried has that pattern, and in the all-samples AMY1 profile the
LCS takes 121 ms of 18 s of CPU.

Two changes to the chaining measured within run-to-run noise, and we dropped
them:

- Chaining up to a fixed budget of pairs before splitting. Past about a million
  pairs it got slower.
- Storing each Fenwick node's maximum beside its column index, to skip an
  indirection per query.

## Walking from an anchor

`walkFromRow` follows `lf()` from a haplotype's anchor row through the window
and keeps no visited set. `lf()` is a permutation of GBWT positions, so a walk
over well-formed data cannot revisit one, and the walk's bp bound stops any loop
a corrupt record could make. A visited set costs a `node:offset` string per
step. At AMY1 with all 231 samples kept, 5M steps, dropping the set left the
output identical and took the walks phase from 8.2 to 6.6 s and CPU from 9.2 to
8.4 s, averaged over three alternating runs.

## The step loops

`extractPaths` reads a successor on every step. Held as an `Int32Array` per
node, forty thousand separate buffers for a large window, each read chases a
pointer into scattered memory. Held as one flat pair of arrays indexed by
`rowStart[node] + offset`, each read is an add and a load. `orderedMatches` had
allocated a closure per step for `Array.find` and a two-element array per match,
and scanned each reference node's occurrence list from the front, which a repeat
locus makes long. Both now avoid those costs.

Measured warm on the five tutorial loci, both files hosted, `context: 1000`,
contained snarls. The benchmark opens both builds in one process and alternates
them, taking the median of five runs each; runs in separate processes credited
the change with machine load and reported 1.4-2.1x. Absolute times are higher
than in a single-build run because the two databases share the process's page
cache.

| Window       | Nodes  | Walks | Steps | Before   | After   | Ratio |
| ------------ | ------ | ----- | ----- | -------- | ------- | ----- |
| C4           | 1,173  | 464   | 0.20M | 0.085 s  | 0.059 s | 1.44x |
| CFH cluster  | 16,372 | 466   | 4.47M | 4.841 s  | 3.273 s | 1.48x |
| KIV-2        | 27,438 | 465   | 6.15M | 5.480 s  | 3.903 s | 1.40x |
| MHC class II | 43,540 | 464   | 9.86M | 10.516 s | 5.928 s | 1.77x |
| AMY1         | 12,240 | 1,913 | 4.59M | 2.819 s  | 2.236 s | 1.26x |

The ratio is best where the steps are most concentrated. AMY1, the locus with
the most walks, gains least, so the speedup does not come from saving per-walk
allocations. The alignment records and the GFA cut hash identically before and
after at every locus, over outputs from 2 MB to 101 MB.

Decoding the BWT bytecode in one pass instead of two in `decompressArrays`
measured no better, so the second pass is not where that function spends its
time.

## The compact output format

`toCompactSubgraph` packs only the step lists into typed arrays
([api.md](api.md#json-or-compact)). bam-js returns `NUMERIC_SEQ` and
`NUMERIC_CIGAR`, the packed bytes as the file holds them, and decodes the
strings lazily, because decoding a whole nanopore read to compare twenty
positions wastes time. Packing helps only a long per-record field, and in a
subgraph only the step list is long. Measured by `structuredClone` on the chr20
window from [performance.md](performance.md#where-a-windows-time-goes):

| field  | size here                 | packed  | strings | result               |
| ------ | ------------------------- | ------- | ------- | -------------------- |
| steps  | 346,993 per window        | 1.9 ms  | 295 ms  | packed, 155x         |
| CIGARs | 323 chars avg, 17,555 ops | 0.20 ms | 0.09 ms | strings clone faster |
| seqs   | 34 bp avg, 5,943 nodes    | 1.07 ms | 0.95 ms | about even           |

Node sequences pack 2.86x smaller, but a consumer drawing the graph wants the
string for every node anyway. CIGARs packed into one `Int32Array` per path clone
more slowly than the strings, because 178 small typed arrays cost more to clone
than 178 strings. So `nodeSequences` and `cigar` stay strings. The CIGAR phase
spends 103 ms computing edits and 2 ms building the string, so its
representation does not matter.

## What is left

In the all-samples AMY1 profile, 55% of samples sit idle waiting on the network.
`walkFromRow` is the largest CPU cost at 15%, then GBWT `lf()` and bytecode
decoding at about 3% each.

| Locus, 231 samples kept | Walks | Steps | LCS | Wall   | Peak RSS |
| ----------------------- | ----- | ----- | --- | ------ | -------- |
| AMY1                    | 477   | 5.06M | 100 | 18.9 s | 1.05 GB  |
| KIV-2 130 kb            | 463   | 8.05M | 0   | 22.3 s | 908 MB   |
| RHD                     | 462   | 5.45M | 0   | 25.9 s | 928 MB   |
| CYP2D6                  | 462   | 1.64M | 0   | 9.9 s  | 234 MB   |

The locus rows were measured with the visited set still in `walkFromRow`.

SMN1/2 is the slow outlier, at 35 s and 754 MB with only 14 samples kept. One
haplotype's anchored walk passes its bp bound inside the inverted segmental
duplication, so the whole query falls back to the sampled route and identifies
paths across 18,534 samples. A walk able to cross that inversion would avoid the
fallback; nobody has tried one yet.

A fragment shorter than the companion's sampling interval holds no sample, and
identifying it scans the index and misses 99.91% of the time
([performance.md](performance.md#why-a-small-window-is-not-a-cheap-one)).
Skipping the scan for such a fragment and walking directly would remove that
cost, and needs a change to this reader only.
