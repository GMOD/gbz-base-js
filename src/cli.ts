import { LocalFile, RemoteFile } from 'generic-filehandle2'

import { GBZBase, formatPathName } from './db.ts'
import {
  subgraphAroundNodes,
  subgraphAtOffset,
  subgraphInInterval,
} from './query.ts'

import type { HaplotypeOutput } from './subgraph.ts'

const USAGE = `Usage: gbz-base-query [options] graph.gbz.db

  --sample STR         sample name (default: generic path)
  --contig STR         contig name (required for --offset and --interval)
  --haplotype INT      haplotype number (default: 0)
  -o, --offset INT     sequence offset
  -i, --interval A..B  half-open sequence interval
  -n, --node INT       node identifier (may repeat)
  --context INT        context length in bp (default: 100)
  --limit INT          safety limit for the number of nodes
  --haplotypes SEL     all, distinct, reference-only or none (default: all)
  --cigar              output CIGAR strings for the haplotypes
  --resolve            name haplotypes from the HaplotypeSamples table
  --alignments         print one alignment record per haplotype fragment instead of the subgraph
  --block-size INT     bytes fetched per range request (default: 65536)
  --stats              print fetch statistics to stderr
`

interface Args {
  file: string
  sample?: string
  contig?: string
  haplotype: number
  offset?: number
  interval?: [number, number]
  nodes: number[]
  context: number
  limit?: number
  haplotypes: HaplotypeOutput
  cigar: boolean
  resolve: boolean
  alignments: boolean
  blockSize: number
  stats: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: '',
    haplotype: 0,
    nodes: [],
    context: 100,
    haplotypes: 'all',
    cigar: false,
    resolve: false,
    alignments: false,
    blockSize: 65536,
    stats: false,
  }
  const next = (i: number) => {
    const value = argv[i + 1]
    if (value === undefined) {
      throw new Error(`${argv[i]} needs a value`)
    }
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '--sample':
        args.sample = next(i++)
        break
      case '--contig':
        args.contig = next(i++)
        break
      case '--haplotype':
        args.haplotype = Number(next(i++))
        break
      case '-o':
      case '--offset':
        args.offset = Number(next(i++))
        break
      case '-i':
      case '--interval': {
        const [a, b] = next(i++).split('..')
        args.interval = [Number(a), Number(b)]
        break
      }
      case '-n':
      case '--node':
        args.nodes.push(Number(next(i++)))
        break
      case '--context':
        args.context = Number(next(i++))
        break
      case '--limit':
        args.limit = Number(next(i++))
        break
      case '--haplotypes':
        args.haplotypes = next(i++) as HaplotypeOutput
        break
      case '--cigar':
        args.cigar = true
        break
      case '--resolve':
        args.resolve = true
        break
      case '--alignments':
        args.alignments = true
        args.resolve = true
        break
      case '--block-size':
        args.blockSize = Number(next(i++))
        break
      case '--stats':
        args.stats = true
        break
      case '--format':
        next(i++)
        break
      case '-h':
      case '--help':
        process.stdout.write(USAGE)
        process.exit(0)
        break
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option ${arg}`)
        }
        args.file = arg
    }
  }
  if (!args.file) {
    throw new Error(USAGE)
  }
  return args
}

export async function main(argv: string[]) {
  const args = parseArgs(argv)
  const source = /^https?:\/\//.test(args.file)
    ? new RemoteFile(args.file)
    : new LocalFile(args.file)
  const db = await GBZBase.open(source, { blockSize: args.blockSize })
  const opts = {
    context: args.context,
    haplotypes: args.haplotypes,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  }
  const query = {
    contig: args.contig ?? '',
    haplotype: args.haplotype,
    ...(args.sample === undefined ? {} : { sample: args.sample }),
  }
  const subgraph =
    args.nodes.length > 0
      ? await subgraphAroundNodes(db, args.nodes, opts)
      : args.interval
        ? await subgraphInInterval(
            db,
            query,
            args.interval[0],
            args.interval[1],
            opts,
          )
        : args.offset !== undefined
          ? await subgraphAtOffset(db, query, args.offset, opts)
          : undefined
  if (!subgraph) {
    throw new Error(
      'Query type must be specified using --offset, --interval or --node',
    )
  }
  if (args.resolve) {
    await subgraph.identifyPaths()
  }
  const output = args.alignments
    ? subgraph.alignments().map(a => ({
        ...a,
        name: a.name ? formatPathName(a.name, a.name.fragment) : undefined,
        start: undefined,
      }))
    : subgraph.toJSON(args.cigar, {
        names: args.resolve ? 'resolved' : 'anonymous',
      })
  process.stdout.write(`${JSON.stringify(output)}\n`)
  if (args.stats) {
    const { fetches, bytesFetched } = db.sqlite.pager
    const {
      orderedAlignments,
      lcsAlignments,
      identificationSteps,
      identificationFetches,
    } = subgraph.stats
    process.stderr.write(
      `Subgraph contains ${subgraph.nodeCount} nodes and ${subgraph.pathCount} paths; ${fetches} fetches, ${bytesFetched} bytes; ${orderedAlignments} ordered + ${lcsAlignments} lcs alignments; identification ${identificationSteps} steps, ${identificationFetches} lookups\n`,
    )
  }
}
