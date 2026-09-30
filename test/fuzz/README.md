# Ground-truth fuzzer

`run.ts` generates small pangenome graphs as GFA, builds a gbz-base database and
a haplotype index from each, and compares the walks the library reports with the
walks the GFA text spells out. The GFA is the ground truth, so the comparison
depends on neither the library's GBWT decoding nor the haplotype index.

- `gen.ts` writes a seeded GFA 1.1 graph with `W` lines: a reference
  `GRCh38#0#chr1` that runs `>1>2>3…`, and haplotypes derived from it by SNPs,
  insertions, deletions, inversions, tandem and dispersed duplications, hairpins
  and self-loops. It stores contigs on either strand, cuts them into fragments,
  and adds short extra contigs. Some seeds add a second reference sample,
  `CHM13`. No node exceeds 1000 bp, so `vg` keeps the GFA's node ids.
- `truth.ts` parses a GFA and lists, for a set of nodes, every maximal run of
  consecutive steps of each walk on those nodes, with its coordinates along the
  walk.
- `run.ts` runs the queries and compares.

`vitest` does not collect these files. `pnpm typecheck`, `pnpm lint` and
`pnpm format:check` cover them.

## Running

`vg`, `gbz-base` and `gbz-haplotype-index` must be on `PATH`. `--indexer`, or
`GBZ_HAPLOTYPE_INDEX`, names another indexer binary.

```sh
node test/fuzz/run.ts --seeds 0..200
node test/fuzz/run.ts --seeds 0..5000 --scale medium --jobs 8 --keep-going \
  --tmp /dev/shm/gbz-fuzz --dump-dir /dev/shm/gbz-fuzz-failed
```

`--seeds 0..200` runs seeds 0 to 199. `--scale small` builds a reference of 4–15
kb with 3–8 haplotypes, and `--scale medium` one of 20–60 kb with 6–16. A small
seed takes about 0.2 s and a medium seed about 0.7 s in one process.

`--index-args` replaces the indexer's options, which default to
`--interval 256 --anchor-spacing 2048 --stray-context 100`. The runner passes no
`--anchor-sample`, so both reference samples carry anchors.

Scale every distance the indexer takes to these graphs. An option left at a
production default larger than the graph never takes effect: `--stray-bin 16384`
puts a whole small graph in one bin, and `--stray-bound 32768` lets every walk
from an anchor run to the end of its path, so no query depends on a stray row.
At `--scale medium` those two defaults also send about seven keep queries in ten
to the sampled route, over the cap on a walk's bases outside the subgraph.
Options in the production ratio to a 2048 bp anchor spacing exercise the stray
rows and leave nearly every medium query on the keep route:

```sh
node test/fuzz/run.ts --seeds 0..1000 --scale medium --jobs 8 --keep-going \
  --index-args "--interval 256 --anchor-spacing 2048 --stray-context 100 --stray-bin 1024 --stray-bound 2048 --stray-gap 64"
```

`--src DIR` tests another copy of the library's `src/`, such as a checkout of
`main`. `--windows`, `--targets`, `--combos` and `--keep-sets` set how many
queries a seed runs; `--help` lists them.

## What a seed checks

The runner first checks that the database holds the GFA's nodes under the GFA's
ids and its walks under the GFA's names.

Each window is an interval of a reference path: random ones from 1 bp to the
whole path, and ones placed at and beside the structures the generator reports.
A window takes a `context` of 0, 1, 17 or 100 bp and `snarls` of `none` or
`contained`.

- **Sampled route.** `subgraphInInterval` then `identifyPaths`. Every walk must
  carry a name, and the walks must equal the GFA's pieces on the subgraph's
  nodes: the same path, the same `hapStart` and `hapEnd`, the same nodes. A
  piece may appear once in each orientation.
- **Keep route.** `subgraphForHaplotypes` for each haplotype with a piece, each
  sample with one, a random subset and everything. The walks must equal the
  GFA's pieces of the kept haplotypes plus the reference piece that contains the
  window. A query that fell back to the sampled route must still match.

## Output

The runner prints one JSON line per failing query, then a summary line. A
failing query's line, wrapped here:

```json
{
  "seed": 691,
  "scale": "small",
  "reference": "CHM13#0#chr1@0",
  "start": 6042,
  "end": 6249,
  "context": 17,
  "snarls": "none",
  "target": "inversion",
  "route": "keep",
  "keep": ["HG002#2"],
  "missing": ["HG002#2#ctg1@0:487-585 <32<31<30"],
  "extra": [],
  "unidentified": 0
}
```

- `reference` is `sample#haplotype#contig@fragment`, and `start` and `end` are
  the coordinates the query passed.
- `target` names the generated structure a window was aimed at.
- `route` is `sampled`, `keep`, or `fallback` for a keep query that the sampled
  route answered, with the reason in `fallback`.
- `missing` lists pieces of the GFA the library left out, as
  `path:hapStart-hapEnd walk`. `extra` lists walks the GFA does not have, walks
  with the wrong nodes, and walks without a name.

The summary counts seeds, queries, sampled mismatches, keep queries the keep
route answered, fallbacks by reason, and keep mismatches with a missing or an
extra piece. The runner exits non-zero after any mismatch or error.

## Reproducing a failing seed

A seed and a scale fix the graph and the queries, given the same indexer options
and query counts. Run the one seed and keep its files:

```sh
node test/fuzz/run.ts --seeds 691 --scale small --dump-dir /tmp/failed
```

`/tmp/failed/small-seed-691/` then holds `graph.gfa`, `graph.gbz`,
`graph.gbz.db` and `graph.haplotype-index.db`. Open the two databases with
`GBZBase.open` and repeat the query from the failing line, or read the `W` lines
of `graph.gfa` beside the `missing` walk.
