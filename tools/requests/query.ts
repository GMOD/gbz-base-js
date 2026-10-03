// One cold window query, the way the JBrowse GraphTrack cuts it, with every
// HTTP request counted per file and per phase. Prints one JSON line.
//
//   node tools/requests/query.ts '{"contig":"GRCh38#0#chr6","start":1,"end":2,
//     "route":"sampled|keep1|keep8","prefetch":true, ...}'
//
// GRAPH and INDEX override the hosted HPRC v2.1 URLs; CONTEXT, SNARLS, LIMIT
// (a number or none), BLOCK_SIZE and MAX_BLOCKS override the plugin's defaults. Each
// finished phase and a 15 s heartbeat go to stderr, so a query that is killed
// still shows how far it got.
import { RemoteFile } from 'generic-filehandle2'

import { GBZBase } from '../../src/db.ts'
import { Pager } from '../../src/sqlite/pager.ts'
import { BTree } from '../../src/sqlite/btree.ts'

import type { PathName } from '../../src/pathName.ts'
import type { SnarlOutput } from '../../src/subgraph.ts'

const GRAPH =
  process.env.GRAPH ??
  'https://s3-us-west-2.amazonaws.com/human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/v2.1/hprc-v2.1-mc-grch38/hprc-v2.1-mc-grch38.gbz.db'
const INDEX =
  process.env.INDEX ??
  'https://jbrowse.org/demos/hprc/hprc-v2.1-mc-grch38.haplotype-index.anchored.db'

const EIGHT = [
  'HG00097#1',
  'HG00099#1',
  'HG00128#1',
  'HG00133#1',
  'HG01109#1',
  'HG01123#1',
  'HG01960#1',
  'HG02055#1',
]
const KEEP: Record<string, ((name: PathName) => boolean) | undefined> = {
  sampled: undefined,
  keep1: name => name.sample === 'HG002',
  keep8: name => EIGHT.includes(`${name.sample}#${name.haplotype}`),
}

interface Query {
  contig: string
  start: number
  end: number
  route: keyof typeof KEEP
  prefetch: boolean
  [extra: string]: unknown
}
const query = JSON.parse(process.argv[2]!) as Query

if (!query.prefetch) {
  BTree.prototype.prefetchRowidRanges = () => Promise.resolve(true)
  Pager.prototype.prefetchLeading = () => 1
}

interface Counter {
  requests: number
  bytes: number
}
const counters = new Map<string, Counter>([
  [GRAPH, { requests: 0, bytes: 0 }],
  [INDEX, { requests: 0, bytes: 0 }],
])
const countingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  const counter = counters.get(String(input))
  if (counter) {
    counter.requests += 1
    counter.bytes += Number(response.headers.get('content-length') ?? 0)
  }
  return response
}
const remote = (url: string) => new RemoteFile(url, { fetch: countingFetch })

const snapshot = () => {
  const graph = counters.get(GRAPH)!
  const index = counters.get(INDEX)!
  return {
    graphRequests: graph.requests,
    graphBytes: graph.bytes,
    indexRequests: index.requests,
    indexBytes: index.bytes,
  }
}
type Snapshot = ReturnType<typeof snapshot>
const phases: Record<string, Snapshot & { ms: number }> = {}
let last = snapshot()
let lastT = performance.now()
const mark = (phase: string) => {
  const now = snapshot()
  const t = performance.now()
  phases[phase] = {
    ms: Math.round(t - lastT),
    graphRequests: now.graphRequests - last.graphRequests,
    graphBytes: now.graphBytes - last.graphBytes,
    indexRequests: now.indexRequests - last.indexRequests,
    indexBytes: now.indexBytes - last.indexBytes,
  }
  last = now
  lastT = t
  process.stderr.write(`PHASE ${JSON.stringify({ phase, ...phases[phase] })}\n`)
}
setInterval(() => {
  process.stderr.write(
    `PROGRESS ${JSON.stringify({ ms: Math.round(performance.now() - lastT), ...snapshot() })}\n`,
  )
}, 15_000).unref()

const settings = {
  context: Number(process.env.CONTEXT ?? 1000),
  snarls: (process.env.SNARLS ?? 'contained') as SnarlOutput,
  limit: process.env.LIMIT === 'none' ? undefined : Number(process.env.LIMIT ?? 100_000),
  blockSize: Number(process.env.BLOCK_SIZE ?? 65536),
  maxBlocks: Number(process.env.MAX_BLOCKS ?? 256),
}
const keep = KEEP[query.route]
const t0 = performance.now()
const result: Record<string, unknown> = { ...query, ...settings }
try {
  const db = await GBZBase.open({
    source: remote(GRAPH),
    haplotypeIndex: remote(INDEX),
    blockSize: settings.blockSize,
    maxBlocks: settings.maxBlocks,
  })
  mark('open')
  await db.paths()
  const fragments = await db.getPathFragments({
    path: query.contig,
    start: query.start,
    end: query.end,
  })
  mark('paths')
  const subgraphs = []
  for (const fragment of fragments) {
    const { sample, contig, haplotype } = fragment.path.name
    subgraphs.push(
      await db.subgraphInInterval({
        context: settings.context,
        snarls: settings.snarls,
        limit: settings.limit,
        haplotypes: 'all',
        path: { sample, contig, haplotype },
        start: Math.max(query.start, fragment.start),
        end: Math.min(query.end, fragment.end),
        keep,
      }),
    )
  }
  mark('extract')
  if (keep === undefined) {
    for (const subgraph of subgraphs) {
      await subgraph.identifyPaths()
    }
  }
  mark('identify')
  let gfaBytes = 0
  for (const subgraph of subgraphs) {
    gfaBytes += (await subgraph.toGFA()).length
  }
  mark('gfa')
  const pager = db.fetchStats()
  const first = subgraphs[0]
  const identification = first?.stats.identification
  const keepStats = first?.stats.keep
  Object.assign(result, {
    ok: true,
    fragments: fragments.length,
    nodes: subgraphs.reduce((n, s) => n + s.nodeCount, 0),
    paths: subgraphs.reduce((n, s) => n + s.pathCount, 0),
    gfaBytes,
    pagerGraphFetches: pager.graph.fetches,
    pagerIndexFetches: pager.haplotypeIndex?.fetches ?? 0,
    companionSeeks: identification?.companionSeeks ?? 0,
    graphLookups: identification?.graphLookups ?? 0,
    keepFallback: keepStats?.fallback ?? null,
    keepPieces: keepStats?.pieces ?? null,
    keepMs: keepStats?.ms ?? null,
  })
} catch (error) {
  result.ok = false
  result.error = error instanceof Error ? error.message : String(error)
}
Object.assign(result, snapshot(), {
  totalMs: Math.round(performance.now() - t0),
  phases,
})
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exit(0)
