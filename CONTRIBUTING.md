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

`docs/img/dataflow.svg` is generated from `docs/img/dataflow.dot` and committed,
since GitHub does not render DOT. If you edit the `.dot`, re-render it in the
same commit:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
```

Nothing checks this — graphviz is not a dependency and different versions emit
different SVG bytes, so a staleness check would fail on toolchain drift rather
than on a stale diagram.

## Test data

`test/data/*.gbz.db` are real gbz-base databases built by the upstream Rust
`gbz-base` tool, and `test/data/oracle/` holds that tool's own output for a
fixed set of queries — `test/oracle.test.ts` asserts this reader agrees with it
byte for byte. `test/data/oracle/generate.sh` regenerates those files, and needs
the Rust tool on your PATH; nothing in CI runs it, so a regeneration has to be
committed.

`test/data/split-contig.gfa` is the source of the one fixture whose reference
contig is stored as two path fragments with a gap between them. Its database is
`vg gbwt -G split-contig.gfa --gbz-format -g split-contig.gbz` followed by
`gbz-base construct split-contig.gbz -o split-contig.gbz.db`, and its companion
is
`gbz-haplotype-index --interval 200 --output split-contig.haplotype-index.db split-contig.gbz split-contig.gbz.db`.
Upstream builds with `cargo install --git https://github.com/jltsiren/gbz-base`,
and `quay.io/vgteam/vg` is the easiest `vg` on a Mac.

`tools/haplotype-index/` is the Rust helper that writes the haplotype index some
of those databases carry. It is shipped in the npm tarball as source only —
nothing here builds it.

## Measuring

`scripts/measure-windows.mjs` times a set of windows against a database and
reports requests, bytes and the route each query took; `scripts/time-phases.mjs`
splits one query into its phases. The tables in
[docs/performance.md](docs/performance.md) come from them, and `--stats` on
`gbz-base-query` reports the same counters for a single query.
`scripts/chains-dump.mjs` and `scripts/verify-chr20.ts` are debugging aids for
identification.

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
