// Times the four tutorial windows for a chosen set and for every haplotype:
//   node scripts/measure-windows.mjs graph.gbz.db companion.db [eight|all|both] [repeats]
// Each window is run on a fresh open after one 10 kb warm-up window
// elsewhere (after open: the b-tree interiors and the Paths table are cached,
// the window's own pages are not) and again on the same open (cached),
// through the same range queries the plugin makes.
import { LocalFile, RemoteFile } from 'generic-filehandle2'

import { GBZBase } from '../dist/index.js'

const [graph, index, which = 'both', repeats = '1'] = process.argv.slice(2)
const open = file =>
  /^https?:\/\//.test(file) ? new RemoteFile(file) : new LocalFile(file)
const eight = [
  'HG00097#1',
  'HG00099#1',
  'HG00128#1',
  'HG00133#1',
  'HG01109#1',
  'HG01123#1',
  'HG01960#1',
  'HG02055#1',
]
const keepEight = name => eight.includes(`${name.sample}#${name.haplotype}`)
const windows = [
  ['KIV-2 30 kb', 'chr6', 160616002, 160646753],
  ['KIV-2 130 kb', 'chr6', 160525000, 160655000],
  ['AMY1', 'chr1', 103690000, 103780000],
  ['MHC class II', 'chr6', 32510000, 32600000],
]
const sets = which === 'both' ? ['eight', 'all'] : [which]

async function openRetrying() {
  let attempt = 0
  for (;;) {
    try {
      return await GBZBase.open(open(graph), { haplotypeIndex: open(index) })
    } catch (error) {
      attempt += 1
      if (attempt >= 5) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
    }
  }
}

async function run(db, contig, start, end, set) {
  const t0 = performance.now()
  const graphFetches = db.sqlite.pager.fetches
  const graphBytes = db.sqlite.pager.bytesFetched
  const indexFetches = db.index.pager.fetches
  const indexBytes = db.index.pager.bytesFetched
  const subgraph = await db.getSubgraphForRange(
    `GRCh38#0#${contig}`,
    start,
    end,
    {
      context: 1000,
      snarls: 'contained',
      ...(set === 'eight' ? { keep: keepEight } : {}),
    },
  )
  const alignments = subgraph.alignments()
  const ms = performance.now() - t0
  const walk = subgraph.stats.anchorWalk
  return {
    ms,
    records: alignments.length,
    nodes: subgraph.nodeCount,
    graphRequests: db.sqlite.pager.fetches - graphFetches,
    graphMB: (db.sqlite.pager.bytesFetched - graphBytes) / 1e6,
    indexRequests: db.index.pager.fetches - indexFetches,
    indexMB: (db.index.pager.bytesFetched - indexBytes) / 1e6,
    route: walk
      ? walk.fallback
        ? 'anchored->sampled'
        : 'anchored'
      : 'sampled',
    phases: walk
      ? `ref ${walk.ms.reference.toFixed(0)} rows ${walk.ms.rows.toFixed(0)} walks ${walk.ms.walks.toFixed(0)} scan ${walk.ms.scan.toFixed(0)} sampled ${walk.ms.sampled.toFixed(0)}; ${walk.walks.filter(w => w.from === 'sample').length} from samples`
      : '',
    steps: walk ? walk.walks.reduce((n, w) => n + w.steps, 0) : undefined,
  }
}

const warmUp = ['chr6', 31500000, 31510000]

console.log(
  'window\tset\topen\ttime s\trecords\tnodes\tgraph req\tgraph MB\tindex req\tindex MB\troute\tphases ms',
)
for (const [label, contig, start, end] of windows) {
  for (const set of sets) {
    for (let r = 0; r < Number(repeats); r++) {
      const db = await openRetrying()
      await run(db, ...warmUp, set)
      for (const which of ['after open', 'cached']) {
        const x = await run(db, contig, start, end, set)
        console.log(
          [
            label,
            set,
            which,
            (x.ms / 1000).toFixed(2),
            x.records,
            x.nodes,
            x.graphRequests,
            x.graphMB.toFixed(2),
            x.indexRequests,
            x.indexMB.toFixed(2),
            x.route,
            x.phases,
          ].join('\t'),
        )
      }
    }
  }
}
