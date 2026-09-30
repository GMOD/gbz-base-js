# Handoff, 2026-09-30 (evening): independent checks, the paper, and an audit still running

Follows `2026-09-30-bins-and-stray-rows.md`. This session re-derived that
handoff's claims from the artifacts instead of trusting it, wrote the haplotype
index into the paper, and started an adversarial audit that had not finished
when the session ran low on tokens.

## The user's standing decisions

- Only the latest library, latest index and latest plugin matter. Don't analyse
  old-library/new-index combinations, and don't run checks against superseded
  index files; the user regenerates and reuploads indexes as needed.
- The audit agent's report was never delivered to the user. See below.

## Verified on ada (all read from the files, not the handoff)

- `bins-final.db` tags: interval 16,384; anchors 131,072 on CHM13 and GRCh38;
  stray bin 16,384, bound 32,768, gap 1,024, context 1,000; format 2; snarls
  modeled; 5,423,433 stray rows; 363,634 bin parts, 3,225,868 bytes; tool
  0.2.0. Size 8,076,066,816 bytes. Build 30:25 wall on 20 threads, 19.4 GB
  peak (`~/keep-sweep/build-bins-final.log`); `bins.db` took 32:51.
- `cmp -l bins.db bins-final.db | wc -l` = 2,766 bytes, one tags page.
- Sweep summaries (`~/keep-sweep/runs/*/summary.txt`): 9,000 + 15,780 + 216 +
  3,000 + 72 + 799 queries, WRONG 0 everywhere; medians as the docs say.
  `truth-compare.txt`: 3,000 + 5,260 subgraphs, 21,653,445 pieces, 0 differ.
- The fuzz tally, from the previous session's own tool output: seeds 18,500,
  sampled 582,634, keep 7,322,972 (6,974,349 answered, 348,623 fallbacks),
  0 mismatches, 0 route differences.
- The graph has 464 (sample, haplotype) pairs including GRCh38 and CHM13, 462
  without; 233 samples; 53,150 paths, 47,559 of them fragments.
- HTTP: `~/keep-sweep/gbz-base-js-main/` holds the current `src/`, a
  range-capable server (`range-server.mjs`), a CLI runner (`run-query.mjs`) and
  `http-check.sh`. Ten windows of `rows.json` (random, segdup, noanchor,
  multivisit, end, chm13), eight haplotypes kept, context 1000, contained
  snarls: output byte-identical over HTTP and local disk on every window, all
  on the keep route, 0.2-0.9 s over localhost HTTP against 0.16-0.8 s local.
  Node on ada: `$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin`.
- AMY1 (chr1:103,690,000-103,780,000, all haplotypes): 1,362 records with
  identical per-haplotype coverage on the plain, anchored and bins-final
  indexes. Record count does not depend on the index.

## Repo changes this session

- `test/hprc.test.ts`: both companions default to the hosted index URL, so the
  plain-index block runs (it had been skipped since `cf9b8b8` and expected
  1,395 records; `4aed986` moved that to 1,217 and `61f3125` to 1,362, both
  deliberate joining changes, confirmed by running the test at each commit).
- `tools/haplotype-index/README.md`: a change to the walk rule on either side
  must bump `haplotype_index_stray_format`. This tag is the only thing tying
  `strays.rs` to `src/chosenPaths.ts`; nothing checks the rule at query time.
- `.gitignore` lacks `esm`; `pnpm build` in the primary checkout leaves it
  untracked. Not fixed.

## Paper (`~/paper`, three commits, not pushed)

Methods "Reading pangenome graphs" now has three sentences on the index, and
`supplementary.tex` has Supplementary Note 1 on its own page: the three kinds
of row, the two routes and every fallback condition, two builder pitfalls,
build cost, timings including the small-window case, and the three validation
counts stated separately (route parity, GBZ truth, GFA truth). All new prose is
in `\rev{}`. Both PDFs build; body is 6,365 of 12,000 words.

## The audit agent

A fresh agent was auditing the keep route adversarially in
`.claude/worktrees/agent-a6bba07b2dffcb7e4` (branch of the same name): reason
through the completeness argument, fuzz fresh seeds with adversarial index
options, add a fixture and fix on its branch if it found an omission. Its
report goes to the session that launched it, which ended. Check that branch
for commits and its worktree for a report or dump directories; if it found
nothing, remove the worktree. The user asked for no further subagents.

## Left for the user

- Host `bins-final.db`, release npm and the crate.
- `.claude/worktrees/stray-table` still holds an uncommitted docs draft that
  main supersedes; `dup-spike` as before.
- `anchors-vs-samples.md` at the repo root (untracked, 09-27) describes the
  deleted anchor-only route.
