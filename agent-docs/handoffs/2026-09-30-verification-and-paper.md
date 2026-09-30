# Handoff, 2026-09-30 (evening): independent checks, the paper, and an audit still running

Follows `2026-09-30-bins-and-stray-rows.md`. This session re-derived that
handoff's claims from the artifacts instead of trusting it, wrote the haplotype
index into the paper, and started an adversarial audit that had not finished
when the session ran low on tokens.

## The user's standing decisions

- Only the latest library, latest index and latest plugin matter. Don't analyse
  old-library/new-index combinations, and don't run checks against superseded
  index files; the user regenerates and reuploads indexes as needed.

## Verified on ada (all read from the files, not the handoff)

- `bins-final.db` tags: interval 16,384; anchors 131,072 on CHM13 and GRCh38;
  stray bin 16,384, bound 32,768, gap 1,024, context 1,000; format 2; snarls
  modeled; 5,423,433 stray rows; 363,634 bin parts, 3,225,868 bytes; tool 0.2.0.
  Size 8,076,066,816 bytes. Build 30:25 wall on 20 threads, 19.4 GB peak
  (`~/keep-sweep/build-bins-final.log`); `bins.db` took 32:51.
- `cmp -l bins.db bins-final.db | wc -l` = 2,766 bytes, one tags page.
- Sweep summaries (`~/keep-sweep/runs/*/summary.txt`): 9,000 + 15,780 + 216 +
  3,000 + 72 + 799 queries, WRONG 0 everywhere; medians as the docs say.
  `truth-compare.txt`: 3,000 + 5,260 subgraphs, 21,653,445 pieces, 0 differ.
- The fuzz tally, from the previous session's own tool output: seeds 18,500,
  sampled 582,634, keep 7,322,972 (6,974,349 answered, 348,623 fallbacks), 0
  mismatches, 0 route differences.
- The graph has 464 (sample, haplotype) pairs including GRCh38 and CHM13, 462
  without; 233 samples; 53,150 paths, 47,559 of them fragments.
- HTTP: `~/keep-sweep/gbz-base-js-main/` holds the current `src/`, a
  range-capable server (`range-server.mjs`), a CLI runner (`run-query.mjs`) and
  `http-check.sh`. Ten windows of `rows.json` (random, segdup, noanchor,
  multivisit, end, chm13), eight haplotypes kept, context 1000, contained
  snarls: output byte-identical over HTTP and local disk on every window, all on
  the keep route, 0.2-0.9 s over localhost HTTP against 0.16-0.8 s local. Node
  on ada: `$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin`.
- AMY1 (chr1:103,690,000-103,780,000, all haplotypes): 1,362 records with
  identical per-haplotype coverage on the plain, anchored and bins-final
  indexes. Record count does not depend on the index.

## Repo changes this session

- `test/hprc.test.ts`: both companions default to the hosted index URL, so the
  plain-index block runs (it had been skipped since `cf9b8b8` and expected 1,395
  records; `4aed986` moved that to 1,217 and `61f3125` to 1,362, both deliberate
  joining changes, confirmed by running the test at each commit).
- `tools/haplotype-index/README.md`: a change to the walk rule on either side
  must bump `haplotype_index_stray_format`. This tag is the only thing tying
  `strays.rs` to `src/chosenPaths.ts`; nothing checks the rule at query time.
- `.gitignore` lacks `esm`; `pnpm build` in the primary checkout leaves it
  untracked. Not fixed.

## Paper (`~/paper`, three commits, not pushed)

Methods "Reading pangenome graphs" now has two sentences on the index, and
`supplementary.tex` has Supplementary Note 1 on its own page: the three kinds of
row, the two routes and every fallback condition, two builder pitfalls, build
cost, timings including the small-window case, and the three validation counts
stated separately (route parity, GBZ truth, GFA truth). All new prose is in
`\rev{}`. Both PDFs build; body is 6,365 of 12,000 words.

## The audit

A second agent audited the keep route adversarially: reason through the
completeness argument, fuzz fresh seeds under index options chosen to break it,
and fix what it found. Landed in `4c7f8f8` and `05dc15e`.

**One omission found, by reasoning, then reproduced by hand.** The indexer
counts a visit within `bound` of an anchor visit as reached when that anchor
lies at most `bound` outside the bin, inclusive. The reader extended its anchor
read only while the anchor's offset was strictly less than `hi + bound`, so an
anchor whose node started exactly there was read but the one past it was not,
the section between them was never planned, and no stray row existed for the
visits it covers. Reachable only when that anchor's node is longer than half the
spacing, since the first read already takes one multiple beyond. The sample
check cannot see it: the anchor node is outside the subgraph and the missed node
carries no sample. Fixture `test/data/anchor-at-bound.*`, test in
`test/fuzzCases.test.ts`; both extension loops now compare inclusively. **The
hosted HPRC index cannot hit it**: its longest node is 1,024 bp (the 342 in an
earlier draft was the packed blob length, three bases per byte) and the trigger
needs one over 65,536 bp at 131,072 bp spacing. It is real for graphs with long
nodes or spacings under about 700 bp on HPRC. A guard for a snarl bounded by one
node at both ends went in with it; reasoned, never observed.

**Everything else checked and found impossible or a fallback**: coordinates on
fragmented and reversed references and on CHM13; subgraph nodes outside the bin
lists (the reader's context search is a subset of the indexer's, snarl fills are
covered by boundary visits or `inside_paths` rows, `limit` throws); the plan
loop against `strays_of` on every inclusive/exclusive edge; walk caps and
endmarkers; reverse-only pieces; `distinct`, `context: 0`, overlapping snarls.

**Fuzz on the fixed code**, seeds 20000-27500, indexer rebuilt from source:

| run  | scale  | index args beyond `--stray-context 100`                                                                    | keep route / fallback | wrong |
| ---- | ------ | ---------------------------------------------------------------------------------------------------------- | --------------------- | ----- |
| A    | small  | `--interval 65536 --anchor-spacing 512 --stray-bin 1000 --stray-bound 2000 --stray-gap 64`                 | 213,785 / 3,376       | 0     |
| B    | small  | `--interval 65536 --anchor-spacing 512 --stray-bin 64 --stray-bound 128 --stray-gap 0`                     | 219,752 / 874         | 0     |
| C    | medium | `--interval 256 --anchor-spacing 2048 --stray-context 17 --stray-bin 1024 --stray-bound 512 --stray-gap 1` | 210,176 / 71,576      | 0     |
| D    | medium | `--interval 65536 --anchor-spacing 1024 --stray-bin 1024 --stray-bound 256 --stray-gap 8`                  | 276,559 / 2,305       | 0     |
| E    | small  | `--interval 65536 --anchor-spacing 256 --stray-bin 256 --stray-bound 300 --stray-gap 0`                    | 208,312 / 11,040      | 0     |
| F    | medium | production ratio, `--interval 65536`                                                                       | 328,547 / 177         | 0     |
| EDGE | small  | `--anchor-spacing 512 --stray-bin 1 --stray-bound 300 --stray-gap 8 --edge-windows 12`                     | 249,232 / 1,038       | 0     |

1,706,363 keep queries on the keep route, 124,616 sampled, 0 mismatches, 0 route
differences. `--interval 65536` leaves samples only at anchors and path ends, so
the sample check is nearly vacuous and the bin/stray argument stands alone. The
same EDGE settings on the unfixed code, 58,819 queries, found nothing: the
generator makes the bin-edge half of the trigger but not the returning path, so
the fixture is the only regression test for it.

**Residual, from the agent**: `gen.ts` cannot plant the trigger's structure (a
long rare-allele reference node that is an anchor's sole candidate, plus a path
that re-enters the window's nodes within `bound` of it); snarl fills at medium
scale are barely exercised because `gbz-base construct` finds no top-level
chains in most generated graphs; the anchor lookup assumes a multiple with no
gaps, true by construction of `mark_anchors`; `(a, a)` chain links are guarded
but never observed, and `select count(*) from Nodes where next>>1 = handle>>1`
on the HPRC database would settle whether they exist.

## Cross-validation, evening

Three more agents checked the day's work and the whole state of the three repos.
Everything they found is landed or on a branch; nothing is open in the library.

- **Today's work holds.** One factual slip: the longest HPRC node is 1,024 bp,
  not 342 (that was the packed blob length, three bases per byte), so the fixed
  off-by-one still cannot fire on the hosted index. The paper's note had four
  wording errors, fixed in `~/paper` at `94691b4`: the index it describes is
  ours, not the one hosted today; the 32 limit counts chosen paths passing the
  anchors, not haplotypes; peak memory 19.9 GB; the adversarial fuzz settings
  are examples. The record count in `test/hprc.test.ts` does not depend on the
  index (plain, anchored and bins-final all agree).
- **Library beyond the keep route, landed at `d8e36f2`:** `extractPaths` kept a
  walk in both orientations when both were canonical (a hairpin: it starts and
  ends at one node in opposite orientations), and kept the twin of a reference
  walk that is not canonical, which identification then named as the reference
  over itself. Both routes now drop a named twin whose forward walk of the same
  path covers the same coordinates (`dropTwins`); AMY1 goes from 1,362 records
  to 1,213, duplicate spans 149 to 0. `distinct` merged before identification
  and could lose the reference's identity, so `pairAlignments` against GRCh38
  returned nothing; it now defers the twins. The identification bound uses
  `--reference-interval` where that exceeds `--interval`. Fixture
  `reverse-reference` gained CHM13 and HG002 walks and an index; tests in
  `test/twins.test.ts`. The fuzzer tolerates a piece once per orientation, which
  is why 18,500 graphs never flagged the duplicates.
- **Packaging deviates from the gmod convention**: ESM-only, no `require`
  condition, no `build:es5`, so a Jest consumer needs a
  `transformIgnorePatterns` entry. Left as is; decide before a release.
- **Plugin, landed at `4e93611` on its main:** the walk lift took the first W
  record of a name, so a haplotype the library returns in pieces was drawn as
  its first piece with the rest faded and a spurious deletion in the readout.
  `GraphPath` now carries `start`, the lift unions every record of a name, the
  legend lists a name once, walk rows measure against every reference record and
  draw every piece (as separate rows for now), and a popped bubble keeps a
  record's start. Tests in `packages/core/src/pieces.test.ts`. Comments and
  `agent-docs/GBZ.md` no longer describe the anchored route. The plugin's index
  fixtures and the hosted index predate stray rows, so every keep query in its
  tests falls back to the sampled route; the fixtures' GBZ sources are not in
  the repo, so they could not be rebuilt. The tube map still draws one tube per
  record.
- **BandageJS:** branch `facet-columns` in `.claude/worktrees/facet-columns` of
  that repo (`b81a9e0`) changes `columns:` to the `facet` form the plugin's core
  `2f31ab9` introduced. It compiles only against that core, not the published
  4.0.27 in its lockfile, so land it with the dependency bump when the core is
  released. Its `node_modules` was stale against the lockfile.
- **On ada:** `chain3` (source `40d45de`, before the twin fix) ran tutorial
  216/216, `bins3` 9,000/8,986/14/0 wrong, truth 3,000 subgraphs 1,981,894
  pieces 0 differ, then the targeted sweep and keep-all passes. `chain4` (source
  `d8e36f2`, `~/keep-sweep/gbz-base-js-d8e36f2/`) is queued behind it by a
  `pgrep` loop and writes `chain4.log`, runs tagged `bins4`. Self-bounded chain
  links in the HPRC database: 0 of 69,646,620.

## Review against upstream, evening

A fourth agent held every upstream-facing claim and every decoding assumption
against gbz-base 0.6.2 and the gbz crate sources in the cargo registry, from the
point of view of their maintainers. Verdict: no substantive error in the format
semantics or the index's premises. Upstream's own comment states the premise
(`subgraph.rs:44-45`: other paths remain anonymous because they cannot be
identified efficiently using the GBWT). Landed at `aafb2bc`:

- **Walk order** (`b1f737c`): upstream lists walks by start handle then offset;
  `extractPaths` listed forward-start walks first, so a canonical walk starting
  on a reverse handle came out last and `unknown#N` numbers differed. No oracle
  fixture had such a walk. Now sorted as upstream does, the keep route's
  `extractionOrder` matches, and three oracle fixtures generated with the
  upstream binary cover it. A 29-window diff against the binary is identical
  except the two documented CIGAR cases.
- **Docs** (`aafb2bc`): what the GBWT names versus what gbz-base's database
  stores (the GBWT's document-array samples are not carried into the database;
  the index is that sampling kept outside it); a position ranks a visit, not a
  walk; "reference or generic path" where upstream indexes both; one row per
  node orientation; `overlapping` snarls need a boundary and a successor inside.
- **Twin dropping** (`d8e36f2`) is justified by GBWT semantics: the two walks
  are sequences 2p and 2p+1 over the same coordinates; upstream prints the
  duplicate too.
- **Paper** (`~/paper` at `14059c7`): a walk is named from the next sample along
  it, not the nearest; the database names a path only at its start and upstream
  reports the rest as unknown; the GBWT's own samples are not in the database;
  the lengths table is mentioned.

`chain5` on ada runs the acceptance chain on this final main
(`~/keep-sweep/gbz-base-js-aafb2bc/`, tagged `bins5`), queued behind `chain4`.

## Left for the user

- Host `bins-final.db`, release npm and the crate.
- `.claude/worktrees/stray-table` still holds an uncommitted docs draft that
  main supersedes; `dup-spike` as before.
- `anchors-vs-samples.md` at the repo root (untracked, 09-27) describes the
  deleted anchor-only route.
