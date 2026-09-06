import { LocalFile } from 'generic-filehandle2'
import { GBZBase } from '../src/db.ts'
import { Subgraph } from '../src/subgraph.ts'

const db = await GBZBase.open(
  new LocalFile('/Users/colin/src/gbz-base-js/test/data/micb-kir3dl1.gbz.db'),
)
const subgraph = new Subgraph(db)
console.time('pathPosition')
const ref = await subgraph.pathPosition({
  sample: 'GRCh38',
  contig: 'chr19',
  haplotype: 0,
  fragment: 54816500,
})
console.timeEnd('pathPosition')
console.time('aroundInterval')
await subgraph.aroundInterval(ref.position, 5500, 0)
console.timeEnd('aroundInterval')
console.time('extractPaths')
subgraph.extractPaths(ref, 'all')
console.timeEnd('extractPaths')
console.log('nodes', subgraph.nodeCount, 'paths', subgraph.pathCount)
console.time('toJSON no cigar')
subgraph.toJSON(false)
console.timeEnd('toJSON no cigar')
console.time('toJSON cigar')
subgraph.toJSON(true)
console.timeEnd('toJSON cigar')
console.log(
  'fetches',
  db.sqlite.pager.fetches,
  'bytes',
  db.sqlite.pager.bytesFetched,
)
