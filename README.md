# @gmod/gbz-base

[![NPM version](https://img.shields.io/npm/v/@gmod/gbz-base.svg?style=flat-square)](https://npmjs.org/package/@gmod/gbz-base)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/gbz-base-js/publish.yml?branch=main)

A TypeScript reader for [gbz-base](https://github.com/jltsiren/gbz-base)
pangenome databases (`.gbz.db`). The reader fetches only the pages a query
touches, so a multi-gigabyte database on a web server answers through range
requests. Upstream's `gbz-base construct` builds the database from a `.gbz`
file.

The npm package contains a JavaScript library and a command-line program that
runs the same queries. A separate Rust program in this repository builds the
optional haplotype index, which tells the library the sample and haplotype of
each walk a query returns.

## Library

```bash
npm install @gmod/gbz-base
```

```ts
import { RemoteFile } from 'generic-filehandle2'
import { GBZBase } from '@gmod/gbz-base'

const db = await GBZBase.open({
  source: new RemoteFile('https://example.org/graph.gbz.db'),
})
const window = { path: 'GRCh38#0#chr6', start: 31500000, end: 31501000 }

// one alignment record per haplotype crossing the window
const alignments = await db.getAlignments(window)

// the same window as a graph, one subgraph per path fragment it overlaps
const [subgraph] = await db.getSubgraphs(window)
const gfa = await subgraph?.toGFA()
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

`npm install -g @gmod/gbz-base` puts `gbz-base-query` on your PATH. The
[command-line reference](docs/cli.md) lists every flag with its library
equivalent.

## Haplotype index

Without a haplotype index, gbz-base queries returns each walk as `unknown#N`.

We created a custom approach called
[`gbz-haplotype-index`](https://github.com/GMOD/gbz-haplotype-index)
(`cargo install gbz-haplotype-index`), that adds haplotype walk metadata to the
graph

This creates a separate file alongside the .gbz.db file. It also names every
haplotype's walk when a query keeps a few of them, and carries an
[overview](docs/api.md#overview) of every haplotype in bins along each reference
path, for views of megabases or a whole chromosome.

Example usage:

```ts
const db = await GBZBase.open({
  source: new RemoteFile(graphUrl),
  haplotypeIndex: new RemoteFile(indexUrl),
})
// return all haplotypes
const records = await db.getAlignments({ path, start, end })

// or, restrict to particular haplotype. can match multiple haplotypes here in callback
const records = await db.getAlignments({
  path,
  start,
  end,
  keep: name => name.sample === 'HG00097',
})
```

Same thing using our command line tool

```bash
npx -p @gmod/gbz-base gbz-base-query "$graphUrl" --haplotype-index "$indexUrl" \
  --sample GRCh38 --contig chr6 --interval 31500000..31501000 \
  --alignments --keep HG00097
```

## Programs

| Program                         | Use it to                                  |
| ------------------------------- | ------------------------------------------ |
| `GBZBase`                       | query a database from browser or Node code |
| `gbz-base-query`                | query a database from a shell              |
| `gbz-haplotype-index`           | build the haplotype index, once per graph  |
| `gbz-base construct` (upstream) | build the `.gbz.db` from a `.gbz` file     |

## Documentation

Reference:

- [Library API](docs/api.md): options, output formats and errors
- [Command line](docs/cli.md): flags and output

Topics, with examples for both the library and the command line:

- [Alignment records](docs/alignments.md), including haplotype-to-haplotype PAF
- [The haplotype index](https://github.com/GMOD/gbz-haplotype-index/blob/main/docs/haplotype-index.md)
- [Snarls](docs/snarls.md)
- [Contents and limitations](docs/contents-and-limitations.md)

Design:

- [How a query flows](docs/dataflow.md)
- [Performance](docs/performance.md) and [optimizations](docs/optimizations.md)
- [Internals](docs/internals.md)
- [Contributing](CONTRIBUTING.md)

## Used by

- [BandageJS](https://github.com/cmdcolin/BandageJS) - Our webpage that draws
  the graph with Bandage's exact graph layout code
- [sequenceTubeMap - MemPanG26 edition](https://github.com/cmdcolin/sequenceTubeMap) -
  our sequenceTubeMap fork
- [JBrowse 2 w/ jbrowse-plugin-graphgenomeviewer](https://github.com/GMOD/jbrowse-plugin-graphgenomeviewer) -
  can render both BandageJS and sequenceTubeMap approaches

## Inspiration

The project started from ideas at MemPanG 26 hackathon

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
