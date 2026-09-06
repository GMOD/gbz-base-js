# Contributing

## Development

```sh
pnpm install
pnpm test
pnpm build
```

Use `pnpm version patch/minor/major` to release — it runs lint, format, types,
tests and build, regenerates CHANGELOG.md with git-cliff, then pushes the
version tag which triggers the publish workflow.

## Test data

`test/data/*.gbz.db` are real gbz-base databases built by the upstream Rust
`gbz-base` tool, and `test/data/oracle/` holds that tool's own output for a
fixed set of queries — `test/oracle.test.ts` asserts this reader agrees with it
byte for byte. `test/data/oracle/generate.sh` regenerates those files, and needs
the Rust tool on your PATH; nothing in CI runs it, so a regeneration has to be
committed.

`tools/haplotype-index/` is the Rust helper that writes the haplotype index some
of those databases carry. It is shipped in the npm tarball as source only —
nothing here builds it.

## Publishing

Releases publish automatically via GitHub Actions using npm trusted publishing
(OIDC, no stored token). The workflow requires `id-token: write` permissions.

To set up trusted publishing for this package:
`npm trust github gbz-base --file publish.yml --repo GMOD/gbz-base-js` (requires
npm >=11.10.0 and 2FA).

Once npm publish succeeds, the `release` job creates the GitHub release for the
tag, taking its notes from that version's CHANGELOG.md section — which
`scripts/release-notes.sh` extracts, so run that with a version to preview what
a release will say.
