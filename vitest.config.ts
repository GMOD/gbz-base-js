import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // a live agent worktree under .claude/ is another checkout of this
    // repo, and vitest's include glob matches dotfolders
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    // Vitest's default is 5s. test/identify.test.ts runs the haplotype walk
    // over the 328KB micb-kir3dl1.gbz.db and its two cases measure 0.9s and
    // 2.8s on a quiet machine — the second is already inside 2x of the
    // default, which is no margin at all on a contended runner.
    //
    // 20s is ~7x the slowest test rather than a round number. It is not
    // covering for a slow test; it exists so that a loaded runner reports the
    // failure the suite actually has, instead of a timeout on whichever test
    // happened to be running.
    testTimeout: 20_000,
  },
})
