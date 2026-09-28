# Optimizations

Each section records a design choice and the measurement behind it. Unless
noted, we measured over HTTPS against HPRC v2.1 and its hosted haplotype index
with anchors, running `gbz-base-query` with `--keep`, `--cigar` and `--stats`.

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
steps, so memory is linear in the walk lengths. The two AMY1 fragments of that
size align in 3-8 ms each, where a linear-space Hirschberg DP took 155-419 ms.

Two walks looping through one node thousands of times make millions of shared
pairs, so `solve` trims the shared prefix and suffix at every level of the
split:

| Synthetic input                              | Untrimmed | Trimmed |
| -------------------------------------------- | --------- | ------- |
| One node looped 3,200 against 3,000 times    | 740 ms    | 4 ms    |
| Identical 5,000-step homopolymers            | 1.9 s     | 1 ms    |
| Two nodes alternating, 20,000 against 10,000 | 7.7 s     | 3 ms    |
| The 3,200/3,000 loop with its flanks swapped | 680 ms    | 400 ms  |

The trim helps least in the swapped-flank case, and no HPRC locus we queried has
that pattern.

## The keep route

We compared the keep route record for record with the sampled route on the same
subgraph, over 58 windows of the HPRC chr22 graph at `context` 0 and 1000 with
`snarls` none and contained, and over the HPRC v2.1 tutorial windows. Three
choices in the route came from those runs.

- **Walks between the anchors.** Chains that stop at a fixed distance outside
  the subgraph lost 109 of 1,561 pieces of eight haplotypes at KIV-2 with
  `context: 0`, at 32 kb and at 64 kb, because the copies of the repeat lie up
  to 105 kb apart along each haplotype. Walking each haplotype from its visit to
  the anchor before the window to its visit to the anchor after found all 1,561.
- **32 kb past the anchors.** A collapsed repeat puts a short second piece of
  every haplotype 30 kb from the window at IGL and 16 kb from it at GSTT. Chains
  that stopped when they reached the reference beside the subgraph lost every
  one of those pieces.
- **The twin from the other orientation.** In an 8 kb window at `context: 0`,
  the samples and chains reached all 43 pieces of eight haplotypes in the
  orientation `extractPaths` drops. Reading the samples of the other orientation
  by coordinate completed every twin tried, 85 of 85 over the chr22 runs.

## The step loops

`extractPaths` stores successors in one flat pair of arrays, where they had been
one `Int32Array` per node, and `orderedMatches` allocates no closure or tuple
per match. We timed warm queries, alternating the two builds in one process, and
report the median of five:

| Window       | Steps | Before   | After   | Ratio |
| ------------ | ----- | -------- | ------- | ----- |
| C4           | 0.20M | 0.085 s  | 0.059 s | 1.44x |
| CFH cluster  | 4.47M | 4.841 s  | 3.273 s | 1.48x |
| KIV-2        | 6.15M | 5.480 s  | 3.903 s | 1.40x |
| MHC class II | 9.86M | 10.516 s | 5.928 s | 1.77x |
| AMY1         | 4.59M | 2.819 s  | 2.236 s | 1.26x |

Output hashes are identical before and after at every locus.

## The compact output format

`toCompactSubgraph` packs only the step lists into typed arrays, because packing
saves time only on long fields. `structuredClone` times on a 200 kb chr20
window:

| field  | size                 | packed  | strings |
| ------ | -------------------- | ------- | ------- |
| steps  | 346,993 per window   | 1.9 ms  | 295 ms  |
| CIGARs | 323 chars average    | 0.20 ms | 0.09 ms |
| seqs   | 34 bp average, 5,943 | 1.07 ms | 0.95 ms |

Node sequences and CIGARs stay strings.

## Open problems

- A pass of a chosen haplotype through the subgraph can lie outside every walk
  and between two samples of its path. The query returns the result without it
  when every sample on the subgraph's nodes lies where its path's anchor visits
  place it, and identifies every walk when one lies elsewhere. The prototype of
  the route, which ran its walks and chains alone, returned every chosen piece
  outside LCR22 and IGL over 2,880 runs on 58 windows of HPRC chr22, and in
  those nine windows missed 2% of the chosen pieces, short passes 41 kb to 2.6
  Mb from the haplotype's other pieces. At `context` 100, 1,889 of the 1,907
  missed passes lay on stretches that GRCh38 passes far from the window, where
  an index built with `--reference-interval` contains GRCh38 samples, and at
  `context` 1000, 1,594 of 1,653 did
  ([haplotype-index.md](haplotype-index.md#keep)). The other passes lie on nodes
  GRCh38 does not visit, and only a sample of the haplotype can mark them; all
  220 at `context` 0, in one LCR22A window, are of that kind. GRCh38 visits each
  node of the chr22 graph once, so a table of the reference's self-overlaps
  would be empty. Given the stretches from the sampled route, walking the chosen
  haplotypes there cut the prototype's misses from 1,077 to 64 over 22 runs, at
  1.6 to 2.2 times its time. A query that takes the stretches from reference
  samples would still miss the passes on nodes GRCh38 does not visit, 35% of the
  missed passes at LCR22B, so it would still need the fallback.
- Identifying a walk piece shorter than the sampling interval scans the
  haplotype index, and 99.91% of those scans miss
  ([performance.md](performance.md#small-windows-at-the-same-locus)). Following
  such a piece through the GBWT directly would skip the scan.
