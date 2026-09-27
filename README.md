# @gmod/gbz-base

[![NPM version](https://img.shields.io/npm/v/@gmod/gbz-base.svg?style=flat-square)](https://npmjs.org/package/@gmod/gbz-base)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/gbz-base-js/publish.yml?branch=main)

A TypeScript reader for [gbz-base](https://github.com/jltsiren/gbz-base)
pangenome databases (`.gbz.db`). It reads only the pages a query needs, so it
can query a multi-gigabyte database on a web server through range requests.

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

// one alignment record per haplotype crossing the window
const alignments = await db.getAlignmentsForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
)

// the same window as a graph
const subgraph = await db.getSubgraphForRange(
  'GRCh38#0#chr6',
  31500000,
  31501000,
)
const gfa = await subgraph?.toGFA({ names: 'resolved' })
```

Coordinates are 0-based half-open offsets along the named path, matching
`gbz-base query --interval 31500000..31501000`.

The package also installs `gbz-base-query`, a command line that mirrors
`gbz-base query`:

```
gbz-base-query https://example.org/graph.gbz.db --sample GRCh38 --contig chr6 \
  --interval 31500000..31501000 --alignments
```

## Haplotype names

Walk names come from a haplotype index, built by the Rust tool in
`tools/haplotype-index/` into the database or into a companion file. With an
index, `keep` restricts a query to chosen haplotypes:

```ts
const db = await GBZBase.open(new RemoteFile(graphUrl), {
  haplotypeIndex: new RemoteFile(indexUrl),
})
const records = await db.getAlignmentsForRange(region, start, end, {
  keep: name => name.sample === 'HG00097',
})
```

## Documentation

- [API](docs/api.md): options, output formats, command line and errors
- [Alignment records](docs/alignments.md), including haplotype-to-haplotype PAF
- [Naming haplotypes](docs/haplotype-index.md)
- [Snarls](docs/snarls.md)
- [Contents and limitations](docs/contents-and-limitations.md)
- [How a query flows](docs/dataflow.md)
- [Performance](docs/performance.md) and [optimizations](docs/optimizations.md)
- [Internals](docs/internals.md)
- [Why not WebAssembly](docs/why-not-wasm.md)
- [Contributing](CONTRIBUTING.md)

[jbrowse-plugin-graphgenomeviewer](https://github.com/GMOD/jbrowse-plugin-graphgenomeviewer)
uses this package for its graph view and haplotype lanes. The project started
from ideas at MemPanG 26.

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
