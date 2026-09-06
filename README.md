# @gmod/gbz-base

A pure TypeScript reader for [gbz-base](https://github.com/jltsiren/gbz-base)
pangenome databases (`.gbz.db`). It answers the same subgraph queries as
`gbz-base query`, reading only the SQLite pages a query touches, so a
multi-gigabyte database on an HTTP server is queried through range requests
without downloading it or compiling anything to WebAssembly.

No SQLite library is involved. The reader walks the SQLite b-trees directly
(rowid lookups, index seeks, overflow chains) and decodes the GBWT node records
the same way gbwt-rs does. Databases are produced by unmodified upstream
`gbz-base construct`.

## Usage

```ts
import { RemoteFile } from 'generic-filehandle2'
import { GBZBase, subgraphInInterval } from '@gmod/gbz-base'

const db = await GBZBase.open(
  new RemoteFile('https://example.org/graph.gbz.db'),
)
const subgraph = await subgraphInInterval(
  db,
  { sample: 'GRCh38', contig: 'chr6' },
  31500000,
  31501000,
  { context: 0, haplotypes: 'all' },
)
const { nodes, edges, paths } = subgraph.toJSON(true)
```

`paths[0]` is the reference interval, named `GRCh38#0#chr6[start-end]`. Every
other entry is one haplotype's walk through the subgraph with a `cigar` relative
to the reference, computed like upstream: a node-length-weighted LCS, with the
diverging stretches scored using vg's match, mismatch and gap parameters.

Any object with `read(length, position)` and `stat()` works as a source, so
`LocalFile`, `RemoteFile` and `BlobFile` from `generic-filehandle2` all do.
Pages are fetched in blocks (64 KiB by default, `blockSize` in the open options)
and cached.

The command line mirrors the upstream tool for the query types it supports:

```
gbz-base-query graph.gbz.db --sample GRCh38 --contig chr6 --interval 31500000..31501000 --cigar
gbz-base-query https://host/graph.gbz.db --contig chrM --offset 1000 --context 50 --stats
```

`--stats` reports how many range requests a query made and how many bytes they
carried.

## Naming haplotypes

Upstream gbz-base cannot say which haplotype a subgraph path belongs to, so it
emits `unknown#N`. This package adds that with two side tables that a small Rust
tool writes into an existing database, built on the unmodified upstream crates:

```
cd tools/haplotype-index && cargo build --release
./target/release/gbz-haplotype-index --interval 4096 graph.gbz graph.gbz.db
./target/release/gbz-haplotype-index --interval 4096 --from-db graph.gbz.db
```

The second form walks the paths through the database's own node records, so a
database whose GBZ is no longer at hand can still be augmented; the two forms
write identical tables.

`HaplotypeSamples` holds one GBWT position every `--interval` bp along every
path in both orientations, with the path handle and the forward coordinate of
that node, and `HaplotypeLengths` holds each path's length. The upstream `query`
binary keeps working on the augmented database.

At query time `subgraph.identifyPaths()` loads the samples for the window's node
range in one index scan, chains each haplotype's fragments to the next through
the private nodes between them, and walks at most one interval past the window
for a chain that met no sample inside it. `subgraph.alignments()` then gives one
record per fragment: PanSN name, strand, haplotype interval in that contig's
coordinates, reference interval, and a CIGAR clipped to the fragment's own
reference span. `toJSON(cigar, { names: 'resolved' })` names the paths the same
way. On the command line, `--resolve` and `--alignments`.

The tests check every resolved fragment against an independent backward walk
through the bidirectional GBWT to the path's recorded start position.

## Fidelity

`test/data/oracle/` holds JSON written by upstream `gbz-base query` for the
queries listed in `queries.txt`, over databases built from gbwt-rs's test graphs
(`micb-kir3dl1.gbz`, a 46-sample HPRC slice; `example.gbz`; `example-v3.gbz`).
The test suite requires this library's output to be deep equal to every one of
them, CIGAR strings included. `generate.sh` regenerates the oracle with an
upstream binary.

Not ported: snarl extension (`--snarls`, `--between`), GFA output, GAF-base.

CIGARs are computed by matching each shared node to its earliest usable
occurrence on the reference walk, which is weight-optimal whenever every shared
node can be placed in order; the Myers-based weighted LCS from gbwt-rs runs only
for the fragments where that fails (inversions, repeats). The two can pick
different equal-weight alignments only when the reference walk repeats a node.

## Measured

Against a 134 MB HPRC chr20 `.gbz.db` served over HTTPS,
`--sample GRCh38 --contig chr20`:

| window | context | nodes | haplotype fragments | range requests | bytes read | time  |
| ------ | ------- | ----- | ------------------- | -------------- | ---------- | ----- |
| 500 bp | 0       | 17    | 11                  | 7              | 459 KB     | 1.4 s |
| 10 kb  | 0       | 627   | 1021                | 8              | 524 KB     | 2.1 s |
| 100 kb | 0       | 2051  | 3673                | 13             | 852 KB     | 1.7 s |
| 10 kb  | 100 bp  | 1086  | 35                  | 9              | 590 KB     | 0.8 s |

Most of the wall time in the small queries is sequential request latency, not
decoding.

## Footnote

Started from ideas at MemPanG 26! Earlier work considered WASM cross compilation
of the rust code but gbwt-rs and simple-sds serialize `usize` at native width,
so their wasm32 builds misread files written on 64-bit hosts, and the maintainer
declined a 32-bit port. wasm64 fixes that for gbwt-rs but cannot carry gbz-base,
whose bundled SQLite has no wasm64 libc. A TypeScript reader has neither problem
and runs in a JBrowse RPC worker with the file access layer JBrowse already has.
