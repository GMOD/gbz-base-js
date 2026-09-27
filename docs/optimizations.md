# Optimizations

Design choices, each with the measurement behind it. Unless noted, measured over
HTTPS against HPRC v2.1 and its hosted anchored companion, with `--keep`,
`--cigar` and `--stats`.

## Aligning a walk to the reference

`editsAgainst` first matches each shared node to its earliest usable position on
the reference, in linear time. Walks that visit shared nodes out of order use
`weightedLcs` instead. On HPRC only AMY1 needs it: 100 of 957 records with all
231 samples kept.

gbwt-rs uses a Myers-style search whose memory grows with edit distance in
bases. A port of it ran out of a 3 GB heap in about 30 s on one AMY1 fragment
(13,303 steps, 230,857 bp, against a 7,585-step reference). `weightedLcs` chains
the step pairs that share a node as a heaviest increasing subsequence over a
Fenwick tree, and splits the problem Hirschberg-style once pairs outnumber
steps, so memory is linear in the walks. The two AMY1 fragments of that size
align in 3-8 ms each, where a linear-space Hirschberg DP took 155-419 ms.

Two walks looping through one node thousands of times make millions of shared
pairs, so `solve` trims the shared prefix and suffix at every level of the
split:

| Synthetic input                              | Untrimmed | Trimmed |
| -------------------------------------------- | --------- | ------- |
| One node looped 3,200 against 3,000 times    | 740 ms    | 4 ms    |
| Identical 5,000-step homopolymers            | 1.9 s     | 1 ms    |
| Two nodes alternating, 20,000 against 10,000 | 7.7 s     | 3 ms    |
| The 3,200/3,000 loop with its flanks swapped | 680 ms    | 400 ms  |

The trim helps least in the swapped-flank case, a pattern absent from every HPRC
locus we queried.

## Walking from an anchor

`walkFromRow` keeps no visited set. `lf()` is a permutation of GBWT positions,
so a walk over valid data is loop-free, and the walk's bp limit stops a corrupt
one. Dropping the set took AMY1 (231 samples, 5M steps) from 8.2 to 6.6 s.

## The step loops

`extractPaths` stores successors in one flat pair of arrays, where they had been
one `Int32Array` per node, and `orderedMatches` allocates no closure or tuple
per match. Warm, both builds alternated in one process, median of five:

| Window       | Steps | Before   | After   | Ratio |
| ------------ | ----- | -------- | ------- | ----- |
| C4           | 0.20M | 0.085 s  | 0.059 s | 1.44x |
| CFH cluster  | 4.47M | 4.841 s  | 3.273 s | 1.48x |
| KIV-2        | 6.15M | 5.480 s  | 3.903 s | 1.40x |
| MHC class II | 9.86M | 10.516 s | 5.928 s | 1.77x |
| AMY1         | 4.59M | 2.819 s  | 2.236 s | 1.26x |

Output hashes are identical before and after at every locus.

## The compact output format

`toCompactSubgraph` packs only the step lists into typed arrays, since packing
pays off only for long fields. `structuredClone` times on a 200 kb chr20 window:

| field  | size                 | packed  | strings |
| ------ | -------------------- | ------- | ------- |
| steps  | 346,993 per window   | 1.9 ms  | 295 ms  |
| CIGARs | 323 chars average    | 0.20 ms | 0.09 ms |
| seqs   | 34 bp average, 5,943 | 1.07 ms | 0.95 ms |

Node sequences and CIGARs stay strings.

## Open problems

- SMN1/2 takes 35 s with 14 samples kept: one anchored walk hits its bp limit in
  the inverted segmental duplication, and the query falls back to the sampled
  route.
- Naming a walk piece shorter than the sampling interval scans the index, and
  99.91% of those scans miss
  ([performance.md](performance.md#small-windows-at-the-same-locus)). Walking
  such a piece directly would skip the scan.
