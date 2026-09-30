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
subgraph: over 58 windows of the HPRC chr22 graph at `context` 0 and 1000 with
`snarls` none and contained, over the HPRC v2.1 tutorial windows, and over the
genome-wide windows in
[haplotype-index.md](haplotype-index.md#measured-on-hprc-v21). Four choices in
the route came from those runs.

- **Walks between the anchors.** Chains that stop at a fixed distance outside
  the subgraph lost 109 of 1,561 pieces of eight haplotypes at KIV-2 with
  `context: 0`, at 32 kb and at 64 kb, because the copies of the repeat lie up
  to 105 kb apart along each haplotype. Walking each haplotype from its visit to
  the anchor before the window to its visit to the anchor after found all 1,561.
- **Stray rows.** A route that placed each haplotype from its anchor visits and
  the samples in the window dropped 585 pieces in 9,000 queries on HPRC v2.1:
  unplaced contigs of a chosen haplotype, passes through collapsed repeats far
  along a contig, and the stretch of a contig before its first anchor visit.
  `gbz-haplotype-index` walks every path from end to end, so it finds each of
  those stretches and writes it as a stray row.
- **Node lists per bin.** A first version of the stray rows gave each node one
  reference position, the nearest. A node beside an edge that joins two distant
  reference nodes had the position of the near end alone, so a window at the far
  end read no row for it, and 52 pieces dropped in 9,000 queries. The indexer
  now runs one search per bin and lists the bin's nodes, and the query checks
  its subgraph against the lists of the bins it touches.
- **The twin from the other orientation.** In an 8 kb window at `context: 0`,
  the walks reached all 43 pieces of eight haplotypes in the orientation
  `extractPaths` drops. A reverse-orientation sample in the window gives the
  twin's position. For a piece without one, reading the samples of the other
  orientation by coordinate past the piece's end completed every twin tried, 85
  of 85 over the chr22 runs.

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

- A query that uses the `keep` option with `snarls: 'overlapping'` identifies
  every walk when it fills a snarl. The far boundary node of such a snarl lies
  outside the node lists, so the stray rows would need the visits to every snarl
  boundary, listed in the bins of the other boundary.
- Identifying a walk piece shorter than the sampling interval scans the
  haplotype index, and 99.91% of those scans miss
  ([performance.md](performance.md#small-windows-at-the-same-locus)). Following
  such a piece through the GBWT directly would skip the scan.
