# @gmod/gbz-base

[![NPM version](https://img.shields.io/npm/v/@gmod/gbz-base.svg?style=flat-square)](https://npmjs.org/package/@gmod/gbz-base)
![Build Status](https://img.shields.io/github/actions/workflow/status/GMOD/gbz-base-js/push.yml?branch=main)

A TypeScript reader for [gbz-base](https://github.com/jltsiren/gbz-base)
pangenome databases (`.gbz.db`).

- The reader fetches only the pages a query touches, so it can query a
  multi-gigabyte database on a web server through range requests.
- Upstream's `gbz-base construct` builds the database from a `.gbz` file.
- The npm package contains a JavaScript library and a command-line program that
  runs the same queries.
- The optional haplotype index, built by
  [gbz-haplotype-index](https://github.com/GMOD/gbz-haplotype-index), gives the
  sample and haplotype of each walk a query returns.

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

`getAlignments` returns one record per haplotype crossing the window. A
`resolved` record, whose walk the haplotype index names, also has the name
fields:

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

On the command line:

- `--alignments` prints the records above as JSON, without `start`, and with the
  label string as `name`.
- The default output is the subgraph JSON, and `--format gfa` prints GFA.

The [API reference](docs/api.md#subgraph-output) and
[alignment records](docs/alignments.md) document the remaining fields.

## Haplotype index

Without a haplotype index, gbz-base queries return each walk as `unknown#N`.

[`gbz-haplotype-index`](https://github.com/GMOD/gbz-haplotype-index)
(`cargo install gbz-haplotype-index`) writes a file alongside the `.gbz.db`.

- The index names every haplotype's walk when a query keeps a few of them.
- It also holds an [overview](docs/api.md#overview) of every haplotype in bins
  along each reference path, for views of megabases or a whole chromosome.
- The library reads the gbz-haplotype-index 0.3 format and refuses an older one
  at open.

```ts
const db = await GBZBase.open({
  source: new RemoteFile(graphUrl),
  haplotypeIndex: new RemoteFile(indexUrl),
})
// all haplotypes
const records = await db.getAlignments({ path, start, end })

// only those whose name passes the callback
const records = await db.getAlignments({
  path,
  start,
  end,
  keep: name => name.sample === 'HG00097',
})
```

On the command line:

```bash
npx -p @gmod/gbz-base gbz-base-query "$graphUrl" --haplotype-index "$indexUrl" \
  --sample GRCh38 --contig chr6 --interval 31500000..31501000 \
  --alignments --keep HG00097
```

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

## See also

The project started at the MemPanG 26 hackathon.

- [jbrowse-plugin-graphgenomeviewer](https://github.com/GMOD/jbrowse-plugin-graphgenomeviewer) -
  JBrowse 2 plugin that browses these graphs by locus, drawn as Bandage or as a
  tube map
- [BandageJS](https://github.com/cmdcolin/BandageJS) - standalone page that
  draws GFA and gbz-base graphs with Bandage's layout code
- [@jbrowse/bandage-core](https://github.com/GMOD/bandage-core) - Bandage layout
  and drawing engine
- [@jbrowse/tubemap-core](https://github.com/GMOD/tubemap-core) -
  sequenceTubeMap's layout, without the DOM
- [sequenceTubeMap, MemPanG26 edition](https://github.com/cmdcolin/sequenceTubeMap) -
  our fork of the tube map app

Tutorials on [jbrowse.org](https://jbrowse.org/jb2/docs/tutorials/)

- [HPRC part 3: repeat lengths](https://jbrowse.org/jb2/docs/tutorials/pangenome_hprc_repeats/)
- [Hosting your own graph](https://jbrowse.org/jb2/docs/tutorials/pangenome_prepare_graph/)

## Alternative approach

- [gfa-to-tabix](https://github.com/GMOD/gfa-to-tabix) - indexes a GFA by genome
  coordinate
- [Comparison of gfa-to-tabix with gbz-base](https://github.com/GMOD/gfa-to-tabix/blob/main/docs/gbz-comparison.md) -
  what each format holds, sizes and requests on HPRC v2.1

## License

MIT © [Colin Diesh](https://github.com/cmdcolin)
