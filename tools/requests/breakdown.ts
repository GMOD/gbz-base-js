// One cold query with every request logged with the b-tree operation that
// caused it (from the async stack). GRAPH and INDEX name the files.
//
//   node tools/requests/breakdown.ts 'GRCh38#0#chr22' 20000000 20000300 keep1
import { RemoteFile } from 'generic-filehandle2'

import { GBZBase } from '../../src/db.ts'
import { Pager } from '../../src/sqlite/pager.ts'

const GRAPH =
  process.env.GRAPH ??
  'https://s3-us-west-2.amazonaws.com/human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/v2.1/hprc-v2.1-mc-grch38/hprc-v2.1-mc-grch38.gbz.db'
const INDEX =
  process.env.INDEX ??
  'https://jbrowse.org/demos/hprc/hprc-v2.1-mc-grch38.haplotype-index.anchored.db'
const [contig, startText, endText, route] = process.argv.slice(2)
const start = Number(startText)
const end = Number(endText)

const log: string[] = []
const tagOf = (file: string) => (file === INDEX ? 'INDEX' : 'GRAPH')
const pagerProto = Pager.prototype as unknown as {
  read: (length: number, at: number) => Promise<Uint8Array>
}
const originalRead = pagerProto.read
pagerProto.read = function (this: { source: { url?: string } }, length, at) {
  const frames = (new Error().stack ?? '')
    .split('\n')
    .slice(2)
    .map(l =>
      l
        .trim()
        .replace(/^at (async )?/, '')
        .replace(/ \(.*$/, ''),
    )
    .filter(
      f =>
        !/^Pager\.|^BTree\.pageAt|^new Promise|^Array\.|^Promise\.|^process\./.test(
          f,
        ),
    )
    .slice(0, 4)
  log.push(
    `${tagOf(this.source.url ?? '')} block ${Math.floor(at / 65536)} len ${length / 65536} <- ${frames.join(' < ')}`,
  )
  return originalRead.call(this, length, at)
}
const remote = (url: string) => {
  const file = new RemoteFile(url) as RemoteFile & { url: string }
  file.url = url
  return file
}
const db = await GBZBase.open({
  source: remote(GRAPH),
  haplotypeIndex: remote(INDEX),
})
log.push('--- open done')
const paths = await db.paths()
log.push(`--- paths done (${paths.length})`)
const keep =
  route === 'keep1'
    ? (n: { sample: string }) => n.sample === 'HG002'
    : undefined
const [sample, haplotype, name] = contig!.split('#')
if (process.env.OVERVIEW) {
  const overview = await db.haplotypeOverview({
    path: { sample: sample!, haplotype: Number(haplotype), contig: name! },
    start,
    end,
    bpPerPixel: Number(process.env.OVERVIEW),
  })
  log.push(`--- overview done (${overview?.bins.length} bins)`)
  console.log(log.join('\n'))
  console.log(JSON.stringify(db.fetchStats()))
  process.exit(0)
}
const subgraphs = await db.getSubgraphs({
  path: { sample: sample!, haplotype: Number(haplotype), contig: name! },
  start,
  end,
  context: 1000,
  snarls: 'contained',
  haplotypes: 'all',
  keep,
})
log.push('--- extract done')
if (!keep) {
  for (const s of subgraphs) {
    await s.identifyPaths()
  }
  log.push('--- identify done')
}
const stats = db.fetchStats()
console.log(log.join('\n'))
console.log(
  JSON.stringify({
    graph: stats.graph,
    index: stats.haplotypeIndex,
    nodes: subgraphs.map(s => s.stats.nodes),
    keep: subgraphs.map(s => s.stats.keep),
  }),
)
