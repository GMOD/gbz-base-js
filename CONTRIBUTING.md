# Contributing

## Development

```sh
pnpm install
pnpm test --run
pnpm build
```

## Releasing

`pnpm version patch` (or `minor`, `major`) runs lint, format check, typecheck,
tests and build, writes CHANGELOG.md with git-cliff, and pushes the tag. The tag
triggers the publish workflow, which publishes to npm with trusted publishing
and then creates the GitHub release from the version's CHANGELOG.md section.
`scripts/release-notes.sh <version>` previews those notes.

To set up trusted publishing (npm 11.10.0 or later, with 2FA):

```sh
npm trust github gbz-base --file publish.yml --repo GMOD/gbz-base-js
```

## The data-flow diagram

`docs/img/dataflow.svg` is rendered from `docs/img/dataflow.dot` and committed.
Re-render it whenever you edit the `.dot`:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
```

## Test data

`test/data/*.gbz.db` are built by upstream `gbz-base`
(`cargo install --git https://github.com/jltsiren/gbz-base`).
`test/data/oracle/` holds upstream's output for the queries in `queries.txt`;
`test/oracle.test.ts` compares against it, and `generate.sh` regenerates it with
`gbz-base` on your PATH. Commit the regenerated files.

Two fixtures are built from GFA files, `split-contig.gfa` (a contig stored as
two path fragments) and `looping-walk.gfa` (walks that loop through or reorder
the reference). `quay.io/vgteam/vg` is the easiest `vg` on a Mac.

```sh
vg gbwt -G split-contig.gfa --gbz-format -g split-contig.gbz
gbz-base construct split-contig.gbz -o split-contig.gbz.db
gbz-haplotype-index --interval 200 --output split-contig.haplotype-index.db split-contig.gbz split-contig.gbz.db
```

`looping-walk` uses the first two commands only.

## Scripts

- `scripts/measure-windows.mjs` times a set of windows: requests, bytes and the
  naming route.
- `scripts/time-phases.mjs` splits one query into phases.
- `scripts/chains-dump.mjs` and `scripts/verify-chr20.ts` debug naming.
