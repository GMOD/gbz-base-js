# @gmod/gbz-base

[![NPM version](https://img.shields.io/npm/v/@gmod/gbz-base.svg?style=flat-square)](https://npmjs.org/package/@gmod/gbz-base)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/gbz-base-js/push.yml?branch=main)

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

## Output

`getAlignments` returns an array of records, one per haplotype that crosses the
window. Every record has the same span fields. A record is `resolved` when the
haplotype index named its walk, and only then does it carry the name fields:

```ts
type HaplotypeAlignment = {
  strand: '+' | '-'
  refStart: number
  refEnd: number
  cigar: string
  weight: number | undefined
  path: number[] // GBWT handles: 2 * nodeId forward, 2 * nodeId + 1 reverse
  start: { node: number; offset: number }
} & (
  | {
      resolved: true
      name: {
        sample: string
        contig: string
        haplotype: number
        fragment: number
      }
      label: string // e.g. HG02723#1#JAHEOU010000100.1[4392999-4393486]
      pathHandle: number
      hapStart: number
      hapEnd: number
    }
  | { resolved: false }
)
```

`getSubgraphs` returns `Subgraph` objects. `toSubgraphJson()` returns the same
JSON as upstream's `gbz-base query --format json`:

```ts
{
  nodes: { id: string; sequence: string }[]
  edges: { from: string; from_is_reverse: boolean; to: string; to_is_reverse: boolean }[]
  paths: {
    name: string
    weight?: number
    cigar?: string
    path: { id: string; is_reverse: boolean }[]
  }[]
}
```

`toGFA()` returns the same subgraph as a GFA string.

The command line prints `--alignments` as a JSON array of the records above. It
drops `start`, and a resolved record's `name` holds the label string instead of
the `PathName` object. The default output is the subgraph JSON, and
`--format gfa` prints GFA. The [API reference](docs/api.md#subgraph-output) and
[alignment records](docs/alignments.md) document the remaining fields.

## Haplotype index

Without a haplotype index, gbz-base queries returns each walk as `unknown#N`.

We created a custom approach called
[`gbz-haplotype-index`](https://github.com/GMOD/gbz-haplotype-index)
(`cargo install gbz-haplotype-index`), that adds haplotype walk metadata to the
graph

This creates a separate file alongside the .gbz.db file. It also names every
haplotype's walk when a query keeps a few of them, and carries an
[overview](docs/api.md#overview) of every haplotype in bins along each reference
path, for views of megabases or a whole chromosome. The library reads the index
format that gbz-haplotype-index 0.3 writes and refuses an older one at open.

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

## See also

- [jbrowse-plugin-graphgenomeviewer](https://github.com/GMOD/jbrowse-plugin-graphgenomeviewer) -
  JBrowse 2 plugin that browses these graphs by locus
- [BandageJS](https://github.com/cmdcolin/BandageJS) - standalone page for GFA
  and gbz-base graphs
- [gbz-haplotype-index](https://github.com/GMOD/gbz-haplotype-index) - names
  every walk in a gbz-base cut
- [gfa-to-tabix](https://github.com/GMOD/gfa-to-tabix) - indexes a GFA by genome
  coordinate
- [@jbrowse/bandage-core](https://github.com/GMOD/bandage-core) - Bandage layout
  and drawing engine
- [@jbrowse/tubemap-core](https://github.com/GMOD/tubemap-core) -
  sequenceTubeMap's layout, without the DOM
- [sequenceTubeMap, MemPanG26 edition](https://github.com/cmdcolin/sequenceTubeMap) -
  our fork of the tube map app

Tutorials on [jbrowse.org](https://jbrowse.org/jb2/docs/tutorials/)

- [HPRC part 1: graph alleles and haplotypes](https://jbrowse.org/jb2/docs/tutorials/pangenome_hprc/)
- [HPRC part 3: repeat lengths](https://jbrowse.org/jb2/docs/tutorials/pangenome_hprc_repeats/)
- [Hosting your own graph](https://jbrowse.org/jb2/docs/tutorials/pangenome_prepare_graph/)

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
