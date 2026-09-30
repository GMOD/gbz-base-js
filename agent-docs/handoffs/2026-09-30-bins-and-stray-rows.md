# Handoff, 2026-09-30: one keep route, checked at query time, and three ways to test it

Follows `2026-09-28-genome-sweep.md`. Two sessions after that one built a
`stray-table` branch and stopped at the weekly limit without a handoff; this
session picked that branch up, replaced its rule for stray rows, removed the
route that planned walks from anchor rows alone, and built the tests. Read this
first if you touch the keep route, `gbz-haplotype-index`, or `identifyPaths`.

## The requirement

A query must never return a haplotype with a piece missing. The
graphgenomeviewer plugin draws a missing piece as a deletion, and a user reads
that as biology. Falling back to identifying every walk is always acceptable; an
omission without a fallback never is.

## What the sessions before this one had

`stray-table` (4 commits) added a `HaplotypeStrays` table and a route that
walked each chosen path between adjacent anchors and along its stray rows. Its
sweep on ada (`runs/strays4`) had 21 wrong queries and 52 dropped pieces in
9,000, down from 152 and 585 on 4.1.0. The cause was open.

## What was wrong with it

- **One locus per node.** The indexer ran one Dijkstra from every reference node
  of a 32 kb stretch with one shared visited set, so each node got the position
  of its nearest reference node and no other. A reference node at 85,799,464 on
  chr8 sits 88 bp, through a deletion edge, from a window that ends at
  85,795,786; it kept its own position, the row lay outside the window's lookup
  range, and the piece dropped. All 52 drops fit this.
- **Visits to anchor nodes were never strays.** A path that visits one anchor
  and neither neighbour has no section for the reader to walk, and the indexer
  skipped the visit.
- **Nothing checked the model at query time.** The rows are complete only if the
  indexer's idea of which nodes a window can hold matches the reader's subgraph.
  A mismatch dropped pieces silently.

## The design now

`docs/haplotype-index.md` has the reader-facing account. In short:

- A **bin** is 16,384 bp of a reference path. `HaplotypeBinNodes` lists each
  bin's nodes: the result of the reader's context expansion, run by the indexer
  from every reference node overlapping the bin, with `--stray-context` (1000).
  The ids are stored as runs; all 363,634 bins of HPRC take 3.2 MB.
- The reader checks every node of its subgraph against the lists of the bins its
  window touches and falls back on a node that none lists. This check turns any
  disagreement between indexer and reader into a fallback: a larger context, a
  change to the expansion, a new snarl mode.
- `HaplotypeStrays` is keyed
  `(reference_handle, bin, path_handle, path_start, snarl_low, snarl_high)`. A
  visit to a bin's node is a stray for that bin unless a section walk reaches
  it; `Sample::reached` in `tools/haplotype-index/src/strays.rs` and the plan
  loop in `strayRoute` (`src/chosenPaths.ts`) are the same three conditions and
  must stay so.
- Snarls: a contained snarl's fill adds nodes that no bin lists. A path through
  one enters by a boundary node, which a bin lists, and the piece runs on from
  that visit. A path inside the snarl from end to end gets a row with the
  snarl's two boundary ids. The indexer reads the chain links from
  `graph.gbz.db`, so **build with the database given**; without it, a query that
  fills a snarl falls back. `snarls: 'overlapping'` with a fill always falls
  back.
- A node that is the anchor of two multiples ends no section, in both programs.
- The route that planned walks from anchor rows and samples is deleted. An index
  without the two tables (everything before crate 0.2.0, including the index
  hosted at jbrowse.org today) makes a keep query identify every walk.

## Other fixes

- **`keep` with `haplotypes: 'distinct'`** merged walks first and kept a record
  by the name of whichever walk stood for it: 81 of 89 single-haplotype queries
  on the micb fixture returned nothing for the kept haplotype. It now keeps,
  then merges. The plugin and BandageJS pass `'all'`, so neither hit this.
- **`keepHaplotypes` on an unnamed or merged walk** now throws. It used to
  discard the walk.
- **Coverage off by one** (found by the fuzzer, `9eb3436`): a stray row whose
  last visit starts where an earlier walk stopped was skipped as covered. It
  dropped a piece with no fallback; `test/data/stray-end.*` holds the case.
- **`Could not find the reference path`** (found by the fuzzer): `extractPaths`
  skipped the reference walk when it started on a reverse handle and its twin
  was kept. Affects a reference that runs reverse through nodes, as CHM13 can in
  a GRCh38-based graph. `test/data/reverse-reference.*`.
- **Twins**: a piece that ends at its contig's end has its reverse sample inside
  the piece. The sample check now seeds twins from reverse samples in the
  window. This was 36 of the 50 fallbacks in the first sweep.

## Evidence

All on the final code (`9eb3436` for `src/`), index
`hprc-v2.1-mc-grch38.haplotype-index.bins.db`, local files on ada.

| run (`~/keep-sweep/runs/`) | windows                           |                                       queries | keep route | fallback | wrong |
| -------------------------- | --------------------------------- | --------------------------------------------: | ---------: | -------: | ----: |
| `bins2`                    | the 1,500 of 09-28                |                                         9,000 |      8,986 |       14 |     0 |
| `bins2-targeted`           | 1,330 aimed at the stray rows     |                                        15,780 |     15,772 |        8 |     0 |
| `bins2-tutorial`           | 18 loci, four combos              |                                           216 |        216 |        0 |     0 |
| `bins2-all`                | the 1,500, every haplotype kept   |                                         3,000 |      2,998 |        2 |     0 |
| `bins2-tutorial-all`       | the 18 loci, every haplotype kept |                                            72 |         72 |        0 |     0 |
|                            | `bins2-targeted-all-sample`       | 80 per targeted stratum, every haplotype kept |        799 |      791 |     8 | 0   |     |

4.1.0 on the first row: 152 wrong, 585 pieces. `strays4` (the branch as found):
21 wrong, 52 pieces. The 800th query of the last row, every haplotype at a 579
bp window that a snarl of 8 Mb joins (`jump chr10:16687571->24715172`), ran out
of an 8 GB heap; with eight haplotypes the keep route took 13 s and the sampled
route 40 s. Pass `limit` for such a window.

- **Truth from the GBZ** (`gbz-truth`): the sampled route matches on all 8,260
  subgraphs of `bins2` and `bins2-targeted`, 21,653,445 pieces, none missing,
  added or unnamed. Nothing had checked the sampled route against anything but
  itself before.
- **Fuzz** (`test/fuzz`), final code: 18,500 graphs, 582,634 sampled queries and
  7,322,972 keep queries (6,974,349 on the keep route), no mismatch against the
  GFA and no difference between the routes. At `29798dd`, before the two fuzzer
  fixes, 9 keep queries in 4,000 seeds dropped a piece and 24 sampled queries
  threw.
- **chr22** (`idx-bins-s32k.db`, 32 kb anchors): 486 queries and 162 keep-all
  queries, none wrong; truth matched on 162 subgraphs, 86,490 pieces.
- How often the rows matter: a stray row was walked in 39 of 3,600 random
  queries, 310 of 1,790 in segmental duplications, 1,670 of 1,800 at unplaced
  contigs.
- Timing, local disk, pages cached, median keep against sampled: random 102 and
  169 ms; segdup 117 and 289; unplaced contigs 144 and 1,404; a window under 3
  kb beside an anchor or bin boundary 62-93 and 19-25. The keep route walks
  about 196 kb per chosen haplotype with 131 kb anchors, whatever the window.

## Tests, from small to large

1. `pnpm test --run`: fixtures, including `test/fuzzCases.test.ts`.
2. `test/fuzz/run.ts`: generated graphs against truth from the GFA text, and the
   two routes against each other. Needs `vg`, `gbz-base` and the indexer.
   **Scale the indexer options to the graph**
   (`--stray-bin 1024 --stray-bound 2048 --stray-gap 64 --anchor-spacing 2048 --interval 256`);
   at the defaults a small graph is one bin and no stray row matters.
3. `tools/validate/`: `run.sh` (parity sweep), `gbz-truth` (pieces from the GBZ
   alone), `truth-compare.py`, `windows-targeted.py`, `jumps`.

## On ada

`ssh ada` needs the user's 2FA once (`! ssh -fN ada`); the control socket then
lasts 8 hours. It is shared: nice 10, about 12 cores.

- `~/hprc-gbz/hprc-v2.1-mc-grch38.haplotype-index.bins.db`: the index this
  session validated (8.08 GB, 131,072 bp anchors on GRCh38 and CHM13).
- `~/keep-sweep/`: `rows.json` (the 1,500 windows of 09-28),
  `rows-targeted.json` (1,330), `rows-tutorial.json` (18 loci),
  `jumps-grch38.tsv`, `runs/bins2*`, `chain2.sh`, and `gbz-base-js-bins/` (a
  copy of `src/` and `tools/validate/`; `COMMIT` names the commit).
- `~/keep-sweep/chr22/`: the chr22 graph and `idx-bins-s32k.db`.

## Decisions for the user

1. **Host the new index.** `bins.db` on ada is validated. 4.1.0 reads it as
   before, since it ignores the two new tables, so it can replace
   `hprc-v2.1-mc-grch38.haplotype-index.anchored.db` in place. Until it is
   hosted, a keep query with the new library identifies every walk: correct, and
   slower. Rebuild first with the final indexer if the
   `haplotype_index_tool_version` tag matters; the tables come out the same.
2. **Release.** npm: the `KeepStats` fields changed (`seeds` and three `ms` keys
   gone, `strays` added), `keepHaplotypes` throws where it discarded, and `keep`
   with `distinct` returns different records, so this is a major version by
   semver, or 4.2.0 if the stats count as diagnostics. crates.io:
   `gbz-haplotype-index` 0.2.0; the published 0.1.0 writes neither table.
3. **The plugin** answers its pair view only when `stats.keep.fallback` is
   `undefined` (`GbzBaseSyntenyAdapter.ts`, `pairFeatures`), from when the
   anchored route returned whole walks. Both routes have returned the same
   pieces since 4.0, so that gate can go. With it in place and the old index
   hosted, the pair view composes through the reference on every query.
4. **Anchor spacing.** 32 kb anchors would cut the walks four times and make
   small windows faster; chr22 put the cost at 5.6% of the index for GRCh38
   alone. Not measured on HPRC with stray rows.
5. **`snarls: 'overlapping'` with `keep`** falls back. Covering it needs every
   snarl boundary's visits listed in the other boundary's bins.

## Pitfalls met

- The harness refuses compound shell commands inside a worktree session
  (`cd x && git ...`, heredocs with `cd`). Write a script file and run it.
- The local disk had 4 GB free. Rust builds went to
  `CARGO_TARGET_DIR=/tmp/claude-1001/gbz-build/target` (tmpfs).
- Memory and transcripts for this repository are split over three config
  directories, `~/.claude`, `~/.claude2` and `~/.claude3`. The two unfinished
  sessions were in `~/.claude` and `~/.claude3`.
- A fuzz or sweep process imports `src/` when it starts. Give it a snapshot
  (`--src`, `GBZ_SRC`) before editing the tree.
