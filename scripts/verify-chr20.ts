import { LocalFile } from 'generic-filehandle2'
import { GBZBase } from '../src/db.ts'
import { flipNode } from '../src/gbwt/node.ts'
import type { Pos } from '../src/gbwt/record.ts'
import { subgraphInInterval } from '../src/query.ts'

const file = process.argv[2] as string
const db = await GBZBase.open(new LocalFile(file))
const subgraph = await subgraphInInterval(db, { sample: 'GRCh38', contig: 'chr20' }, 30000000, 30010000, { context: 0 })
await subgraph.identifyPaths()
const alignments = subgraph.alignments()
const byPath = new Map<number, number>()
for (const a of alignments) {
  byPath.set(a.pathHandle as number, (byPath.get(a.pathHandle as number) ?? 0) + 1)
}
console.log('fragments', alignments.length, 'distinct paths', byPath.size)
for (const [handle, count] of [...byPath.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5)) {
  const p = await db.getPath(handle)
  console.log(' ', handle, `${p?.name.sample}#${p?.name.haplotype}#${p?.name.contig}`, count, 'fragments')
}
async function walkBack(pos: Pos) {
  let current = pos
  let bp = 0
  for (;;) {
    const flipped = await db.getRecord(flipNode(current.node))
    const pred = flipped?.gbwt().predecessorAt(current.offset)
    if (pred === undefined) {
      return { start: current, bp }
    }
    const record = await db.getRecord(pred)
    const offset = record?.gbwt().offsetTo(current)
    if (!record || offset === undefined) {
      throw new Error('broken back walk')
    }
    current = { node: pred, offset }
    bp += record.sequenceLen
  }
}
let ok = 0
let bad = 0
const sample = alignments.filter((_, i) => i % 37 === 0).slice(0, 25)
for (const a of sample) {
  const p = (await db.getPath(a.pathHandle as number))!
  const { start, bp } = await walkBack(a.start)
  const expectedStart = a.strand === '+' ? p.fwStart : p.revStart
  const length = (await db.haplotypeLength(a.pathHandle as number)) as number
  const local = { start: (a.hapStart as number) - p.name.fragment, end: (a.hapEnd as number) - p.name.fragment }
  const coordOk = (a.strand === '+' ? local.start : length - local.end) === bp
  const startOk = start.node === expectedStart.node && start.offset === expectedStart.offset
  if (coordOk && startOk) {
    ok += 1
  } else {
    bad += 1
    console.log('MISMATCH', a.pathHandle, a.strand, { start, expectedStart, bp, local, length })
  }
}
console.log('verified', ok, 'mismatched', bad)
