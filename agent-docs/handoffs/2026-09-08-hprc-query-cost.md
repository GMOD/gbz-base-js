# Handoff, 2026-09-08: what an HPRC window costs, and the format proposal that was wrong

One session, three outputs: an optimization that landed (`d42e8ec`), a set of
corrections to numbers that session itself had published (`e58306e`), and a
coarse-format proposal that an independent review killed. The third is the most
useful thing here, because it was killed for a reason nobody should have to
rediscover.

## What landed

`d42e8ec` — three data-shape changes in `src/subgraph.ts`, no behaviour change:

- `extractPaths` held successors as an `Int32Array` per node, so `walk()` made a
  pointer chase into one of forty thousand scattered buffers on every step. Now
  one flat pair indexed by `rowStart[node] + offset`.
- `orderedMatches` allocated a closure per step for `Array.find` and returned a
  two-element array per match. Now a binary search (`firstAbove`) returning two
  parallel `Int32Array`s.
- `editsAgainst` skips `alignGap` between adjacent matches; `alignment()` skips
  both `sharedWeight` bounds when `pathIsCanonical(ref)`.

**1.3-1.8x**, measured with both builds open in one process and alternated.
Output is byte-identical at five HPRC loci over 2 MB to 101 MB of output,
checked independently twice. AMY1 gains least (1.26x) despite having the most
walks, so per-walk allocation is not what pays.

`e58306e` — corrections, below.

## The three numbers this session got wrong

Recorded because each has a repeatable cause, not because they were unlucky.

- **1.4-2.1x** for the optimization. Old and new were benchmarked in separate
  processes at different times, which credited the change with machine load.
  Interleaved it is 1.3-1.8x and CFH's claimed 2.12x does not reproduce at all.
  _Benchmark two builds by alternating them in one process._
- **9.5x** for a chosen haplotype set. Measured with `snarls` left at its
  default and then compared against a table built with `contained`. Like for
  like it is 6.9x before `d42e8ec` and **4.6x** after — halving the
  464-haplotype side and leaving the eight-haplotype side alone necessarily
  shrinks the ratio, which the commit claiming 9.5x "still" held had backwards.
  _An optimization can invalidate a ratio it is not part of._
- **"CPU-bound, not network-bound."** True, and the conclusion drawn was too
  strong: the measurement re-ran the _identical_ window, which is the least
  representative case. A window the session has not visited still fetches. The
  numbers are in `docs/performance.md` § "Where that inverts".

## What an HPRC window actually costs

Cost is `walks × steps`, and both factors are large: MHC class II is 464 walks
of ~21,251 steps, 9.86M steps, each touched twice (once to extract, once to
align). `docs/performance.md` has the phase tables, the window sweep, and the
small-window mechanism.

The two findings worth carrying forward:

- **A small window is not a cheap one.** Below ~45 kb the walks arrive in
  pieces, a piece is shorter than the companion's 16,384 sampling interval, and
  identification scans for a sample it almost never finds — **480,915 misses out
  of 481,353 seeks**. `identifyPaths` is 4-7 s there against 0.1 s at 90 kb. The
  threshold is on the fragment, not the window: a 20 kb window's median fragment
  is 4.5 kb. A fragment known to be shorter than the interval could skip the
  scan and walk directly. That is an unclaimed optimization in this reader.
- **Selection is the only lever that moves the floor.** 4.6x for eight of 464.
  Everything needed for it already existed except the argument that carried it;
  see below.

## The highest-value change was not in this repo — done 2026-09-08

`GbzBaseSyntenyAdapter.getFeatures` had always accepted `opts.haplotypes` and
built a `keep` predicate, and the reader had the anchored walk route behind it.
`MultiWaySyntenyDisplay` held `laneSelection` and never passed it, so a track
opened on eight lanes fetched all 464 and `rowAssemblies` discarded 456.

Fixed in jbrowse-components `d3593f5440` (committed, NOT pushed — that repo's
pre-push hook runs whole-tree fixers that would rewrite other agents'
uncommitted work, and others were active). Worth **4.6x**: 4.13 s for all 464
against 0.90 s for eight, warm, at MHC class II.

Two things worth knowing before touching that area again:

- The term rides in `rpcProps()`, which the display did not have at all, so
  `rpcPropsCacheKey` was `''` and no selection could invalidate held data.
  `KeyedFetchMixin` documents that as the sanctioned axis and warns specifically
  against folding a settings term into `viewSignature` by hand.
- It is gated on `adapterDeclaresLanes`. `GbzBaseSyntenyAdapter` is the only
  adapter anywhere that declares `headerLanes`, so every PIF and MAF multiway
  track is untouched and is not made to refetch for a filter it ignores.

`pangenome_hprc_part3.md` said the opposite in as many words and was corrected
in the same commit.

## The format proposal, and why it was wrong

The reasoning was: the graph is fine-grained in both position and cohort, so
build a tier that is coarse in both. HPRC's `pgbi.vcf.gz` (one row per snarl,
`AT` traversals, `AC`/`AF`/`AN`, `LV`) looked like the right source, projected
with `bcftools query -i 'LV=0'` down to coordinates + sizes + allele frequency.
It measured beautifully: 258 MB to 0.92 MB on a 10 Mb window, and the ≥50 bp
tier was 120 rows.

**It was wrong twice.**

`LV=0` silently drops every row with no `LV` field, and those are the long
alleles. On `chr6:30,000,000-40,000,000`: 206,037 rows, 68,995 with no `LV`; max
`REF` is **602 bp on `LV` rows against 96,914 bp on the rows the filter drops**.
Counting ≥50 bp events directly, 4,224 exist and the filter keeps 120 — **97%
lost**. The "≥10 bp cliff" that made the tier look so cheap was that artifact.
This is already recorded in jbrowse-components:
`agent-docs/reference/PANGENOME_GRAPHS.md` ("Records with no `LV` field are the
long alleles") and `HPRC_RELEASE2.md` § "What the `LV==0` filter costs,
measured".

And the file already exists.
**`https://jbrowse.org/demos/hprc/hprc-v2.1-mc-grch38.bubbles.bed.gz`** — the
same prefix as the companion index this reader opens. Same 10 Mb window: **471
rows against the proposal's 137,042**, with more ≥50 bp features and 6.5x more
≥1 kb features, already carrying segment count, walk count, shortest and longest
allele. jbrowse-components builds it with `scripts/snarls_to_bubble_bed.py` and
`scripts/build_bubble_tier.sh`, whose own notes say a zero threshold "gives one
node per SNP (worse than the fine index)" — which is exactly the 90.6%-SNV tier
the proposal produced.

Two process lessons, both cheap:

- **Threshold on content, never on reference span.** A pure insertion is an
  alternative to nothing, so `end - start` is zero for it; 72% of the proposal's
  ≥50 bp rows had `refBp == 1`. `PANGENOME_GRAPHS.md` states this rule already.
- **Checking the parked ideas index is not enough.** The proposal was checked
  against `agent-docs/ideas/` and cleared. What it duplicated lived in
  `scripts/` and `agent-docs/reference/`. Grep the scripts and the reference
  docs too.

The one genuinely unclaimed piece is joining `AF` onto the existing bubble track
so both panels can colour by allele frequency — already parked as a line in
jbrowse-components `agent-docs/ideas/pangenome-figures-unshot.md`. One column,
not a format.

## Open, in rough order of value

- Push jbrowse-components `d3593f5440` once that checkout is quiet.
- Skip the companion scan for a fragment shorter than the sampling interval.
  99.91% of those seeks miss.
- `extractPaths` holds the per-node arrays and the flat pair at once before
  dropping the former; the peak could be avoided by writing `runs()` straight
  into the flat arrays. Steady state already improved (335 MB to 311 MB after
  the phase at MHC class II).
- A corrupt GBWT record now writes into a neighbour's row rather than being
  ignored, because the flat index is unchecked where the per-node one was
  implicitly bounded. Well-formed data cannot reach it.
- `asMatches` and the non-canonical-reference branch of `alignment()` are not
  exercised by any test — `--stats` reports 0 LCS alignments at every locus
  tried, and the canonical branch covers all five loci. Their equivalence was
  argued and hand-verified, not tested.

## Reproducing any of this

`scripts/measure-windows.mjs` and `scripts/time-phases.mjs` are the committed
tools. The session's throwaway probes are not kept; what they measured is in
`docs/performance.md`, which is the reason to read it rather than re-derive. The
graph and the anchored companion are both hosted — the URLs are in
`test/hprc.test.ts`.
