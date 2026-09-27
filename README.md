# @gmod/gbz-base

[![NPM version](https://img.shields.io/npm/v/@gmod/gbz-base.svg?style=flat-square)](https://npmjs.org/package/@gmod/gbz-base)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/gbz-base-js/publish.yml?branch=main)

A TypeScript reader for [gbz-base](https://github.com/jltsiren/gbz-base)
pangenome databases (`.gbz.db`). It reads only the pages a query needs, so it
can query a multi-gigabyte database on a web server through range requests.

The npm package contains a JavaScript library and a command-line program that
runs the same queries. A separate Rust program in this repository builds the
optional haplotype index that names the walks.

| Program               | Kind              | Source                   | Use it to                                    |
| --------------------- | ----------------- | ------------------------ | -------------------------------------------- |
| `GBZBase`             | JavaScript class  | this npm package         | query a database from browser or Node code   |
| `gbz-base-query`      | Node command line | this npm package         | query a database from a shell                |
| `gbz-haplotype-index` | Rust command line | `tools/haplotype-index/` | add the tables that name walks, once a graph |
| `gbz-base construct`  | Rust command line | upstream gbz-base        | build the `.gbz.db` from a `.gbz` file       |

## Library

```bash
npm install @gmod/gbz-base
```

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

Coordinates are 0-based half-open offsets along the named path. The
[library API](docs/api.md) lists the options and output formats.

## Command line

`gbz-base-query` takes the flags of upstream's `gbz-base query`, reads a local
file or a URL, and prints JSON, GFA or PAF.

```bash
npx -p @gmod/gbz-base gbz-base-query https://example.org/graph.gbz.db \
  --sample GRCh38 --contig chr6 --interval 31500000..31501000 --alignments
```

`npm install -g @gmod/gbz-base` puts it on your PATH. The
[command-line reference](docs/cli.md) lists every flag with its library
equivalent.

## Haplotype index

Without a haplotype index, a query returns each walk unnamed. Build one with
`gbz-haplotype-index` (`cargo install gbz-haplotype-index`) as a companion file
beside the database ([naming haplotypes](docs/haplotype-index.md)). With an
index, `keep` restricts a query to chosen haplotypes.

```ts
const db = await GBZBase.open(new RemoteFile(graphUrl), {
  haplotypeIndex: new RemoteFile(indexUrl),
})
const records = await db.getAlignmentsForRange(region, start, end, {
  keep: name => name.sample === 'HG00097',
})
```

```bash
gbz-base-query "$graphUrl" --haplotype-index "$indexUrl" \
  --sample GRCh38 --contig chr6 --interval 31500000..31501000 \
  --alignments --keep HG00097
```

## Documentation

Reference:

- [Library API](docs/api.md): options, output formats and errors
- [Command line](docs/cli.md): flags and output

Topics, with examples for both the library and the command line:

- [Alignment records](docs/alignments.md), including haplotype-to-haplotype PAF
- [Naming haplotypes](docs/haplotype-index.md)
- [Snarls](docs/snarls.md)
- [Contents and limitations](docs/contents-and-limitations.md)

Design:

- [How a query flows](docs/dataflow.md)
- [Performance](docs/performance.md) and [optimizations](docs/optimizations.md)
- [Internals](docs/internals.md)
- [Contributing](CONTRIBUTING.md)

[jbrowse-plugin-graphgenomeviewer](https://github.com/GMOD/jbrowse-plugin-graphgenomeviewer)
uses this package for its graph view and haplotype lanes. The project started
from ideas at MemPanG 26.

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)

## Usage

This module is currently used by

- BandageJS https://github.com/cmdcolin/BandageJS (uses Bandage graph layout,
  can fetch data with gbz-base)
- sequenceTubeMap fork https://github.com/cmdcolin/sequenceTubeMap (modified
  sequenceTubeMap, can fetch data with gbz-base)
- jbrowse-plugin-graphgenomeviewer
  https://github.com/GMOD/jbrowse-plugin-graphgenomeviewer (similar to BandageJS
  but has genome browser integration)
