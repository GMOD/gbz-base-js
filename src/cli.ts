import { LocalFile, RemoteFile } from 'generic-filehandle2'

import { GBZBase } from './db.ts'
import { encodeNode } from './gbwt/node.ts'
import {
  subgraphAroundNodes,
  subgraphAtOffset,
  subgraphBetween,
  subgraphForHaplotypes,
  subgraphInInterval,
} from './query.ts'

import type { PathName } from './pathName.ts'
import type {
  AnchorWalkEnd,
  AnchorWalkStats,
  ChainEnd,
  HaplotypeAlignment,
  HaplotypeOutput,
  IdentificationStats,
  SnarlOutput,
} from './subgraph.ts'

const USAGE = `Usage: gbz-base-query [options] graph.gbz.db

  --sample STR         sample name (default: generic path)
  --contig STR         contig name (required for --offset and --interval)
  --haplotype INT      haplotype number (default: 0)
  -o, --offset INT     sequence offset
  -i, --interval A..B  half-open sequence interval
  -n, --node INT       node identifier (may repeat)
  -b, --between A:B    subgraph between two chain boundary handles, each INT[+-]
  --context INT        context length in bp (default: 100)
  --snarls             extend the subgraph with contained top-level snarls
  --extend-snarls      extend the subgraph with overlapping top-level snarls
  --limit INT          safety limit for the number of nodes
  --haplotypes SEL     all, distinct, reference-only or none (default: all)
  --cigar              output CIGAR strings for the haplotypes
  --format FMT         json (default) or gfa
  --resolve            name haplotypes from the HaplotypeSamples table
  --keep NAME          keep only the walks of this sample or sample#haplotype (may repeat; implies --resolve)
  --alignments         print one alignment record per haplotype instead of the subgraph
  --haplotype-index F  companion database written by gbz-haplotype-index --output
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
  between?: [number, number]
  context: number
  snarls: SnarlOutput
  limit?: number
  haplotypes: HaplotypeOutput
  cigar: boolean
  format: 'json' | 'gfa'
  resolve: boolean
  keep: string[]
  alignments: boolean
  blockSize: number
  haplotypeIndex?: string
  stats: boolean
}

const HAPLOTYPE_OUTPUTS = [
  'all',
  'distinct',
  'reference-only',
  'none',
] as const satisfies readonly HaplotypeOutput[]

function isHaplotypeOutput(text: string): text is HaplotypeOutput {
  return HAPLOTYPE_OUTPUTS.some(output => output === text)
}

function parseHandle(text: string) {
  const orientation = text.endsWith('-') ? 'reverse' : 'forward'
  const digits = /[+-]$/.test(text) ? text.slice(0, -1) : text
  if (!/^\d+$/.test(digits)) {
    throw new Error(`Failed to parse oriented node ${text}`)
  }
  return encodeNode(Number(digits), orientation)
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    file: '',
    haplotype: 0,
    nodes: [],
    context: 100,
    snarls: 'none',
    haplotypes: 'all',
    cigar: false,
    format: 'json',
    resolve: false,
    keep: [],
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
      case '-b':
      case '--between': {
        const [a, b, extra] = next(i++).split(':')
        if (a === undefined || b === undefined || extra !== undefined) {
          throw new Error(`--between needs two oriented nodes, like 14+:17-`)
        }
        args.between = [parseHandle(a), parseHandle(b)]
        break
      }
      case '--context':
        args.context = Number(next(i++))
        break
      case '--snarls':
        args.snarls =
          args.snarls === 'overlapping' ? 'overlapping' : 'contained'
        break
      case '--extend-snarls':
        args.snarls = 'overlapping'
        break
      case '--limit':
        args.limit = Number(next(i++))
        break
      case '--haplotypes': {
        const output = next(i++)
        if (!isHaplotypeOutput(output)) {
          throw new Error(`--haplotypes must be one of `)
        }
        args.haplotypes = output
        break
      }
      case '--cigar':
        args.cigar = true
        break
      case '--resolve':
        args.resolve = true
        break
      case '--keep':
        args.keep.push(next(i++))
        args.resolve = true
        break
      case '--alignments':
        args.alignments = true
        args.resolve = true
        break
      case '--block-size':
        args.blockSize = Number(next(i++))
        break
      case '--haplotype-index':
        args.haplotypeIndex = next(i++)
        break
      case '--stats':
        args.stats = true
        break
      case '--format': {
        const format = next(i++)
        if (format !== 'json' && format !== 'gfa') {
          throw new Error(`Unknown output format ${format}`)
        }
        args.format = format
        break
      }
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

const CHAIN_ENDS: ChainEnd[] = [
  'in-fragment sample',
  'identified sibling',
  'out-of-window sample',
  'bound',
  'endmarker',
  'cycle',
]

function identificationReport(stats: IdentificationStats) {
  const { chains, fragmentLengths, interval, scans } = stats
  const resolved = chains.filter(c => c.pathHandle !== undefined)
  const haplotypes = new Set(resolved.map(c => c.pathHandle)).size
  const unresolved = chains.filter(c => c.pathHandle === undefined)
  const unresolvedFragments = unresolved.reduce((n, c) => n + c.fragments, 0)
  const sum = (pick: (c: (typeof chains)[number]) => number) =>
    chains.reduce((n, c) => n + pick(c), 0)
  const ends = CHAIN_ENDS.map(
    end => `${end} ${chains.filter(c => c.end === end).length}`,
  ).join(', ')
  const bound = 4 * interval
  const overBound = fragmentLengths.filter(len => len > bound).length
  const maxLen = fragmentLengths.reduce((a, b) => Math.max(a, b), 0)
  const scannedNodes = scans.reduce((n, [a, b]) => n + ((b - a) >> 1) + 1, 0)
  const scanned = `${scans.length} index scans over ${scannedNodes} nodes for ${stats.windowSamples} samples`
  return [
    `identification: interval ${interval}; ${scanned}`,
    `  ${fragmentLengths.length} fragments in ${chains.length} chains for ${haplotypes} haplotypes (${resolved.length - haplotypes} chains beyond one per haplotype; ${unresolved.length} chains / ${unresolvedFragments} fragments unresolved)`,
    `  chain ends: ${ends}`,
    `  sibling links ${sum(c => c.fragments - 1)}; out-of-window steps ${sum(c => c.steps)}, ${sum(c => c.reentries)} re-entering the subgraph, ${sum(c => c.twinLandings)} on a discarded twin's start`,
    `  companion seeks ${stats.companionSeeks} (${stats.companionMisses} misses); graph record lookups ${stats.graphLookups}, ${stats.graphFetches} fetched`,
    `  fragment length max ${maxLen}, ${overBound} over the ${bound} bp bound`,
  ].join('\n')
}

const ANCHOR_WALK_ENDS: AnchorWalkEnd[] = [
  'through the window',
  'before the window',
  'past the window',
  'ended in the window',
  'bound',
  'cycle',
]

function anchorWalkReport(stats: AnchorWalkStats) {
  const ends = ANCHOR_WALK_ENDS.map(
    end => `${end} ${stats.walks.filter(w => w.end === end).length}`,
  ).join(', ')
  const steps = stats.walks.reduce((n, w) => n + w.steps, 0)
  const pieces = stats.walks.reduce((n, w) => n + w.pieces, 0)
  const scanned = stats.scans.reduce((n, [a, b]) => n + ((b - a) >> 1) + 1, 0)
  return [
    `anchored walk: spacing ${stats.spacing}; anchor for multiple ${stats.anchorOffset} at reference offset ${stats.anchorNodeOffset}, node ${stats.anchorHandle >> 1}, ${stats.rows} rows; reference ${stats.referenceSteps} steps`,
    `  ${stats.walks.length} walks (${stats.walks.filter(w => w.from === 'sample').length} from a sample in the window), ${steps} steps in ${pieces} monotone pieces, ${stats.graphFetches} graph record lookups outside the subgraph`,
    `  walk ends: ${ends}`,
    `  completeness: ${stats.scans.length} index scans over ${scanned} nodes for ${stats.scanRows} samples`,
    `  ms: reference ${stats.ms.reference.toFixed(0)}, rows ${stats.ms.rows.toFixed(0)}, walks ${stats.ms.walks.toFixed(0)}, scan ${stats.ms.scan.toFixed(0)}, sampled ${stats.ms.sampled.toFixed(0)}`,
    `  ${stats.fallback ?? 'no fallback'}`,
  ].join('\n')
}

function keepPredicate(keep: string[]) {
  const wanted = keep.map(text => text.split('#'))
  return (name: PathName) =>
    wanted.some(
      ([sample, haplotype]) =>
        sample === name.sample &&
        (haplotype === undefined || Number(haplotype) === name.haplotype),
    )
}

function alignmentRecord(alignment: HaplotypeAlignment) {
  const { start, ...rest } = alignment
  return rest.resolved ? { ...rest, name: rest.label, label: undefined } : rest
}

export async function main(argv: string[]) {
  const args = parseArgs(argv)
  const open = (file: string) =>
    /^https?:\/\//.test(file) ? new RemoteFile(file) : new LocalFile(file)
  const db = await GBZBase.open(open(args.file), {
    blockSize: args.blockSize,
    ...(args.haplotypeIndex === undefined
      ? {}
      : { haplotypeIndex: open(args.haplotypeIndex) }),
  })
  const opts = {
    context: args.context,
    haplotypes: args.haplotypes,
    snarls: args.snarls,
    ...(args.limit === undefined ? {} : { limit: args.limit }),
  }
  const query = {
    contig: args.contig ?? '',
    haplotype: args.haplotype,
    ...(args.sample === undefined ? {} : { sample: args.sample }),
  }
  const keep = args.keep.length > 0 ? keepPredicate(args.keep) : undefined
  const anchoredQuery = keep !== undefined && args.interval !== undefined
  const subgraph = args.between
    ? await subgraphBetween(db, args.between[0], args.between[1], opts)
    : args.nodes.length > 0
      ? await subgraphAroundNodes(db, args.nodes, opts)
      : args.interval
        ? keep === undefined
          ? await subgraphInInterval(
              db,
              query,
              args.interval[0],
              args.interval[1],
              opts,
            )
          : await subgraphForHaplotypes(
              db,
              query,
              args.interval[0],
              args.interval[1],
              { ...opts, keep },
            )
        : args.offset !== undefined
          ? await subgraphAtOffset(db, query, args.offset, opts)
          : undefined
  if (!subgraph) {
    throw new Error(
      'Query type must be specified using --offset, --interval, --node or --between',
    )
  }
  if (args.resolve && !anchoredQuery) {
    await subgraph.identifyPaths()
  }
  if (keep !== undefined && !anchoredQuery) {
    subgraph.keepHaplotypes(keep)
  }
  const names = args.resolve ? 'resolved' : 'anonymous'
  const output = args.alignments
    ? subgraph.alignments().map(alignmentRecord)
    : subgraph.toSubgraphJson({ cigar: args.cigar, names })
  process.stdout.write(
    args.format === 'gfa' && !args.alignments
      ? await subgraph.toGFA({ cigar: args.cigar, names })
      : `${JSON.stringify(output)}\n`,
  )
  if (args.stats) {
    const { fetches, bytesFetched } = db.sqlite.pager
    const index =
      db.index === db.sqlite
        ? ''
        : ` (haplotype index: ${db.index.pager.fetches} fetches, ${db.index.pager.bytesFetched} bytes)`
    const {
      orderedAlignments,
      lcsAlignments,
      identificationSteps,
      identificationFetches,
    } = subgraph.stats
    process.stderr.write(
      `Subgraph contains ${subgraph.nodeCount} nodes and ${subgraph.pathCount} paths; ${fetches} fetches, ${bytesFetched} bytes${index}; ${orderedAlignments} ordered + ${lcsAlignments} lcs alignments; identification ${identificationSteps} steps, ${identificationFetches} lookups\n`,
    )
    if (args.resolve) {
      process.stderr.write(
        `${identificationReport(subgraph.stats.identification)}\n`,
      )
    }
    const { anchorWalk } = subgraph.stats
    if (anchorWalk) {
      process.stderr.write(`${anchorWalkReport(anchorWalk)}\n`)
    }
  }
}
