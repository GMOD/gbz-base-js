# Optimizations

Why the alignment and the anchored walk look the way they do.
[dataflow.md](dataflow.md) draws the query path, and
[performance.md](performance.md) has the measured windows.

The measurements below ran over HTTPS against the HPRC v2.1 graph and the hosted
anchored companion
(`https://jbrowse.org/demos/hprc/hprc-v2.1-mc-grch38.haplotype-index.anchored.db`),
with `--keep`, `--cigar` and `--stats`.

## Aligning a walk to the reference

### Ordered matching first

`editsAgainst` first matches each shared node to its earliest usable reference
occurrence, which is linear and weight-optimal whenever every shared node can be
placed in order. Only a walk that visits shared nodes out of reference order
falls back to `weightedLcs`, a node-length-weighted longest common subsequence.
On the HPRC graph only AMY1 reaches that fallback: keeping all 231 samples sends
100 of 957 records to it and KIV-2, RHD and CYP2D6 send none, as do MHC class II
and SMN1/2 with 14 samples kept.

### The LCS chains shared pairs, in linear space

gbwt-rs, and this reader's first port of it, run a Myers-style search that keeps
state for every edit distance it reaches, measured in bases. At AMY1, HG00408#2
and NA18620#2 give it a 13,303-step, 230,857 bp walk against the 7,585-step,
90,183 bp reference, and the port exhausted a 3 GB heap in about 30 s.

`weightedLcs` now chains only the step pairs that share a node, as a heaviest
increasing subsequence over a Fenwick tree of column maxima. Once those pairs
outnumber the two walks' steps, `solve` halves the first walk and finds the best
column to cut the second at, Hirschberg-style, so memory stays linear in the
walks. Both fragments align in 3-8 ms, and the whole query peaks at 230-294 MB.

Two alternatives lost on the same fragments. A linear-space Hirschberg DP took
419 and 155 ms. Anchoring on nodes unique to both walks left an 11,375 by 850
step gap still to align.

The chaining search and upstream's Myers search are both weight-optimal, but
they can pick different equal-weight alignments. The `looping-walk` fixture's
CIGARs still match upstream's, and each of the 99 unordered walks in the
all-samples AMY1 query, the longest 26,809 steps, gets the weight a full DP
gives it.

### Shared ends are trimmed at every split

The chaining search pays in time where Myers paid in memory, because its cost
follows the number of shared step pairs, and two walks looping the same node
thousands of times make millions of them. `solve` therefore matches the shared
prefix and suffix outright before chaining or splitting, at every level of the
recursion. Once a split lands inside a shared loop, both halves begin or end
with the same run, and the trim removes it. Synthetic walks, without and with
the trim:

| Input                                        | Untrimmed | Trimmed |
| -------------------------------------------- | --------- | ------- |
| One node looped 3,200 against 3,000 times    | 740 ms    | 4 ms    |
| Identical 5,000-step homopolymers            | 1.9 s     | 1 ms    |
| Two nodes alternating, 20,000 against 10,000 | 7.7 s     | 3 ms    |
| The 3,200/3,000 loop with its flanks swapped | 680 ms    | 400 ms  |
| AMY1-like: 8 variant copies against 3        | 9 ms      | 6 ms    |

The swapped-flank row is the shape the trim cannot reach: no split lands where
both halves share an end until the pairs are already paid for. No HPRC locus we
queried has that shape, and in the all-samples AMY1 profile the LCS is 121 ms of
18 s of CPU.

Two changes to the chaining measured within run-to-run noise and are not here:

- Chaining up to a fixed budget of pairs before splitting. Past about a million
  pairs it got slower, not faster.
- Storing each Fenwick node's maximum beside its column index, to skip an
  indirection per query.

## Walking from an anchor

`walkFromRow` follows `lf()` from a haplotype's anchor row through the window,
and keeps no visited set. `lf()` is a permutation of GBWT positions, so a walk
over well-formed data cannot revisit one, and the walk's bp bound already stops
any loop a corrupt record could make. The set it used to keep cost a
`node:offset` string per step. At AMY1 with all 231 samples kept, 5M steps,
dropping it left the output identical and took the walks phase from 8.2 to 6.6
s, and CPU from 9.2 to 8.4 s, averaged over three alternating runs.

## Covered elsewhere

[performance.md](performance.md) measures the rest:

- [What the step loops cost](performance.md#what-the-step-loops-cost):
  successors held as one flat pair of arrays rather than a buffer per node, and
  `orderedMatches` without a closure or tuple per match.
- [Why there is no wasm in the decoding path](performance.md#why-there-is-no-wasm-in-the-decoding-path),
  and why the compact output shape mattered more than any kernel.
- [Why a small window is not a cheap one](performance.md#why-a-small-window-is-not-a-cheap-one):
  the fragment length against the companion's sampling interval.

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

Those rows predate dropping the visited set.

SMN1/2 is the slow outlier, at 35 s and 754 MB with only 14 samples kept. One
haplotype's anchored walk passes its bp bound inside the inverted segmental
duplication, so the whole query falls back to the sampled route and identifies
paths across 18,534 samples. A walk able to cross that inversion would avoid the
fallback, and nobody has tried one.
