# @gmod/gbz-base

[![NPM version](https://img.shields.io/npm/v/@gmod/gbz-base.svg?style=flat-square)](https://npmjs.org/package/@gmod/gbz-base)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/gbz-base-js/publish.yml?branch=main)

A pure TypeScript reader for [gbz-base](https://github.com/jltsiren/gbz-base)
pangenome databases (`.gbz.db`).

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

Coordinates are 0-based half-open, and are offsets along the path you named, so
`('GRCh38#0#chr6', 31500000, 31501000)` is the same window
`gbz-base query --interval 31500000..31501000` gives. The path is a PanSN
`sample#haplotype#contig` string, or a bare contig for a graph whose reference
paths have no sample.

It reads only the SQLite pages a query touches, so a multi-gigabyte database on
an HTTP server is queried through range requests without downloading it. Any
`generic-filehandle2` source works — `LocalFile`, `RemoteFile`, `BlobFile` — and
there is a `gbz-base-query` command line that mirrors the upstream tool. Every
option, method and query function: [docs/api.md](docs/api.md).

## What comes back

```ts
for (const alignment of alignments) {
  const { refStart, refEnd, strand, cigar } = alignment
  if (alignment.resolved) {
    console.log(alignment.label, alignment.hapStart, alignment.hapEnd)
  }
}
```

A record is one haplotype's passage through the window, aligned to the reference
path you queried. Where a haplotype leaves the subgraph and comes back — a
private insertion, a bubble the window does not hold — the pieces are joined
back into one record and the stretch between them becomes its insertion and
deletion, so `context` changes what is read rather than how many records you
get. The fields, the joining rules and what `resolved` means:
[docs/alignments.md](docs/alignments.md).

`getAlignmentsForRange` hands back data and spans path fragments;
`getSubgraphForRange` hands back the `Subgraph` itself, because two disjoint
fragments do not merge into one graph.

## Naming haplotypes

Upstream gbz-base cannot say which haplotype a subgraph path belongs to, so it
emits `unknown#N`. This package adds that with two side tables that a small Rust
tool (`tools/haplotype-index/`) writes into an existing database, or into a
standalone companion beside a database someone else hosts:

```ts
const db = await GBZBase.open(new RemoteFile(graphUrl), {
  haplotypeIndex: new RemoteFile(indexUrl),
})
```

With names in hand, `keep` cuts a window to a chosen set of haplotypes — the
reference walk, the walks the predicate accepts and the nodes those walks visit,
so the drawing shows that set's private sequence and nothing else's. On a
companion carrying anchors those haplotypes are walked from an anchor before the
window, and nothing else is extracted or named, so the query costs the set
rather than the graph: the eight haplotypes of the MHC class II tutorial window
come back in 0.97 s against 9.16 s for all 464, both warm.
[docs/haplotype-index.md](docs/haplotype-index.md) builds the index and explains
the two routes; [docs/performance.md](docs/performance.md) has the measurements.

## Snarls

The `snarls` option uses the top-level chains a `.gbz.db` already stores, the
way upstream's `--snarls` and `--extend-snarls` do — `contained` brings a
window's variation back without widening it by a bp radius.
[docs/snarls.md](docs/snarls.md).

## Why not compile the Rust to wasm

gbwt-rs and simple-sds serialize `usize` at native width, so a `wasm32` build
misreads every file written on a 64-bit host, and
[the PR to fix that](https://github.com/jltsiren/gbwt-rs/pull/14) was closed
unmerged — reasonably, since the same hazard sits on every other `usize` in the
crate. `wasm64` fixes the width but cannot carry gbz-base, whose bundled SQLite
has no wasm64 libc. A TypeScript reader has neither problem, and gets HTTP range
access and a JBrowse RPC worker for free:
[docs/why-not-wasm.md](docs/why-not-wasm.md).

## Docs

- [docs/api.md](docs/api.md) — every option, query function, output format and
  command line flag
- [docs/alignments.md](docs/alignments.md) — what an alignment record is, and
  how walk fragments are joined into one
- [docs/haplotype-index.md](docs/haplotype-index.md) — building the haplotype
  index, and the two routes a named query takes
- [docs/snarls.md](docs/snarls.md) — the snarl options and `--between`
- [docs/performance.md](docs/performance.md) — measured windows, and picking
  `context`
- [docs/internals.md](docs/internals.md) — reading SQLite without SQLite, and
  where this reader's CIGARs differ from upstream's
- [docs/why-not-wasm.md](docs/why-not-wasm.md) — why the Rust was not compiled
  to WebAssembly instead
- [CONTRIBUTING.md](CONTRIBUTING.md) — development, test data and release steps

## Footnote

Started from ideas at MemPanG 26!

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
