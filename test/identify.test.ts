import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { flipNode } from '../src/gbwt/node.ts'
import { subgraphInInterval } from '../src/query.ts'

import type { Pos } from '../src/gbwt/record.ts'

const dataDir = path.join(import.meta.dirname, 'data')

async function walkBack(db: GBZBase, pos: Pos) {
  let current = pos
  let bpBefore = 0
  for (;;) {
    const flipped = await db.getRecord(flipNode(current.node))
    const predecessor = flipped?.gbwt().predecessorAt(current.offset)
    if (predecessor === undefined) {
      return { start: current, bpBefore }
    }
    const record = await db.getRecord(predecessor)
    const offset = record?.gbwt().offsetTo(current)
    if (!record || offset === undefined) {
      throw new Error(
        `No offset in ${predecessor} leads to ${current.node}:${current.offset}`,
      )
    }
    current = { node: predecessor, offset }
    bpBefore += record.sequenceLen
  }
}

async function checkIdentities(
  file: string,
  sample: string | undefined,
  contig: string,
  start: number,
  end: number,
  context: number,
) {
  const db = await GBZBase.open(new LocalFile(path.join(dataDir, file)))
  const subgraph = await subgraphInInterval(
    db,
    { contig, ...(sample === undefined ? {} : { sample }) },
    start,
    end,
    { context },
  )
  await subgraph.identifyPaths()
  const alignments = subgraph.alignments()
  expect(alignments.length).toBeGreaterThan(0)
  for (const alignment of alignments) {
    expect(alignment.pathHandle).toBeDefined()
    const gbzPath = await db.getPath(alignment.pathHandle!)
    expect(gbzPath).toBeDefined()
    const { start: seqStart, bpBefore } = await walkBack(db, alignment.start)
    expect(seqStart).toEqual(
      alignment.strand === '+' ? gbzPath?.fwStart : gbzPath?.revStart,
    )
    const length = (await db.haplotypeLength(alignment.pathHandle!))!
    const local = {
      start: alignment.hapStart! - gbzPath!.name.fragment,
      end: alignment.hapEnd! - gbzPath!.name.fragment,
    }
    expect(alignment.strand === '+' ? local.start : length - local.end).toBe(
      bpBefore,
    )
    let pathLen = 0
    for (const handle of alignment.path) {
      pathLen += (await db.getRecord(handle))?.sequenceLen ?? 0
    }
    expect(local.end - local.start).toBe(pathLen)
    expect(alignment.refEnd).toBeGreaterThan(alignment.refStart)
    expect(
      alignment.cigar.startsWith('D') || /^\d+D/.test(alignment.cigar),
    ).toBe(false)
  }
  return { subgraph, alignments }
}

describe('haplotype identification', () => {
  it('names every fragment in a context-free window', async () => {
    const { alignments } = await checkIdentities(
      'micb-kir3dl1.gbz.db',
      'GRCh38',
      'chr6',
      31500000,
      31501000,
      0,
    )
    const samples = new Set(
      alignments.map(a => `${a.name?.sample}#${a.name?.haplotype}`),
    )
    expect(samples.size).toBeGreaterThan(50)
    expect(alignments.some(a => a.strand === '-')).toBe(true)
    expect(alignments.some(a => a.strand === '+')).toBe(true)
  })

  it('names every haplotype walk with context', async () => {
    const { alignments, subgraph } = await checkIdentities(
      'micb-kir3dl1.gbz.db',
      'GRCh38',
      'chr6',
      31500000,
      31501000,
      100,
    )
    expect(alignments.length).toBe(subgraph.pathCount - 1)
    const json = subgraph.toJSON(true, { names: 'resolved' })
    expect(json.paths.slice(1).every(p => !p.name.startsWith('unknown#'))).toBe(
      true,
    )
    expect(json.paths[1]?.name).toMatch(/^[A-Z0-9]+#[12]#\S+\[\d+-\d+\]$/)
  })

  it('works on the other reference and chromosome', async () => {
    await checkIdentities(
      'micb-kir3dl1.gbz.db',
      'CHM13',
      'chr6',
      31352000,
      31352500,
      20,
    )
    await checkIdentities(
      'micb-kir3dl1.gbz.db',
      'GRCh38',
      'chr19',
      54816500,
      54822000,
      0,
    )
  })

  it('works on the tiny example graph', async () => {
    await checkIdentities('example.gbz.db', undefined, 'A', 1, 4, 1)
    await checkIdentities('example-v3.gbz.db', undefined, 'B', 0, 3, 2)
  })
})
