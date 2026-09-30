# Validating haplotype queries on a real graph

Two checks, both run on local files:

- **Parity**: a query that uses the `keep` option returns the walks that
  identifying every walk returns for those haplotypes. `sweep.ts` runs both and
  compares the GFA and the alignment records.
- **Truth**: identifying every walk returns the pieces that the paths leave in
  the subgraph. `gbz-truth` lists those pieces from the GBZ alone, without the
  haplotype index or this library.

## Windows

`run.sh` takes a JSON list of windows, each with a stratum, a reference sample
and contig, a range, `[context, snarls]` combos and keep sets. Two scripts write
such lists for an HPRC graph:

- `windows-targeted.py` aims at the stray rows: the bin of a random stray row
  with that row's haplotype kept, the bin of a path that lies inside one snarl,
  both ends of an edge that joins two distant reference nodes (from the `jumps`
  tool), bin boundaries, anchors and windows of 150-500 kb.
- The 2026-09-28 sweep's `gen.py` (random, segmental duplication, chromosome
  end, acrocentric, CHM13 and unplaced-contig windows) lives on `ada` in
  `~/keep-sweep` with its `rows.json`.

## Running

```sh
cargo build --release --manifest-path tools/validate/truth/Cargo.toml

truth/target/release/jumps graph.gbz GRCh38 16384 > jumps.tsv
python3 windows-targeted.py graph.gbz.db graph.haplotype-index.db jumps.tsv rows.json

GRAPH=graph.gbz.db INDEX=graph.haplotype-index.db TRUTH=1 WORKERS=12 \
  ./run.sh runs/NAME rows.json
python3 summarize.py runs/NAME

cat runs/NAME/out/*.nodes.tsv > runs/NAME/queries.tsv
truth/target/release/gbz-truth graph.gbz runs/NAME/queries.tsv 20 > runs/NAME/truth.tsv
python3 truth-compare.py runs/NAME runs/NAME/truth.tsv
```

`./run.sh runs/NAME rows.json all` keeps every haplotype in each window and
lifts the limit on chosen paths, so every piece the keep route can drop shows.
`CONTIG` and `STRATA` narrow the rows, and `GBZ_SRC` points the sweep at another
checkout's `src/`.

`summarize.py` prints, per stratum, the queries the keep route answered, the
fallbacks with their reasons, and every query whose result differs. A run passes
when the WRONG and KEEP-ONLY columns hold zero and `truth-compare.py` reports no
subgraph that differs.

`test/fuzz/` checks the same two properties on generated graphs, with the truth
read from the GFA.
