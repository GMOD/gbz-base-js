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

Whenever you edit `docs/img/dataflow.dot`, render `docs/img/dataflow.svg` from
it and commit both:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
```

## Test data

Upstream `gbz-base` builds `test/data/*.gbz.db`
(`cargo install --git https://github.com/jltsiren/gbz-base`).
`test/data/oracle/` holds upstream's output for the queries in `queries.txt`;
`test/oracle.test.ts` compares against it, and `generate.sh` regenerates it with
`gbz-base` on your PATH. Commit the regenerated files.

`vg` builds three fixtures from GFA files: `split-contig.gfa` (a contig stored
as two path fragments), `looping-walk.gfa` (walks that loop through or reorder
the reference) and `far-stretch.gfa` (a deletion that joins a window to a
reference stretch far from its anchors). `quay.io/vgteam/vg` is the easiest `vg`
on a Mac.

```sh
vg gbwt -G split-contig.gfa --gbz-format -g split-contig.gbz
gbz-base construct split-contig.gbz -o split-contig.gbz.db
gbz-haplotype-index --interval 200 --anchor-spacing 300 split-contig.gbz split-contig.gbz.db split-contig.haplotype-index.db
```

`looping-walk` uses the first two commands only. `far-stretch` builds its index
with `--interval 65536 --anchor-spacing 16384 --reference-interval 1024`.

## Scripts

- `scripts/measure-windows.mjs` times a set of windows and reports the requests,
  bytes and naming route of each.
- `scripts/time-phases.mjs` splits one query into phases.
- `scripts/chains-dump.mjs` and `scripts/verify-chr20.ts` debug naming.
