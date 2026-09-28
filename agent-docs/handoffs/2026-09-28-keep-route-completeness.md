# Handoff, 2026-09-28: how the keep route loses walks, what is fixed, and the plan to close the rest

This session started from a spike on the keep route's residual misses and ended
somewhere larger: an adversarial review (round 4, by a Fable agent) found five
ways the keep route drops a chosen haplotype's walk without falling back, three
of them on real HPRC chr22 data. Three of the five are fixed here. The other two
need data the haplotype index does not hold today, and closing them is a format
decision for the user. A separate bug in alignment records, found by the
graphgenomeviewer plugin session, is also fixed.

Read this first if you pick up keep-route work, the haplotype index format, or
the genome-wide validation sweep.

## Why this matters

A query that uses the `keep` option returns the walks of a few chosen
haplotypes. The sampled route identifies every walk in the window (about 464 on
HPRC) and drops the rest; the keep route (4.0.0) reads the anchor rows around
the window and walks only the chosen haplotypes. Its contract is exact parity
with the sampled route narrowed by `keepHaplotypes`, and it falls back to the
sampled route whenever a check says it cannot prove its walks complete.

The keep route never returns a wrong record: every piece starts at a position
the index names and is followed through the GBWT (review claim C0, confirmed
over every parity run: 0 keep-only records). Every failure is an omission, and
an omission is silent. In the plugin a missing piece or a missing haplotype
reads as a deletion, which is exactly the kind of false call a user acts on.

The speed the keep route buys is real but moderate: with pages cached on a local
chr22 file, medians of 87-136 ms against 688-764 ms for the sampled route; over
HTTPS on first open, 7-37% faster, because range requests dominate
(`docs/performance.md`). That ratio is why a silent omission is not an
acceptable price, and why falling back is always an acceptable answer.

## The limit underneath

A GBWT position does not record which path it belongs to. Upstream says so
directly (Sirén et al., "GBZ-base and GAF-base: Indexed pangenome file formats",
bioRxiv 10.64898/2026.07.10.737775): "We cannot identify the other haplotypes or
determine their coordinates, as GBZ-base currently lacks the data structures for
that", and of their own reference index at 1,024 bp, "we can afford indexing
some haplotypes but not hundreds of them". The upstream source says "Other paths
remain anonymous, as we cannot identify them efficiently using the GBWT".

Our sidecar haplotype index is a sampled document array: a sample every
`--interval` bp along each path, plus every visit at the anchor nodes. The
sampled route pays for exactness by walking each walk to a sample. The keep
route infers from sparse samples that nothing else is there, and sparse samples
cannot prove a negative, which is why every review round has found a new silent
mode (round 1 inversions, round 2 haplotypes with no anchor visit, round 3 far
passes, round 4 the five below).

The exact structure exists: an r-index (`FastLocate` in the C++ GBWT, which the
Rust GBWT loads and discards: "We cannot interpret the document array samples
from the C++ implementation"). We could build one without forking anything,
because the `gbz` crate exposes record runs. We measured why we should not:
chr22 has 1.26 billion GBWT positions in 17.9 million BWT runs (about 70
positions per run, sampled every 50th record), so one sample per run is about 7x
our current chr22 index, roughly 50 GB for HPRC as SQLite rows, and naming the
464 visits at one node takes hundreds of random page reads over HTTP.

So the strategy is not brute-force exactness. It is: enumerate the structural
causes of omission, give the query a deterministic trigger for each from small
index tables built by the indexer (which walks every path in full and can see
every cause), fall back when a trigger fires, and measure at genome scale to
find causes nobody has enumerated yet.

## The omission modes

Numbered as in the review (`~/keep-route-lab/review2/REPORT.md`).

| Mode | Cause                                                                                                                                                        | What a viewer shows                                                     | State                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `context` crosses a rare edge (one haplotype's rearrangement) into a reference stretch 270-670 kb away (IGL)                                                 | 100-300 bp pieces of every chosen haplotype at that stretch are missing | Open. The sample check catches it when a sample lands there; `--reference-interval` helps at `context` 1000 only                                                                                   |
| 2    | Collapsed paralog: a chosen haplotype passes the window's nodes again from a copy far away, often on nodes GRCh38 does not visit, with no sample on the pass | the extra copy's piece is missing; the local pass is intact             | Open. 26 real dropped pieces on chr22, all within 5 kb of an anchor node some haplotype visits twice                                                                                               |
| 3    | A chosen contig with no row at the six anchors read and no sample in the subgraph, while another chosen haplotype was seen                                   | the haplotype's pass, possibly the whole haplotype, is missing          | Fixed for a fragment next to a sibling fragment that passes the anchors. Open for the rest, including most real chr22 cases, where the sibling seen is a copy megabases away in contig coordinates |
| 4    | A path visits an anchor from two copies of the region; `plan()` paired one visit and ignored the other, and the sample check trusted the hull between them   | the second copy's pass is missing                                       | Fixed: the query falls back                                                                                                                                                                        |
| 5    | The sample check allowed 32 kb past the anchor visits, the walk stopped 32 kb past the last piece                                                            | pieces in between are missing                                           | Fixed: walks cover the band, the band is halved                                                                                                                                                    |

Mode 3 is the one to worry about most, because it can hide a whole haplotype and
because the plugin draws small windows. In the review's targeted run (500 bp
windows on chr22's anchor-less paths, 32 kb anchors), 6 of 10 single-haplotype
queries that stayed on the keep route were wrong; with `keep = all` at
chr22:12,034,905 six paths dropped, CHM13's own chr22 fragment at 422,246 among
them. Minigraph-cactus splits contigs into fragments, each its own path; a
fragment shorter than two anchor spacings can lie between anchors with start and
end samples only, and `keep` by sample or haplotype accepts another path of the
same haplotype, so the route sees "another chosen haplotype" and does not fall
back. The fragments are often not neighbours: at 12,034,905,
`HG00097#2#CM094088.1[521665]` (25 kb) is dropped while
`HG00097#2#CM094088.1[6743574]`, 6.2 Mb further along the same contig, passes
the anchors, so the contig carries two copies of the region and the case is as
much mode 2 as mode 3. Exposure on the hosted index: 10,821 of 53,150 paths are
shorter than 262 kb, 1,753 shorter than the 16 kb interval.

## What changed in this session

### Keep route, branch `keep-fixes` (commits `09c5bd5`, `665e4bb`)

- **Mode 5.** Walks run until they are 32 kb past both their stop and the last
  piece, and back until 32 kb before both the near visit and the first piece
  (`reach = CHAIN_BOUND` from the visit), so a walk covers every offset the
  check allows its path. The check's band is `SAMPLE_BAND = CHAIN_BOUND / 2`,
  which leaves 16 kb for an indel between a sentinel path's coordinates and a
  chosen path's. The reference prefetch widens by 32 kb each side to match.
- **Mode 4.** `plan()` builds each path's loci from its paired intervals, plus
  each visit no pair used as a point, or `visit +- stretch` for a path paired
  nowhere; `mergeRanges` merges them within 32 kb. Two or more loci throw a
  fallback ("visits the anchors from N copies of the region"), for any path at
  the anchors, chosen or not, because a sentinel's hull is what blinded the
  check. The unit is the visit, not the row: every visit has a row in each
  orientation at the same offset, and the reverse row of an ordinary path never
  pairs.
- **Mode 3, neighbouring fragments.** A chosen path with no row and no sample
  whose name shares sample, haplotype and contig with a placed chosen path, and
  whose contig range (`name.fragment` + length) meets that sibling's span +- 32
  kb in contig coordinates, joins the unplaced paths: walked whole if short, a
  fallback if longer than `outerStretch + 64 kb`. On the review's real chr22
  windows it recovers `NA20805#2#CM091907.1[548360]` (4 queries) and misses the
  far-copy fragments described above, which need table A or B below.
- **Extra visits near the pairs** (`665e4bb`). A chosen path's visit that no
  pair used but that lies within 32 kb of the paired stretch, as a tandem copy
  of an anchor node gives, gets its own walk 32 kb to each side. A visit farther
  out still means two copies and a fallback.
- Two inversion tests changed expectations, both still exact: a walk that
  reaches the fixture's end now ends at `endmarker`, and the "runs on past"
  fallback is exercised by hiding the rows on the near side instead, since the
  longer walk now reaches the contig's end on the far side (and is trusted,
  which is correct: the walk saw the whole rest of the contig).
- New fixtures `test/data/two-copies.gfa` and `far-pass.gfa` with
  `test/keepCoverage.test.ts`. On them the old route returned 40 of 69 queries
  wrong with no fallback; now all 69 match the sampled route (two-copies falls
  back, far-pass answers on the keep route).

Earlier commits on the same branch (from the spike): `4e9eec4` indexer
`--reference-interval`; `485f9da` `test/data/far-stretch.gfa`, a mode 1 fixture
whose sparse index gives a wrong answer and whose dense index falls back;
`00e98c3` docs, since corrected (the IGL mechanism, and the reference
self-overlap table the old open-problems entry proposed, which would be empty:
GRCh38 visits each node of the chr22 graph once).

### Alignment records, branch `join-pieces` (commits `0460e1b`, `5b73baa`)

Found by the plugin session comparing graph-derived synteny with HPRC's PAF at
GSTM1 (chr1:109,660,000-109,706,000, context 1000): 85 of 463 haplotypes read as
18.4 kb deletions where the PAF shows an 18,445 bp replacement by an unmerged
GSTM1 copy. `alignments()` aligned each piece of a walk alone and joined two
pieces only when the second started past the first's reference end. The first
piece's tail passed reference nodes near the window's end, so the ranges
overlapped, the join refused, and the 16 kb outside the subgraph was in neither
record. Now:

- Pieces that overlap on the reference are aligned again as one walk, with the
  unseen bases as an insertion of their known length (`hapStart` difference).
  Each end of a join must be aligned over at least half its length alone and
  keep at least half its aligned bases jointly (CIGAR M bases, not shared nodes:
  an unmerged copy can align by sequence alone). Pieces between the two ends,
  often most of the detour, join whatever their alignment. The first rule
  matters: at IGL, far pieces align to nothing on the window's reference walk,
  and without it they folded into records with 683 kb leading insertions (caught
  by the chr22 dump before commit).
- A record starts and ends at an aligned base: deletions inside a leading or
  trailing run of I/D move `refStart`/`refEnd`.
- GSTM1 (`5b73baa`): 552 records to 464 for 463 haplotypes; all 84 haplotypes
  the PAF shows as a replacement read as a >10 kb D beside a >10 kb I (NA18943#2
  and NA18971#1 as `18445D 20M 24436I 4784M`, the context-20000 shape), 307 keep
  a plain 18,445 bp D (GSTM1's common null allele), and the one haplotype with
  two records is HG03521#2, two contigs. The plugin session confirmed this
  independently from `src/`: PAF agreement 99.742% same base, 99.988% within 100
  bp, CFH unchanged at 99.697% / 99.998%. chr22 suite, all haplotypes, contexts
  100 and 1000: 9,996 records join another, 11,495 lose an end deletion, nothing
  else changes; records with a >100 kb insertion 6,967 before, 6,978 after.
- Cost: `alignments()` over all haplotypes takes up to 2.7x as long where pieces
  join (LCR22A 100kb 0.8 s to 1.8 s, r12 0.16 s to 0.43 s, IGL unchanged),
  because each attempt aligns the whole concatenated walk. With `keep` only the
  chosen walks are aligned.

The remaining PAF difference is a 20 bp tie-break inside the whole-walk aligner,
not the join: the detour walk visits reference 109,702,357-376 twice, entering
and leaving, and `orderedMatches` takes the first visit (`18445D 20M 18445I`)
where the PAF takes the second (`18445D 18445I 4804M`). Preferring the visit
that extends the longer contiguous match would close it (1,486 bases, 20 per
joined haplotype). The plugin session's scripts are
`~/keep-route-lab/joins/compare.py` and `categorize.py` (copies), with its PAF
slice in its own scratchpad. It asked to be told when this is released, so the
plugin needs only a version bump.

## Validation so far

On the `keep-fixes` code (the suite run started at `09c5bd5`; the targeted runs
at `09c5bd5` and `665e4bb`):

- chr22 suite, contexts 100 and 1000, five keep sets
  (`ri/fixes-parity- ri16384.jsonl`, still running at the handoff): 0 of 492
  differ; 8 queries moved from the keep route to a fallback (LCR22D 100kb,
  LCR22A 4kb, all "two copies"), none the other way.
- The review's targeted mode 3 windows (`review2/fixes-mode3-s32k.jsonl`, still
  running): after 62 queries, 30 still drop pieces (74) where the old code
  dropped in 49 (241). The rest are the far-copy fragments that need table A or
  B.
- The 20 queries that dropped pieces in the review's mode 4 runs
  (`review2/fixes-mode4-wrong*.jsonl`): 18 now match, by falling back ("two
  copies"). Two remain wrong: window `after@2599637` (chr22:21,431,272, 32 kb
  anchors, `idx-s32k-grch38.db`), `keep = all` with `mostChosenPaths` raised,
  contexts 0 and 100, one piece of `HG00126#1#JBHIKU010000055.1[232]` each. That
  fragment's inverted copy pairs visits at 83,803 and 57,529 and has a third at
  24,851, 32,678 bp from the pair, and its pass over the window is at
  offset 927. The extra-visit walk in `665e4bb` did not recover it; not yet
  debugged. Start there.
- Keep-only records: 0 in every run.

Baselines on the old code, chr22, five keep sets, 58 windows: contexts 0 and
1000 (`libparity2-*.jsonl`): 0 of 1,160 differ. Context 100 (never run before
this session, although it is the library's default; `ctx100-*.jsonl`): 0 of 580
differ with 32 kb anchors (464 on the keep route) and 0 of 580 with 131 kb
(472). With the far-sample check off, IGL 200kb, IGL 50kb b and LCR22A-par 20kb
go wrong, so that check is what holds those windows today. None of these suites
found modes 2-5: they had to be targeted (anchor-less paths, anchors some path
visits twice) to show up. Untargeted parity is not evidence of completeness.

## The plan

### A. A node-to-locus table in the haplotype index (modes 1 and 2)

What: for each node, the reference locus of each distinct pass through it. The
indexer knows, while walking a path, the last anchor it passed and that anchor's
reference offset, so a visit's locus estimate is
`anchor reference offset + (path offset - path offset at that anchor)`; loci of
one node within 32 kb merge.

Why: the query can then ask of every subgraph node whether any pass through it
belongs to a locus outside `[anchorBefore - 32 kb, anchorAfter + 32 kb]`. That
is the deterministic form of the far-sample check, at any `context`: mode 1's
far stretches and mode 2's far passes both show up as nodes with a far locus,
whether or not a sample landed there. It also subsumes F2 (the "excursions"
table the review rejected as blind to private nodes) and makes
`--reference-interval` unnecessary.

Size (review's estimates): reference nodes only, 4 bytes for ~45% of nodes,
about 250 MB for HPRC (~3% of the index); every node, 4 bytes x 139.5 M = 558 MB
(~7%). Nodes with several loci need every locus, not one: min/max per node (8
bytes) detects a far locus, the full set lets the query walk there. chr22 has
107k nodes some path visits twice; the multi-locus count is unmeasured. Node ids
are not monotone along GRCh38 (718k monotone runs over chr22's 1.39M reference
nodes, `review2/refmap.ts`), so run-length coding buys little.

Query side, in two steps:

1. Trigger: scan the table over the subgraph's handle runs (the shape of the
   sample scan) and fall back on any far locus. Deterministic, simple, and the
   duplication windows already fall back most of the time.
2. Answer: bracket each far locus with its own anchors, `plan()` there, and walk
   the chosen paths, so those windows answer on the keep route. The review's
   oracle measured the payoff of walking at the right loci: misses 1,077 to 64
   over 22 runs at 1.6-2.2x the time. Only after step 1 has a sweep behind it.

Open questions: the first-visitor problem (a node first seen from its far copy
would make the local passes look like excursions, so store every locus, not the
first); per-node encoding and page layout for range reads; CHM13 as the query
reference (anchors are on GRCh38 only with `--anchor-sample GRCh38`).

### B. An anchor-less contig table (mode 3, independent contigs)

Every path with no anchor visit, and every run of six or more anchor multiples a
path skips between two visits, with its reference extent. Extent comes from the
reference nodes the path shares, or failing that the first reference nodes
reached by following its ends outward through the GBWT (with table A, from the
loci). 38 of chr22's 49 anchor-less paths (32 kb anchors) share no node with
GRCh38 and reach a window only through context or snarls. Size is negligible: 49
or 122 rows on chr22 at 32 kb or 131 kb anchors; the hosted count is unmeasured.
Query: one range scan keyed by (reference path, extent start), then walk the
chosen ones whole, or fall back when long. This replaces the fragment heuristic
in `09c5bd5` in the end, but that heuristic needs no format change and covers
the case the review found on real data.

### C. `--reference-interval`

Keep or drop after A. Measured on chr22, counting samples in both orientations
(the check reads both; the review counted forward only and got lower numbers):
256 bp covers 57/57 far stretches at `context` 1000 and 48/59 at 100, and is
deterministic only for stretches longer than interval + longest node. Index
+9.8% (256), +15.8% (128), +3.5% (1,024) on chr22; +0.7-1.1 GB estimated on the
hosted index. Per byte it is the weakest option. The recommended build commands
no longer pass it.

### D. Smaller items

- The unplaced-length rule (`outerStretch + 2 * CHAIN_BOUND`, about 260 kb with
  32 kb anchors, 850 kb with the hosted 131 kb) treats a non-chosen paralog
  contig under that length as local, so it never serves as a sentinel.
- `stats` could report the number of unidentified walks in the subgraph, a hard
  upper bound on omissions, free from the records already fetched (review).
- The anchor rule prefers collapsed nodes (most GBWT positions in the half
  spacing), which is what puts two-copy visits on anchors: 593 (path, anchor)
  pairs on 37 of 1,551 chr22 anchor nodes. Preferring the most visited node no
  path visits twice would move anchors off duplications (indexer change, cheap).
- Joint alignment cost: align only the junction between two pieces instead of
  the whole concatenation.
- The 20 bp tie-break in `orderedMatches` above.
- The review's `chain2.sh` may still be writing `review2/random-parity.jsonl`
  (125 random windows, old code): summarize it with
  `python3 classify.py idx-s32k-grch38.db random-parity.jsonl` for a base rate.
- A record that starts with a spurious 1-3 bp base match before a long deletion
  (`3M118I66077D...`, seen in random chr22 windows) is not trimmed, because the
  trim stops at the first M; joining hides it in those windows, but a lone piece
  keeps it.

### E. Whole walks for the plugin (keep's contract)

The plugin's pair route (`pairAlignments`) and graph view need the detour's
nodes, not just a correct CIGAR: two haplotypes that share the unmerged GSTM1
copy should align to each other through it, and the graph view should draw the
detour as a loop. The keep route already walks those nodes (5,090 records
outside the subgraph at GSTM1) and drops them to match the sampled route, which
cannot see them. Returning them changes the contract, so it is the user's
decision; it also resolves modes 1 and 2 for keep by definition (far pieces are
not part of the local walk) at the cost of no longer showing a collapsed copy's
second pass.

## Validation plan

1. Fixtures, one per mode, each proven to fail on the old code before the fix:
   `far-stretch` (1), `two-copies` (4), `far-pass` (5 and fragments), `detour`
   (record joins). Add one per new mode as it is found.
2. chr22 lab suites after each change: `libparity.ts` (58 windows x contexts 0,
   100, 1000 x five keep sets), the review's targeted configs
   (`review2/mode3-configs-*.json`, `mode4-config.json`,
   `mode4-single-configs.json`), classified with `review2/classify.py`.
3. The genome-wide sweep on the hosted database, designed in the review (section
   4): about 1,500 windows, log-uniform 300 bp-100 kb, in six strata: 600 random
   by chromosome length; 300 in segmental duplications (`genomicSuperDups` >=
   95%); 300 small windows in short anchor-less paths (from the hosted index);
   100 beside anchors some path visits twice; 100 at chromosome ends,
   acrocentric p-arms and pericentromeres; 100 with CHM13 as the query
   reference. Contexts (100, none) and (1000, contained). Keep sets: one random
   haplotype, one random sample (both haplotypes, which is what turns a fragment
   into mode 3), the eight; and `keep = all` with `mostChosenPaths` raised on
   the SD windows, which exposes every omission at once. Per query: route,
   records, `keepOnly` (must be 0), `sampledOnly`, `unresolved` (must be 0, else
   the oracle is broken for that window), and per omission the path, coordinate
   and distance from its nearest anchor visit so the mode classifies itself.
   Budget measured on 28 hosted queries: keep median 2.2 s, 0.85 MB graph and
   1.0 MB index per query; about 3-5 hours and 20-40 GB of range reads at 3
   workers, plus 5-15 hours for `keep = all`. The load falls on S3 (the
   database) and jbrowse.org (the index), so run it only with the user's
   go-ahead.
4. Run the sweep twice: now, on the hosted index with the `keep-fixes` code, for
   the rate of what remains; and after A and B with a rebuilt index. Acceptance:
   `keepOnly` 0 everywhere, `sampledOnly` 0 outside a documented residual.

## Decisions pending

- Land `keep-fixes` and `join-pieces` on main. Both pass lint, typecheck, format
  and tests. They touch the same paragraph of `CONTRIBUTING.md`, so the second
  rebase needs a one-line merge. Then release, which the plugin session is
  waiting on (it needs only a version bump; the `join-pieces` fix is what it
  asked for).
- Index format additions A and B, and rebuilding the hosted index with them.
- The sweep's load on S3 and jbrowse.org.
- Keep's contract (section E), which the plugin session is waiting on.
- `--reference-interval`: keep as an option, or drop once A exists.

## Where things are

- Worktrees: `.claude/worktrees/keep-fixes` (branch `keep-fixes`: spike commits
  plus the fixes), `.claude/worktrees/join-pieces` (branch `join-pieces`, from
  main), `.claude/worktrees/dup-spike` (branch `worktree-dup-spike`, frozen
  while the review's `chain2.sh` imports its `src/`; its one uncommitted line is
  the `keepTuning.farSampleFallback` toggle the lab harnesses set, never to
  land).
- Lab: `~/keep-route-lab`. Testbed `chr22.gbz.db`; indexes
  `idx-ri{16384,1024, 512,256,128}.db`
  (`--interval 16384 --anchor-spacing 32768 --anchor-sample GRCh38 --reference-interval N`),
  `idx-s32k-grch38.db`, `idx-s131k.db`. Harnesses `libparity.ts` (imports
  `dup-spike`) and `ri/libparity-fixes.ts` (imports `keep-fixes`);
  `ri/farcheck.ts` (sample-check coverage per index). Results `libparity2-*`,
  `ctx100-*`, `ri/parity-*`, `ri/fixes-*`.
- Review: `~/keep-route-lab/review2/` (`REPORT.md`, `classify.py`, `parity.ts`,
  `parity-fixes.ts`, fixtures in `fixture/`, targeted configs, hosted pilot).
- Upstream crates, for reading their code: `~/.cargo/registry/src/*/gbz-0.7.0`,
  `gbz-base-0.6.2`. Full HPRC GBZ:
  `~/tutorial_spikes/pp_v2/hprc-v2.1-mc-grch38.gbz`.

## Pitfalls met this session

- Counting samples forward-only undercounts what the check sees: the subgraph
  stores both orientations of every node (`src/subgraph.ts:540-541`).
- A harness that imports a worktree's `src/` runs whatever is there when each
  process starts; do not edit a worktree under a running experiment.
- zsh does not word-split `$var`, so `cmd $opts` passes one argument.
- `/tmp/claude-1001` is a tmpfs shared by every session and was near its quota;
  keep large outputs in the lab directory.
- Parallel parity runs make timings unreliable (a 2-3x slowdown at pericen
  vanished run sequentially); time two builds alternated in one process.
