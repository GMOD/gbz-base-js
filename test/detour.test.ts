import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'

import type { HaplotypeAlignment } from '../src/subgraph.ts'

// detour.gfa: an 11,020 bp reference 1-6. HG001#1 leaves after node 2 through
// 8,620 bp of insertion, passing reference node 5 on the way, and comes back
// at node 4, so 1 kb of context cuts its walk in two and the first piece
// reaches node 5, past where the second aligns. HG002#1 passes nodes 3 and 4
// again after a 5 kb insertion, and HG002#2 starts inside a 500 bp insertion.
// HG003#1 ends, after a 5 kb insertion, on a node beside node 1 that only
// HG003#2 also passes, so its last piece shares no node with the reference.
const dataDir = path.join(import.meta.dirname, 'data')

async function records() {
  const db = await GBZBase.open(
    new LocalFile(path.join(dataDir, 'detour.gbz.db')),
    {
      haplotypeIndex: new LocalFile(
        path.join(dataDir, 'detour.haplotype-index.db'),
      ),
    },
  )
  return db.getAlignmentsForRange('GRCh38#0#chr1', 500, 10500, {
    context: 1000,
  })
}

function consumed(cigar: string) {
  let ref = 0
  let hap = 0
  for (const [, len, op] of cigar.matchAll(/(\d+)([MID])/g)) {
    ref += op === 'I' ? 0 : Number(len)
    hap += op === 'D' ? 0 : Number(len)
  }
  return { ref, hap }
}

function labelled(alignments: HaplotypeAlignment[], prefix: string) {
  return alignments.filter(a => a.resolved && a.label.startsWith(prefix))
}

describe('a walk that leaves the subgraph and comes back', () => {
  it('is one record with the detour as an insertion beside the deletion', async () => {
    const [detour, ...rest] = labelled(await records(), 'HG001#1#')
    expect(rest).toEqual([])
    expect(detour).toMatchObject({
      label: 'HG001#1#ctg1[0-13640]',
      refStart: 0,
      refEnd: 11020,
      cigar: '2000M8620I6000D3020M',
    })
  })

  it('keeps the second pass of a repeat as a record of its own', async () => {
    const passes = labelled(await records(), 'HG002#1#')
    expect(passes.map(a => (a.resolved ? a.label : ''))).toEqual([
      'HG002#1#ctg1[0-12044]',
      'HG002#1#ctg1[14092-24020]',
    ])
  })

  it('keeps a piece that shares no node with the reference as a record of its own', async () => {
    const pieces = labelled(await records(), 'HG003#1#')
    expect(pieces.map(a => (a.resolved ? a.label : ''))).toEqual([
      'HG003#1#ctg1[0-12044]',
      'HG003#1#ctg1[14092-16320]',
    ])
  })

  it('starts and ends each record at an aligned base', async () => {
    const alignments = await records()
    const [inserted] = labelled(alignments, 'HG002#2#')
    expect(inserted).toMatchObject({ refStart: 7999, cigar: '499I3021M' })
    for (const alignment of alignments) {
      expect(alignment.cigar).toMatch(/^(\d+I)?\d+M(.*\d+M)?(\d+I)?$/)
      const { ref, hap } = consumed(alignment.cigar)
      expect(alignment.refEnd - alignment.refStart).toBe(ref)
      if (alignment.resolved) {
        expect(alignment.hapEnd - alignment.hapStart).toBe(hap)
      }
    }
  })
})
