# Handoff, 2026-10-02: whole-repo bug review of 6.0.1, and the fixes

A first session reviewed `src/` for bugs at 7fa3c2d (6.0.1) with four parallel
reviewers: the SQLite layer, GBWT/`db.ts`/names, `subgraph.ts`, and
`chosenPaths`/`pairAlignment`/`lcs`/CLI. A second session fixed every finding
below on one branch. Each fix has a regression test built from its repro, and
each test fails with the source change reverted.

The Fable second-opinion review from the first session was lost with that
session and has not been rerun. Its draft patches survived and served as
starting points for findings 1, 3, 4, 5, 6, 7 and 9; the fixes for 4 and 9
differ from the drafts, as recorded below.

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

## Not fixed

- Calling `mergeDistinct()` before `identifyPaths()` on an indexed `distinct`
  subgraph still merges the twins too early. The docs describe `mergeDistinct()`
  only after identification or `keepHaplotypes`.
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
