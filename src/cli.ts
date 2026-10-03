import { readFile } from 'node:fs/promises'

import { LocalFile, RemoteFile } from 'generic-filehandle2'

import { GBZBase } from './db.ts'
import { encodeNode } from './gbwt/node.ts'

import type { KeepStats } from './chosenPaths.ts'
import type { PathName } from './pathName.ts'
import type { NodeHaplotypeOutput } from './query.ts'
import type {
  ChainEnd,
  HaplotypeAlignment,
  HaplotypeOutput,
  IdentificationStats,
  PairAlignment,
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
  --against NAME       print PAF of every other named walk against this sample#haplotype, bases compared
  --stack A,B,C        print PAF of each sample#haplotype against the next one in the list, bases compared
  --no-bases           for --against or --stack, write the bases between two shared stretches as an insertion and a deletion
  --max-gap INT        cap the bases a PAF record skips on nodes only one walk visits (default: none)
  --contig-lengths F   chrom.sizes or .fai giving PAF columns 2 and 7, keyed by contig or sample#haplotype#contig
  --haplotype-index F  haplotype index written by gbz-haplotype-index
  --overview BP        print the haplotype index's overview of --interval at the coarsest level whose bins are at most BP, instead of the subgraph
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
  against?: string
  stack?: string[]
  maxGap?: number
  bases: boolean
  contigLengths?: string
  blockSize: number
  overview?: number
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

function wholeNumber(flag: string, text: string, min = 0) {
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min) {
    throw new Error(
      `${flag} needs a whole number${min > 0 ? ` of at least ${min}` : ''}, not ${text}`,
    )
  }
  return value
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
    bases: true,
    blockSize: 65536,
    stats: false,
  }
  const next = (i: number) => {
    const value = argv[i + 1]
    if (value === undefined || /^-(-|[a-zA-Z]$)/.test(value)) {
      throw new Error(`${argv[i]} needs a value`)
    }
    return value
  }
  const number = (i: number, min = 0) => wholeNumber(argv[i]!, next(i), min)
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
        args.haplotype = number(i++)
        break
      case '-o':
      case '--offset':
        args.offset = number(i++)
        break
      case '-i':
      case '--interval': {
        const text = next(i++)
        const [a, b, extra] = text.split('..')
        if (a === undefined || b === undefined || extra !== undefined) {
          throw new Error(`--interval needs A..B, not ${text}`)
        }
        args.interval = [wholeNumber(arg, a), wholeNumber(arg, b)]
        break
      }
      case '-n':
      case '--node':
        args.nodes.push(number(i++, 1))
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
        args.context = number(i++)
        break
      case '--snarls':
        args.snarls =
          args.snarls === 'overlapping' ? 'overlapping' : 'contained'
        break
      case '--extend-snarls':
        args.snarls = 'overlapping'
        break
      case '--limit':
        args.limit = number(i++, 1)
        break
      case '--haplotypes': {
        const output = next(i++)
        if (!isHaplotypeOutput(output)) {
          throw new Error(
            `--haplotypes must be one of ${HAPLOTYPE_OUTPUTS.join(', ')}`,
          )
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
      case '--against':
        args.against = next(i++)
        args.resolve = true
        break
      case '--stack':
        args.stack = next(i++).split(',')
        args.resolve = true
        break
      case '--contig-lengths':
        args.contigLengths = next(i++)
        break
      case '--max-gap':
        args.maxGap = number(i++)
        break
      case '--no-bases':
        args.bases = false
        break
      case '--overview':
        args.overview = number(i++, 1)
        break
      case '--block-size':
        args.blockSize = number(i++, 1)
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
    `  haplotype index seeks ${stats.companionSeeks} (${stats.companionMisses} misses); graph record lookups ${stats.graphLookups}, ${stats.graphFetches} fetched`,
    `  fragment length max ${maxLen}, ${overBound} over the ${bound} bp bound`,
  ].join('\n')
}

function keepReport(stats: KeepStats) {
  const sources = Object.entries(stats.sources)
    .filter(([, n]) => n > 0)
    .map(([source, n]) => `${source} ${n}`)
    .join(', ')
  const walks = Object.entries(stats.walks)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(', ')
  const scanned = stats.scans.reduce((n, [a, b]) => n + ((b - a) >> 1) + 1, 0)
  return [
    stats.fallback === undefined
      ? `keep: ${stats.pieces} pieces (${sources}) for ${stats.chosenPaths} chosen paths`
      : `keep: identified every walk, because ${stats.fallback}`,
    `  anchor spacing ${stats.spacing ?? 'none'}${stats.anchors ? `, anchors at ${stats.anchors[0]} and ${stats.anchors[1]}` : ''}; ${stats.scans.length} index scans over ${scanned} nodes for ${stats.scanRows} samples`,
    `  walks: ${walks || 'none'}; ${stats.graphFetches} graph records read outside the subgraph; twins ${stats.twins.found} of ${stats.twins.tried}`,
    ...(stats.strays
      ? [
          `  stray rows: ${stats.strays.rows} read in ${stats.strays.bins} bins, ${stats.strays.walked} of chosen paths walked; walks went ${stats.strays.outsideBp} bp outside the subgraph`,
        ]
      : []),
    `  ms: scan ${stats.ms.scan.toFixed(0)}, walks ${stats.ms.walks.toFixed(0)}, check ${stats.ms.check.toFixed(0)}, twins ${stats.ms.twins.toFixed(0)}`,
  ].join('\n')
}

function keepPredicate(keep: string[]) {
  const wanted = keep.map(text => {
    const [sample, haplotype, extra] = text.split('#')
    if (
      !sample ||
      extra !== undefined ||
      (haplotype !== undefined && !/^\d+$/.test(haplotype))
    ) {
      throw new Error(`Expected sample or sample#haplotype, got ${text}`)
    }
    return {
      sample,
      haplotype: haplotype === undefined ? undefined : Number(haplotype),
    }
  })
  return (name: PathName) =>
    wanted.some(
      ({ sample, haplotype }) =>
        sample === name.sample &&
        (haplotype === undefined || haplotype === name.haplotype),
    )
}

function haplotypeRef(text: string) {
  const [sample, haplotype] = text.split('#')
  if (!sample || !/^\d+$/.test(haplotype ?? '')) {
    throw new Error(`Expected sample#haplotype, got ${text}`)
  }
  return { sample, haplotype: Number(haplotype) }
}

function contigLengths(text: string) {
  return new Map(
    text
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .filter(fields => fields.length >= 2)
      .map(([name, length]) => [
        name!,
        wholeNumber(`--contig-lengths ${name}`, length!),
      ]),
  )
}

// A window holds no contig lengths. Without --contig-lengths columns 2 and 7
// are the record's own end, the least the contig can be.
function pafLines(alignments: PairAlignment[], lengths: Map<string, number>) {
  const named = (name: PathName, end: number) => {
    const full = `${name.sample}#${name.haplotype}#${name.contig}`
    return [full, lengths.get(full) ?? lengths.get(name.contig) ?? end]
  }
  return alignments
    .map(a =>
      [
        ...named(a.query, a.queryEnd),
        a.queryStart,
        a.queryEnd,
        a.strand,
        ...named(a.target, a.targetEnd),
        a.targetStart,
        a.targetEnd,
        a.matches,
        a.columns,
        255,
        `ns:i:${a.sharedBases}`,
        `cg:Z:${a.cigar}\n`,
      ].join('\t'),
    )
    .join('')
}

function alignmentRecord(alignment: HaplotypeAlignment) {
  const { start, ...rest } = alignment
  return rest.resolved ? { ...rest, name: rest.label, label: undefined } : rest
}

export async function main(argv: string[]) {
  const args = parseArgs(argv)
  const open = (file: string) =>
    /^https?:\/\//.test(file) ? new RemoteFile(file) : new LocalFile(file)
  const db = await GBZBase.open({
    source: open(args.file),
    haplotypeIndex:
      args.haplotypeIndex === undefined ? undefined : open(args.haplotypeIndex),
    blockSize: args.blockSize,
  })
  const opts = {
    context: args.context,
    haplotypes: args.haplotypes,
    snarls: args.snarls,
    limit: args.limit,
  }
  const path = {
    contig: args.contig ?? '',
    haplotype: args.haplotype,
    sample: args.sample,
  }
  if (args.against !== undefined && args.stack !== undefined) {
    throw new Error('--against and --stack cannot be combined')
  }
  const kept = args.stack ?? [
    ...args.keep,
    ...(args.against === undefined || args.keep.length === 0
      ? []
      : [args.against]),
  ]
  if (args.overview !== undefined) {
    if (!args.interval) {
      throw new Error('--overview needs --interval')
    }
    const overview = await db.haplotypeOverview({
      path,
      start: args.interval[0],
      end: args.interval[1],
      bpPerPixel: args.overview,
    })
    if (!overview) {
      throw new Error(
        'the haplotype index has no overview tables; rebuild it with gbz-haplotype-index 0.3',
      )
    }
    process.stdout.write(
      `${JSON.stringify({ ...overview, cells: Array.from(overview.cells) })}\n`,
    )
    if (args.stats) {
      const { graph, haplotypeIndex } = db.fetchStats()
      process.stderr.write(
        `Overview of ${overview.bins.length} bins of ${overview.bin} bp at level ${overview.level} for ${overview.haplotypes.length} haplotypes; ${graph.fetches} graph fetches, ${graph.bytesFetched} bytes; ${haplotypeIndex?.fetches} index fetches, ${haplotypeIndex?.bytesFetched} bytes\n`,
      )
    }
    return
  }
  const keep = kept.length > 0 ? keepPredicate(kept) : undefined
  const anchoredQuery = keep !== undefined && args.interval !== undefined
  // Walks merge after the haplotypes to keep are chosen, since a merged
  // record carries the name of one of its walks.
  const mergeAfterKeep =
    keep !== undefined && !anchoredQuery && args.haplotypes === 'distinct'
  if (mergeAfterKeep) {
    opts.haplotypes = 'all'
  }
  const subgraph = args.between
    ? await db.subgraphBetween({
        ...opts,
        haplotypes: opts.haplotypes as NodeHaplotypeOutput,
        startHandle: args.between[0],
        endHandle: args.between[1],
      })
    : args.nodes.length > 0
      ? await db.subgraphAroundNodes({
          ...opts,
          haplotypes: opts.haplotypes as NodeHaplotypeOutput,
          nodeIds: args.nodes,
        })
      : args.interval
        ? await db.subgraphInInterval({
            ...opts,
            path,
            start: args.interval[0],
            end: args.interval[1],
            keep,
          })
        : args.offset !== undefined
          ? await db.subgraphAtOffset({ ...opts, path, offset: args.offset })
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
  if (mergeAfterKeep) {
    subgraph.mergeDistinct()
  }
  const names = args.resolve ? 'resolved' : 'anonymous'
  const pairs = args.stack
    ? args.stack.slice(1).map((target, i) => ({
        query: haplotypeRef(args.stack![i]!),
        target: haplotypeRef(target),
      }))
    : args.against === undefined
      ? undefined
      : [{ target: haplotypeRef(args.against) }]
  if (pairs === undefined) {
    const output = args.alignments
      ? subgraph.alignments().map(alignmentRecord)
      : subgraph.toSubgraphJson({ cigar: args.cigar, names })
    process.stdout.write(
      args.format === 'gfa' && !args.alignments
        ? await subgraph.toGFA({ cigar: args.cigar, names })
        : `${JSON.stringify(output)}\n`,
    )
  } else {
    const lengths =
      args.contigLengths === undefined
        ? new Map<string, number>()
        : contigLengths(await readFile(args.contigLengths, 'utf8'))
    process.stdout.write(
      pafLines(
        pairs.flatMap(pair =>
          subgraph.pairAlignments({
            ...pair,
            ...(args.maxGap === undefined ? {} : { maxGap: args.maxGap }),
            bases: args.bases,
          }),
        ),
        lengths,
      ),
    )
  }
  if (args.stats) {
    const { graph, haplotypeIndex } = db.fetchStats()
    const { fetches, bytesFetched } = graph
    const index = haplotypeIndex
      ? ` (haplotype index: ${haplotypeIndex.fetches} fetches, ${haplotypeIndex.bytesFetched} bytes)`
      : ''
    const {
      orderedAlignments,
      lcsAlignments,
      identificationSteps,
      identificationFetches,
    } = subgraph.stats
    process.stderr.write(
      `Subgraph contains ${subgraph.nodeCount} nodes and ${subgraph.pathCount} paths; ${fetches} fetches, ${bytesFetched} bytes${index}; ${orderedAlignments} ordered + ${lcsAlignments} lcs alignments; identification ${identificationSteps} steps, ${identificationFetches} lookups\n`,
    )
    if (args.resolve && !anchoredQuery) {
      process.stderr.write(
        `${identificationReport(subgraph.stats.identification)}\n`,
      )
    }
    const { keep: keepStats } = subgraph.stats
    if (keepStats) {
      process.stderr.write(`${keepReport(keepStats)}\n`)
    }
  }
}

export function run(argv: string[]) {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0)
    }
    throw error
  })
  main(argv).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(1)
  })
}
