# Handoff, 2026-10-02: whole-repo bug review of 6.0.1, and the fixes

A first session reviewed `src/` for bugs at 7fa3c2d (6.0.1) with four parallel
reviewers: the SQLite layer, GBWT/`db.ts`/names, `subgraph.ts`, and
`chosenPaths`/`pairAlignment`/`lcs`/CLI. A second session fixed every finding
below on one branch. Each fix has a regression test built from its repro, and
each test fails with the source change reverted.

The first session's Fable second-opinion review hit a usage limit before
reporting. Its draft patches survived and served as starting points for findings
1, 3, 4, 5, 6, 7 and 9; the fixes for 4 and 9 differ from the drafts, as
recorded below. A second Fable review of the fixes ran afterwards; see
[Second review](#second-review).

## Fixed

1. **A failed prefetch killed Node.** `Pager.fetchRun` stored each block as
   `pending.then(subarray)` with a catch only on `pending`, so blocks nobody
   awaited rejected unhandled. `Pager.store` now puts a catch on every stored
   promise. Test: `test/pager.test.ts`.
2. **One failure poisoned the path cache.** `paths()` and `pathsByHandle()` now
   drop a rejected promise. `tags()` no longer reads lazily: `open()` keeps the
   tags it reads for the version check. Test: `test/sqlite.test.ts`.
3. **A run's predecessor key aliased a real seed.** `sharedRuns` range-checks
   `rank - step` and `i > 0`. Test: `test/pairAlignment.test.ts`.
4. **Chaining stopped at the first chain below `minMatch`.** `chainRuns` sums
   matched bases along the back pointers and picks the best-scoring end that
   reaches `minMatch`, stopping when none does. The handoff's suggestion,
   removing the failing chain's runs and continuing, was rejected: it discards
   runs a passing chain needs and costs a full DP pass per removal. Neither
   finds every passing chain, since back pointers keep one predecessor. The
   commit message has the argument. Test: `test/pairAlignment.test.ts`.
5. **`distinct` counted a shared hairpin walk twice.** `distinctPaths` defers
   `pathIsCanonical(flipPath(path))`. Upstream has no identification step and
   prints two records here; without an index this package still matches it.
   Fixture: `test/data/shared-hairpin.*`. Test: `test/twins.test.ts`.
6. **The table check ran before the version check.** `open()` reads the version
   first, and a haplotype index given as `source` throws `SchemaVersionError`. A
   gbz-base file given as `haplotypeIndex` names the problem. Test:
   `test/sqlite.test.ts`.
7. **A prefetch could evict its own blocks.** A prefetch now spans at most half
   the cache. `prefetchRowidRange` returns false when it does not fit;
   `tableScan` prefetches children in chunks that fit. A full scan of a 63 MB
   table with 4 KiB blocks fetched 126 MB before and 63 MB after. With the
   default 64 KiB blocks the rowid-range cap fell from 16 MB to 8 MB. Test:
   `test/pager.test.ts`.
8. **Reversed intervals were accepted.** `aroundInterval` rejects `!(len > 0)`
   with upstream's message, which also catches NaN. `getPathFragments` throws on
   a NaN window. Tests: `test/api.test.ts`.
9. **Index presence changed `distinct` output.** Output methods and `pathCount`
   settle deferred twins first, and `identifyPaths()` restores the unmerged
   walks, so reading output before identifying changes nothing. The draft patch
   merged them for good. Test: `test/twins.test.ts`.
10. **`forgetOnFailure` could delete a newer refetch.** `Pager.store` deletes
    only if the entry is still the failed promise. Test: `test/pager.test.ts`.
11. **8-byte varints skipped the safe-integer check.** Test:
    `test/pager.test.ts`.
12. **The first block used the raw block size.** `open()` reads at least 512
    bytes, and a non-positive or non-integer `blockSize`/`maxBlocks` throws. An
    unaligned `blockSize` still costs one extra read of block 0. Test:
    `test/pager.test.ts`.
13. **The CLI misparsed input.** Numeric flags take whole numbers, a value flag
    no longer swallows the next option, `--keep` takes `sample` or
    `sample#haplotype` only, `--contig-lengths` refuses a non-numeric length,
    `--stats` leaves out the identification report on the anchored keep route,
    and `bin/query.js` calls `run()`, which exits 0 on EPIPE. Test:
    `test/cli.test.ts`.
14. **`toGFA` needed a secure context.** `src/sha256.ts` is the fallback when
    `crypto.subtle` is missing. Test: `test/sha256.test.ts`.
15. **The docs described `limit` wrongly.** It caps the nodes in the subgraph,
    as upstream's `set_limit` does.

Also fixed: the keep stats' `pieces` counts the reference, and the
overlapping-snarls check counts distinct node ids, as upstream does.

## Packaging

The package now ships dual ESM/CJS like the other gmod parsers: `esm/` for
`import`, a CommonJS `dist/` for `require`. `scripts/test-pack.sh`
(`pnpm test:pack`) reads a fixture through both entries and the bin;
`preversion` and the publish workflow's test job run it.

## Second review

A Fable review of f6315e9 found every fix above sound and reported six more
items. Its notes and repro scripts are in the session scratchpad under
`fable2/`.

Fixed:

- **`mergeDistinct()` before `identifyPaths()` gave wrong output** on an indexed
  `distinct` subgraph: it merged the deferred twins for good, so identification
  dropped a walk on `reverse-reference` and named two weight-2 records for two
  haplotypes on `shared-hairpin`. `mergeDistinct()` now settles deferred twins
  like the output methods. Test: `test/twins.test.ts`.
- **`alignToRef(i)` indexed the unsettled walk list** when it came before any
  other output. It settles first. Test: `test/twins.test.ts`.
- **Query options were accepted silently.** A fractional node id returned an
  empty subgraph, a NaN or negative `context` acted as 0, and `limit: NaN` meant
  no limit. The query entry points in `src/query.ts` now require whole numbers.
  Test: `test/api.test.ts`.

Not fixed:

- **Concurrent prefetches can evict each other** (`subgraph.ts`
  `prefetchReferenceRange`). Each `prefetchRecords` call fits half the cache,
  but the per-run calls go out together under `Promise.all`. At defaults this
  needs more than 16 MB of node records in one window. Fix: stop issuing runs
  once their summed blocks reach the budget.
- **A three-level `tableScan` refetches interior blocks**: 65.1 MB for a 63 MB
  table at defaults, the same as before the fixes. Fix: prefetch only the level
  whose children are leaves.
- **The CLI rejects upstream's `1.5k`/`10M` suffixes** for `--context` and
  `--limit`. Before the CLI validation these parsed as NaN.

The review also reran the differential sweep against upstream `gbz-base query`:
2,509 queries, every mismatch CIGAR-only. 53 come from reverse-reference walks
(documented in `docs/internals.md`) and 16 from equal-weight LCS ties. Upstream
picks among tied alignments by its `fast_weighted_lcs` search order, not by a
rule, so matching it would mean porting that DP; the ties do not affect
correctness.

## Not fixed

- A non-SQLite file throws a plain "Not a SQLite database" error, not
  `SchemaVersionError`.
- A window past the end of a cut fixture's fragment fails with "No successor for
  GBWT position", as upstream `gbz-base query` does on the same file.

## Verified correct, don't re-check

- **SQLite decoding:** matches Python `sqlite3` across page sizes 512-65536,
  reserved bytes 0-255, overflow, every serial type, and WITHOUT ROWID tables.
- **GBWT and sequence decoding:** matches upstream on every fixture record.
- **Solvers:** `weightedLcs` and `affineAlignment` match brute-force solvers on
  thousands of random cases.
- **`pairAlignments` invariants:** the fuzz found no violations before or after
  the fixes for 3 and 4.
