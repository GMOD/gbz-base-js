# Contributing

## Development

```sh
pnpm install
pnpm test
pnpm build
```

`pnpm test` runs vitest in watch mode; `pnpm test --run` runs the suite once.

## Releasing

`pnpm version patch`, `minor` or `major` runs lint, the format check, the type
check, the tests and the build, regenerates CHANGELOG.md with git-cliff, and
pushes the version tag. The tag triggers the publish workflow.

The workflow publishes to npm with trusted publishing (OIDC, no stored token),
which needs `id-token: write` permission. To set up trusted publishing for the
package, run
`npm trust github gbz-base --file publish.yml --repo GMOD/gbz-base-js`, which
requires npm 11.10.0 or later and 2FA.

After the npm publish succeeds, the `release` job creates the GitHub release for
the tag, with notes taken from that version's CHANGELOG.md section by
`scripts/release-notes.sh`. Run the script with a version to preview the notes.

## The data-flow diagram

`docs/img/dataflow.svg` is generated from `docs/img/dataflow.dot` and committed,
because GitHub does not render DOT. Re-render it in the same commit as any edit
to the `.dot`:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
```

No check enforces this. Graphviz is not a dependency, and different versions
emit different SVG bytes, so a staleness check would fail whenever the toolchain
changed.

## Test data

`test/data/*.gbz.db` are databases built by the upstream Rust `gbz-base` tool.
`test/data/oracle/` holds that tool's output for a fixed set of queries, and
`test/oracle.test.ts` requires this reader's output to match it byte for byte.
`test/data/oracle/generate.sh` regenerates the oracle and needs the Rust tool on
your PATH. CI never runs it, so commit a regenerated oracle.

Install upstream with
`cargo install --git https://github.com/jltsiren/gbz-base`. On a Mac, the
`quay.io/vgteam/vg` container is the easiest way to get `vg`.

Two fixtures come from GFA files in `test/data/`:

- `split-contig.gfa` has a reference contig stored as two path fragments with a
  gap between them. Build its database and companion with:

  ```sh
  vg gbwt -G split-contig.gfa --gbz-format -g split-contig.gbz
  gbz-base construct split-contig.gbz -o split-contig.gbz.db
  gbz-haplotype-index --interval 200 --output split-contig.haplotype-index.db split-contig.gbz split-contig.gbz.db
  ```

- `looping-walk.gfa` has haplotype walks that loop through or reorder a
  reference segment, so their CIGARs come from the weighted LCS instead of from
  ordered matching. Build its database with the same `vg` and `gbz-base`
  commands; it has no companion.

`tools/haplotype-index/` is the Rust tool that writes the haplotype index. The
npm tarball includes it as source, and nothing in this repo builds it.

## Measuring

`scripts/measure-windows.mjs` times a set of windows against a database and
reports requests, bytes and the route each query took. `scripts/time-phases.mjs`
splits one query into its phases. Together they produced the tables in
[docs/performance.md](docs/performance.md), and `gbz-base-query --stats` reports
the same counters for a single query. `scripts/chains-dump.mjs` and
`scripts/verify-chr20.ts` help debug identification.
