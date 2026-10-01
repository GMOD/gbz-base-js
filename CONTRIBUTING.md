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

The indexer lives in
[GMOD/gbz-haplotype-index](https://github.com/GMOD/gbz-haplotype-index). Build
or install it and put it on your PATH, or pass its path to the scripts below.

Upstream `gbz-base` builds `test/data/*.gbz.db`
(`cargo install --git https://github.com/jltsiren/gbz-base`).
`test/data/oracle/` holds upstream's output for the queries in `queries.txt`;
`test/oracle.test.ts` compares against it, and `generate.sh` regenerates it with
`gbz-base` on your PATH. Commit the regenerated files.

`vg` builds the fixtures that have a GFA file: `split-contig.gfa` (a contig
stored as two path fragments), `looping-walk.gfa` (walks that loop through or
reorder the reference), `far-stretch.gfa` (a deletion that joins a window to a
reference stretch far from its anchors), `two-copies.gfa` and `far-pass.gfa`
(haplotypes that pass the window again from far along their own sequence) and
`detour.gfa` (walks that leave the subgraph and come back) and `unplaced.gfa` (a
contig that visits no anchor and has no sample in the window). `test/fuzz`
generated `reverse-reference.gfa` and `stray-end.gfa`, each with a query that
returned a wrong answer; `stray-end` takes the indexer options in
`test/data/build-indexes.sh`. `quay.io/vgteam/vg` is the easiest `vg` on a Mac.

```sh
vg gbwt -G split-contig.gfa --gbz-format -g split-contig.gbz
gbz-base construct split-contig.gbz -o split-contig.gbz.db
gbz-haplotype-index --interval 200 --anchor-spacing 300 split-contig.gbz split-contig.gbz.db split-contig.haplotype-index.db
```

`looping-walk` uses the first two commands only. The others build their indexes
with these options:

- `far-stretch`:
  `--interval 65536 --anchor-spacing 16384 --reference-interval 1024`
- `two-copies`, `far-pass`, `unplaced`:
  `--interval 65536 --anchor-spacing 16384`
- `detour`: `--interval 1000 --anchor-spacing 0`

`inversion` takes `--interval 4096 --anchor-spacing 65536` and `micb-kir3dl1`
`--interval 1000 --anchor-spacing 2500`, both with `--from-db` on the committed
`.gbz.db`. `test/data/build-indexes.sh` rebuilds every index that has anchors
from its `.gbz.db` and reports a fixture whose samples or anchors change. Run it
after a change to the indexer, and commit the indexes.

## Checking haplotype queries

A piece missing from a query's result draws as a deletion, so a query must
return every piece of every haplotype it names. Three checks cover that, from
small to large.

- `pnpm test --run` compares the keep route with the sampled route on the
  fixtures.
- `test/fuzz/` generates graphs with inversions, duplications, split contigs and
  unplaced contigs, builds the database and the haplotype index with `vg`,
  `gbz-base` and `gbz-haplotype-index`, and compares both routes with the pieces
  read from the GFA. Its README lists the commands.
- `tools/validate/` compares the two routes on windows of a real graph, and
  compares the sampled route with the pieces `gbz-truth` reads from the GBZ. Run
  it after a change to the keep route, `identifyPaths` or the indexer.

## Scripts

- `scripts/measure-windows.mjs` times a set of windows and reports the requests,
  bytes and naming route of each.
- `scripts/time-phases.mjs` splits one query into phases.
- `scripts/chains-dump.mjs` and `scripts/verify-chr20.ts` debug naming.
