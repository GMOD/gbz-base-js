# @gmod/gbz-base

[![NPM version](https://img.shields.io/npm/v/@gmod/gbz-base.svg?style=flat-square)](https://npmjs.org/package/@gmod/gbz-base)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/gbz-base-js/publish.yml?branch=main)

A TypeScript reader for [gbz-base](https://github.com/jltsiren/gbz-base)
pangenome databases (`.gbz.db`). It reads only the SQLite pages a query touches,
so it can query a multi-gigabyte database on an HTTP server through range
requests without downloading it.

## Install

```bash
npm install @gmod/gbz-base
```

## Usage

```ts
import { RemoteFile } from 'generic-filehandle2'
import { GBZBase } from '@gmod/gbz-base'

const db = await GBZBase.open(
  new RemoteFile('https://example.org/graph.gbz.db'),
)

// one record per haplotype crossing the window
const alignments = await db.getAlignmentsForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
)

// the same window as a subgraph, for a pangenome view
const subgraph = await db.getSubgraphForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
)
const gfa = await subgraph?.toGFA({ names: 'resolved' })
```

Coordinates are 0-based half-open offsets along the named path, so this window
matches `gbz-base query --interval 31500000..31501000`. The path is a PanSN
`sample#haplotype#contig` string, or a bare contig for a graph whose reference
paths have no sample. Any `generic-filehandle2` source works: `LocalFile`,
`RemoteFile` or `BlobFile`.

The package also installs `gbz-base-query`, a command line that mirrors the
upstream `gbz-base query`:

```
gbz-base-query https://example.org/graph.gbz.db --sample GRCh38 --contig chr6 \
  --interval 31500000..31501000 --alignments
```

## What a query returns

`getAlignmentsForRange` returns one record per haplotype passage through the
window, with its span on the reference, strand and CIGAR. A haplotype that
leaves the window's subgraph and comes back still gives one record: the reader
joins the pieces and scores the stretch between them as an insertion and a
deletion. See [docs/alignments.md](docs/alignments.md).

`getSubgraphForRange` returns the `Subgraph` itself, which writes GFA,
upstream's JSON, or a compact typed-array form for sending between workers
([docs/api.md](docs/api.md#subgraph-output)). `subgraph.pairAlignments` aligns
one haplotype to another, comparing bases, and `gbz-base-query --stack` prints
those alignments as PAF for a stacked synteny view
([docs/alignments.md](docs/alignments.md#one-haplotype-against-another)).

## Naming haplotypes

Upstream gbz-base cannot tell which haplotype a subgraph walk belongs to, so it
prints `unknown#N`. This package names each walk with a haplotype index: side
tables that a small Rust tool in `tools/haplotype-index/` writes into the
database, or into a companion file beside a database someone else hosts.

```ts
const db = await GBZBase.open(new RemoteFile(graphUrl), {
  haplotypeIndex: new RemoteFile(indexUrl),
})
const records = await db.getAlignmentsForRange(region, start, end, {
  keep: name => name.sample === 'HG00097',
})
```

With an index, the `keep` option cuts a window to a chosen set of haplotypes. On
a companion with anchors, the reader walks only those haplotypes, so the cost
follows the size of the set: the tutorial's eight haplotypes at MHC class II
take 0.97 s, against 9.16 s for all 464, both with the window cached. See
[docs/haplotype-index.md](docs/haplotype-index.md).

## In JBrowse

[jbrowse-plugin-graphgenomeviewer](https://github.com/GMOD/jbrowse-plugin-graphgenomeviewer)
uses this package in its `GbzBaseSyntenyAdapter`, which runs in a JBrowse RPC
worker. It calls `getSubgraphForRange` for the graph view and
`getAlignmentsForRange` for the haplotype lanes, and passes the subgraph to the
main thread with `toCompactSubgraph`, which structured-clones in 1.9 ms where
upstream's JSON format takes 295 ms.

## Documentation

Using the package:

- [Contents and limitations](docs/contents-and-limitations.md): what a GBZ
  records, and what a query cannot do
- [API](docs/api.md): options, query functions, output formats, errors and the
  command line
- [Alignment records](docs/alignments.md): the record fields, how pieces are
  joined, and haplotype-to-haplotype alignment
- [Naming haplotypes](docs/haplotype-index.md): building the index, and the
  sampled and anchored routes
- [Snarls](docs/snarls.md): filling variation sites around a window, and
  `--between`

How it works:

- [How a query flows](docs/dataflow.md): a diagram of each step from the call to
  the range request
- [Internals](docs/internals.md): reading SQLite without SQLite, and fidelity to
  upstream
- [Performance](docs/performance.md): measured windows, and where the time goes
- [Optimizations](docs/optimizations.md): the alignment search, the anchored
  walk and the output format
- [Why not WebAssembly](docs/why-not-wasm.md): why this is a TypeScript reader
  and not the Rust compiled to wasm

[CONTRIBUTING.md](CONTRIBUTING.md) covers development, test data and releases.

The project started from ideas at MemPanG 26.

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
