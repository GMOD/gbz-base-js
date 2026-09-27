import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { openSampled } from './fixtures.ts'
import { checkResolvedRecord, walkBack } from './walkBack.ts'
import { GBZBase } from '../src/db.ts'
import { ENDMARKER, encodeNode, nodeId } from '../src/gbwt/node.ts'
import { keepTuning } from '../src/chosenPaths.ts'
import { subgraphForHaplotypes, subgraphInInterval } from '../src/query.ts'

import type { HaplotypeSample } from '../src/db.ts'
import type { PathName } from '../src/pathName.ts'
import type { HaplotypeQueryOptions } from '../src/query.ts'
import type { HaplotypeAlignment } from '../src/subgraph.ts'

const dataDir = path.join(import.meta.dirname, 'data')

function openWithCompanion(graph: string, companion: string) {
  return GBZBase.open(new LocalFile(path.join(dataDir, graph)), {
    haplotypeIndex: new LocalFile(path.join(dataDir, companion)),
  })
}

const openMicb = () =>
  openWithCompanion('micb-kir3dl1.gbz.db', 'micb-kir3dl1.haplotype-index.db')

const openSplit = () =>
  openWithCompanion('split-contig.gbz.db', 'split-contig.haplotype-index.db')

async function forwardSteps(db: GBZBase, pathHandle: number) {
  const gbzPath = await db.getPath(pathHandle)
  const steps: { id: number; offset: number; len: number }[] = []
  let pos = gbzPath?.fwStart
  let offset = 0
  while (pos && pos.node !== ENDMARKER) {
    const record = await db.getRecord(pos.node)
    if (!record) {
      throw new Error(`node ${pos.node} is missing`)
    }
    steps.push({ id: nodeId(pos.node), offset, len: record.sequenceLen })
    offset += record.sequenceLen
    pos = record.gbwt().lf(pos.offset)
  }
  return steps
}

async function positionsAt(db: GBZBase, handle: number) {
  const record = await db.getRecord(handle)
  return record ? record.gbwt().decompressArrays().nodes.length : 0
}

interface ExpectedAnchor {
  pathHandle: number
  anchorOffset: number
  id: number
  pathOffset: number
}

// The rule the tool documents, computed independently over the reader's
// own walk of each indexed path: the first node for k = 0, and for k >= 1
// the node with the most GBWT positions among those overlapping the half
// spacing before k * spacing, the last on a tie.
async function expectedAnchors(db: GBZBase, spacing: number) {
  const anchors: ExpectedAnchor[] = []
  for (const gbzPath of (await db.paths()).filter(p => p.isIndexed)) {
    const steps = await forwardSteps(db, gbzPath.handle)
    const visits = new Map<number, number>()
    for (const step of steps) {
      visits.set(step.id, await positionsAt(db, encodeNode(step.id, 'forward')))
    }
    const length = steps.reduce((n, step) => n + step.len, 0)
    const first = steps[0]!
    anchors.push({
      pathHandle: gbzPath.handle,
      anchorOffset: 0,
      id: first.id,
      pathOffset: 0,
    })
    for (let target = spacing; target <= length; target += spacing) {
      const overlapping = steps.filter(
        step =>
          step.offset < target && step.offset + step.len > target - spacing / 2,
      )
      const most = Math.max(...overlapping.map(step => visits.get(step.id)!))
      const chosen = overlapping.findLast(step => visits.get(step.id) === most)!
      anchors.push({
        pathHandle: gbzPath.handle,
        anchorOffset: target,
        id: chosen.id,
        pathOffset: chosen.offset,
      })
    }
  }
  return anchors
}

function anchorIds(anchors: ExpectedAnchor[]) {
  return [...new Set(anchors.map(a => a.id))].sort((a, b) => a - b)
}

async function rowsCoverEveryPosition(db: GBZBase, id: number) {
  let covered = true
  for (const orientation of ['forward', 'reverse'] as const) {
    const handle = encodeNode(id, orientation)
    const positions = await positionsAt(db, handle)
    for (let offset = 0; offset < positions; offset++) {
      if ((await db.haplotypeSampleAt(handle, offset)) === undefined) {
        covered = false
      }
    }
  }
  return covered
}

function recordKey(alignment: HaplotypeAlignment) {
  return alignment.resolved
    ? `${alignment.label} ${alignment.strand} ${alignment.refStart}-${alignment.refEnd}`
    : 'unresolved'
}

describe('anchor rows in the companion', () => {
  it('record their spacing and rule in the tags', async () => {
    const micb = await openMicb()
    expect(await micb.haplotypeAnchorSpacing()).toBe(2500)
    const split = await openSplit()
    expect(await split.haplotypeAnchorSpacing()).toBe(300)
    const sampled = await openSampled('micb-kir3dl1.gbz.db')
    expect(await sampled.haplotypeAnchorSpacing()).toBeUndefined()
  })

  it('name the first node and the most visited node before every multiple of the spacing on each indexed path, one row per visit in both orientations', async () => {
    const db = await openSplit()
    const anchors = await expectedAnchors(db, 300)
    expect(anchors.length).toBe(4)
    for (const anchor of anchors) {
      const named = await db.haplotypeAnchor(
        anchor.pathHandle,
        anchor.anchorOffset,
      )
      expect(named).toBeDefined()
      expect(nodeId(named!.node)).toBe(anchor.id)
      expect(named!.pathOffset).toBe(anchor.pathOffset)
    }
    expect(await db.haplotypeAnchor(0, 150)).toBeUndefined()
    const ids = anchorIds(anchors)
    expect(ids).toEqual([1, 4, 8, 11])
    for (const id of ids) {
      expect(await rowsCoverEveryPosition(db, id)).toBe(true)
    }
    let incomplete = 0
    for (let id = 1; id <= 12; id++) {
      if (!ids.includes(id) && !(await rowsCoverEveryPosition(db, id))) {
        incomplete += 1
      }
    }
    expect(incomplete).toBeGreaterThan(0)
  })

  it('name the visiting path and its own coordinate at the node', async () => {
    const db = await openSplit()
    const lengths = new Map<number, number>()
    for (const gbzPath of await db.paths()) {
      lengths.set(gbzPath.handle, (await db.haplotypeLength(gbzPath.handle))!)
    }
    const rows: HaplotypeSample[] = []
    let visits = 0
    for (const id of anchorIds(await expectedAnchors(db, 300))) {
      for (const orientation of ['forward', 'reverse'] as const) {
        const handle = encodeNode(id, orientation)
        visits += await positionsAt(db, handle)
        rows.push(...(await db.haplotypeSamplesAtNode(handle)))
      }
    }
    expect(rows.length).toBe(visits)
    expect(rows.length).toBeGreaterThan(20)
    for (const row of rows) {
      const steps = await forwardSteps(db, row.pathHandle)
      const visits = steps.filter(step => step.id === nodeId(row.node))
      expect(visits.map(v => v.offset)).toContain(row.pathOffset)
      const { start, bpBefore } = await walkBack(db, {
        node: row.node,
        offset: row.offset,
      })
      const gbzPath = (await db.getPath(row.pathHandle))!
      expect(start).toEqual(
        row.orientation === 'forward' ? gbzPath.fwStart : gbzPath.revStart,
      )
      const nodeLen = (await db.getRecord(row.node))!.sequenceLen
      expect(bpBefore).toBe(
        row.orientation === 'forward'
          ? row.pathOffset
          : lengths.get(row.pathHandle)! - row.pathOffset - nodeLen,
      )
    }
  })

  it('cover every visit at every anchor node of the HPRC slice, and pick nodes most haplotypes visit', async () => {
    const db = await openMicb()
    const anchors = await expectedAnchors(db, 2500)
    expect(anchors.length).toBe(24)
    for (const anchor of anchors) {
      const named = await db.haplotypeAnchor(
        anchor.pathHandle,
        anchor.anchorOffset,
      )
      expect(nodeId(named!.node)).toBe(anchor.id)
    }
    const ids = anchorIds(anchors)
    expect(ids.length).toBe(13)
    for (const id of ids) {
      expect(await rowsCoverEveryPosition(db, id)).toBe(true)
    }
    const chr6 = anchors.filter(a => a.anchorOffset > 0 && a.pathHandle === 0)
    expect(chr6.length).toBeGreaterThan(0)
    for (const anchor of chr6) {
      expect(
        await positionsAt(db, encodeNode(anchor.id, 'forward')),
      ).toBeGreaterThan(80)
    }
  })
})

const chr6 = { sample: 'GRCh38', contig: 'chr6' }

// The sampled route narrowed by keepHaplotypes is the answer a query that uses
// the keep option must give, down to the GBWT position each walk starts at.
async function expectParity(
  db: GBZBase,
  query: { sample: string; contig: string },
  start: number,
  end: number,
  opts: HaplotypeQueryOptions,
) {
  const kept = await subgraphForHaplotypes(db, query, start, end, opts)
  const sampled = await subgraphInInterval(db, query, start, end, opts)
  await sampled.identifyPaths()
  sampled.keepHaplotypes(opts.keep)
  expect(await kept.toGFA({ names: 'resolved' })).toBe(
    await sampled.toGFA({ names: 'resolved' }),
  )
  const alignments = kept.alignments()
  expect(alignments).toEqual(sampled.alignments())
  for (const alignment of alignments) {
    const check = await checkResolvedRecord(db, alignment)
    expect(check.start).toEqual(check.expectedStart)
    expect(check.bpBefore).toBe(check.claimedBefore)
    expect(check.hapLen).toBe(check.consumed.query)
    expect(check.refLen).toBe(check.consumed.reference)
  }
  return { kept, alignments }
}

const keepSets: [string, (name: PathName) => boolean][] = [
  ['HG01106', name => name.sample === 'HG01106'],
  ['HG00438#1', name => name.sample === 'HG00438' && name.haplotype === 1],
  ['every HG0 sample', name => name.sample.startsWith('HG0')],
  ['everything but CHM13', name => name.sample !== 'CHM13'],
]

describe('a query that uses the keep option', () => {
  it('returns the sampled route’s walks at every context and snarl setting', async () => {
    const db = await openMicb()
    const windows: [{ sample: string; contig: string }, number, number][] = [
      [chr6, 31500000, 31501000],
      [chr6, 31503000, 31504000],
      [chr6, 31505000, 31505100],
      [chr6, 31507000, 31507050],
      [chr6, 31509000, 31511000],
      [chr6, 31498140, 31511000],
      [{ sample: 'GRCh38', contig: 'chr19' }, 54820000, 54822000],
      [{ sample: 'GRCh38', contig: 'chr19' }, 54816500, 54830000],
      [{ sample: 'CHM13', contig: 'chr6' }, 31352000, 31352500],
      [{ sample: 'CHM13', contig: 'chr6' }, 31354000, 31354100],
    ]
    const routes = new Map<string, number>()
    let walks = 0
    const saved = keepTuning.mostChosenPaths
    keepTuning.mostChosenPaths = Number.POSITIVE_INFINITY
    try {
      for (const [query, start, end] of windows) {
        for (const context of [0, 100, 1000]) {
          for (const snarls of ['none', 'contained', 'overlapping'] as const) {
            for (const [, keep] of keepSets) {
              const { kept, alignments } = await expectParity(
                db,
                query,
                start,
                end,
                { keep, context, snarls },
              )
              const route = kept.stats.keep?.fallback ?? 'keep'
              routes.set(route, (routes.get(route) ?? 0) + 1)
              walks += alignments.length
            }
          }
        }
      }
    } finally {
      keepTuning.mostChosenPaths = saved
    }
    console.log(routes)
    expect(walks).toBeGreaterThan(5000)
    expect(routes.get('keep')).toBeGreaterThan(250)
  }, 300000)

  it('follows a contig off the reference’s end and one that starts after the anchor', async () => {
    const db = await openSplit()
    const chr1 = { sample: 'GRCh38', contig: 'chr1' }
    for (const context of [0, 100]) {
      const { alignments } = await expectParity(db, chr1, 200, 500, {
        keep: name => name.sample === 'HG001',
        context,
      })
      expect(alignments.map(a => a.refEnd)).toEqual([501, 501])
    }
    const { alignments } = await expectParity(db, chr1, 1500, 1600, {
      keep: name => name.sample === 'HG002',
    })
    expect(alignments.map(recordKey)).toEqual([
      'HG002#1#ctgB[0-361] + 1500-1861',
    ])
  })

  it('finds a contig with no row at the anchor from its samples in the window', async () => {
    const db = await openMicb()
    const anchor = (await db.haplotypeAnchor(1, 0))!
    const rows = await db.haplotypeSamplesAtNode(anchor.node)
    const dropped = rows.find(
      row => row.pathHandle !== 0 && row.pathHandle !== 1,
    )!
    const gbzPath = (await db.getPath(dropped.pathHandle))!
    Object.defineProperty(db, 'haplotypeSamplesAtNode', {
      value: (handle: number) =>
        db
          .haplotypeSamplesInRange(handle, handle)
          .then(all =>
            all.filter(row => row.pathHandle !== dropped.pathHandle),
          ),
    })
    const { alignments } = await expectParity(db, chr6, 31500000, 31501000, {
      keep: name => name.contig === gbzPath.name.contig,
      context: 0,
    })
    expect(
      alignments.some(a => a.resolved && a.pathHandle === dropped.pathHandle),
    ).toBe(true)
  })

  it('identifies every walk on the same subgraph when the haplotype index has no anchors', async () => {
    const db = await openSampled('micb-kir3dl1.gbz.db')
    const { kept, alignments } = await expectParity(
      db,
      chr6,
      31500000,
      31501000,
      { keep: name => name.sample === 'HG01106' },
    )
    expect(kept.stats.keep?.fallback).toMatch(/no anchors/)
    expect(alignments.length).toBe(2)
  })

  it('refuses anchor rows that do not include the reference’s own visit', async () => {
    const db = await openMicb()
    const anchor = db.haplotypeAnchor.bind(db)
    Object.defineProperty(db, 'haplotypeAnchor', {
      value: async (pathHandle: number, offset: number) => {
        const named = await anchor(pathHandle, offset)
        return named && { ...named, pathOffset: named.pathOffset + 1 }
      },
    })
    await expect(
      subgraphForHaplotypes(db, chr6, 31500000, 31501000, {
        keep: name => name.sample === 'HG01106',
      }),
    ).rejects.toThrow(/no anchor row for the reference path/)
  })

  it('is what keep uses on the range queries, except with distinct haplotypes', async () => {
    const chr6Name = 'GRCh38#0#chr6'
    const keep = (name: PathName) => name.sample === 'HG01106'
    const db = await openMicb()
    const kept = await db.getSubgraphForRange(chr6Name, 31500000, 31501000, {
      keep,
    })
    expect(kept?.stats.keep?.fallback).toBeUndefined()
    const alignments = await db.getAlignmentsForRange(
      chr6Name,
      31500000,
      31501000,
      { keep },
    )
    const plain = await (
      await openSampled('micb-kir3dl1.gbz.db')
    ).getSubgraphForRange(chr6Name, 31500000, 31501000, { keep })
    expect(plain?.stats.keep?.fallback).toMatch(/no anchors/)
    expect(alignments).toEqual(plain!.alignments())
    const distinct = await db.getSubgraphForRange(
      chr6Name,
      31500000,
      31501000,
      { keep, haplotypes: 'distinct' },
    )
    expect(distinct?.stats.keep).toBeUndefined()
  })
})
