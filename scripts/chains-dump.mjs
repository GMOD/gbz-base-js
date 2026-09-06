import fs from 'node:fs'

import { LocalFile, RemoteFile } from 'generic-filehandle2'

import { GBZBase, subgraphInInterval } from '../dist/index.js'

const [graph, index, contig, start, end, context, out] = process.argv.slice(2)
if (out === undefined) {
  throw new Error(
    'usage: node scripts/chains-dump.mjs GRAPH INDEX CONTIG START END CONTEXT OUT.json',
  )
}
const open = file =>
  /^https?:\/\//.test(file) ? new RemoteFile(file) : new LocalFile(file)
const db = await GBZBase.open(open(graph), { haplotypeIndex: open(index) })
const t0 = performance.now()
const subgraph = await subgraphInInterval(
  db,
  { sample: 'GRCh38', contig },
  Number(start),
  Number(end),
  { context: Number(context), snarls: 'contained' },
)
const t1 = performance.now()
await subgraph.identifyPaths()
const t2 = performance.now()
const alignments = subgraph.alignments()
const t3 = performance.now()
fs.writeFileSync(
  out,
  JSON.stringify({
    window: { contig, start, end, context },
    ms: { subgraph: t1 - t0, identify: t2 - t1, align: t3 - t2 },
    nodes: subgraph.nodeCount,
    paths: subgraph.pathCount,
    records: alignments.length,
    unresolvedRecords: alignments.filter(a => !a.resolved).length,
    graphPager: {
      fetches: db.sqlite.pager.fetches,
      bytes: db.sqlite.pager.bytesFetched,
    },
    indexPager: {
      fetches: db.index.pager.fetches,
      bytes: db.index.pager.bytesFetched,
    },
    stats: subgraph.stats,
    alignments: alignments.map(a => ({
      resolved: a.resolved,
      pathHandle: a.resolved ? a.pathHandle : undefined,
      strand: a.strand,
      refStart: a.refStart,
      refEnd: a.refEnd,
      hapStart: a.resolved ? a.hapStart : undefined,
      hapEnd: a.resolved ? a.hapEnd : undefined,
    })),
  }),
)
console.log(out, 'done', ((t3 - t0) / 1000).toFixed(1), 's')
