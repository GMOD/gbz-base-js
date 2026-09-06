import { LocalFile, RemoteFile } from 'generic-filehandle2'

import { GBZBase, Subgraph } from '../dist/index.js'

const [graph, index, contig, start, end, context] = process.argv.slice(2)
const open = file =>
  /^https?:\/\//.test(file) ? new RemoteFile(file) : new LocalFile(file)
const db = await GBZBase.open(open(graph), { haplotypeIndex: open(index) })
const subgraph = new Subgraph(db)
const t = label => {
  const now = performance.now()
  if (t.last !== undefined) {
    console.log(label, ((now - t.last) / 1000).toFixed(2), 's')
  }
  t.last = now
}
t()
const ref = await subgraph.pathPosition({
  sample: 'GRCh38',
  contig,
  haplotype: 0,
  fragment: Number(start),
})
t('pathPosition')
await subgraph.prefetchReferenceWalk(ref, Number(end) - Number(start))
t('prefetchReferenceWalk')
await subgraph.aroundInterval(
  ref.position,
  Number(end) - Number(start),
  Number(context),
)
t('aroundInterval')
await subgraph.extractSnarls('contained')
t('extractSnarls')
subgraph.extractPaths(ref, 'all')
t('extractPaths')
await subgraph.identifyPaths()
t('identifyPaths')
const alignments = subgraph.alignments()
t('alignments')
console.log(
  'nodes',
  subgraph.nodeCount,
  'paths',
  subgraph.pathCount,
  'records',
  alignments.length,
  'graph fetches',
  db.sqlite.pager.fetches,
)
