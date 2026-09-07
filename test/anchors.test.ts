import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it, vi } from 'vitest'

import { checkResolvedRecord, walkBack } from './walkBack.ts'
import { GBZBase } from '../src/db.ts'
import { ENDMARKER, encodeNode, nodeId } from '../src/gbwt/node.ts'
import { subgraphForHaplotypes, subgraphInInterval } from '../src/query.ts'
import { Subgraph } from '../src/subgraph.ts'

import type { HaplotypeSample } from '../src/db.ts'
import type { PathName } from '../src/pathName.ts'
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
// spacing before k * spacing, the first on a tie.
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
      const chosen = overlapping.find(step => visits.get(step.id) === most)!
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

async function sampledRoute(
  db: GBZBase,
  query: { sample: string; contig: string },
  start: number,
  end: number,
  keep: (name: PathName) => boolean,
) {
  const subgraph = await subgraphInInterval(db, query, start, end, {
    context: 0,
  })
  await subgraph.identifyPaths()
  subgraph.keepHaplotypes(keep)
  return subgraph
}

async function expectSameRecords(db: GBZBase, a: Subgraph, b: Subgraph) {
  const left = a.alignments()
  const right = b.alignments()
  expect(left.map(recordKey).sort()).toEqual(right.map(recordKey).sort())
  for (const alignment of left) {
    const check = await checkResolvedRecord(db, alignment)
    expect(check.start).toEqual(check.expectedStart)
    expect(check.bpBefore).toBe(check.claimedBefore)
    expect(check.hapLen).toBe(check.consumed.query)
    expect(check.refLen).toBe(check.consumed.reference)
  }
  return left
}

describe('anchor rows in the companion', () => {
  it('record their spacing and rule in the tags', async () => {
    const micb = await openMicb()
    expect(await micb.haplotypeAnchorSpacing()).toBe(2500)
    const split = await openSplit()
    expect(await split.haplotypeAnchorSpacing()).toBe(300)
    const embedded = await GBZBase.open(
      new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
    )
    expect(await embedded.haplotypeAnchorSpacing()).toBeUndefined()
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

describe('the anchored walk', () => {
  const chr6 = { sample: 'GRCh38', contig: 'chr6' }

  it('gives the sampled route’s records from the rows at one node and no chain walk', async () => {
    const db = await openMicb()
    const keep = (name: PathName) => name.sample === 'HG01106'
    const anchored = await subgraphForHaplotypes(db, chr6, 31500000, 31501000, {
      keep,
    })
    const sampled = await sampledRoute(db, chr6, 31500000, 31501000, keep)
    const records = await expectSameRecords(db, anchored, sampled)
    expect(records.length).toBe(2)
    const stats = anchored.stats.anchorWalk!
    expect(stats.spacing).toBe(2500)
    expect(stats.anchorOffset).toBe(0)
    expect(stats.rows).toBe(await positionsAt(db, stats.anchorHandle))
    expect(stats.walks.map(w => w.end)).toEqual([
      'through the window',
      'through the window',
    ])
    expect(stats.fallback).toBeUndefined()
    expect(anchored.stats.identification.chains).toEqual([])
    expect(anchored.stats.identificationSteps).toBe(0)
  })

  it('starts from the anchor before the window, in both stored orientations, for every wanted walk', async () => {
    const db = await openMicb()
    const keep = (name: PathName) => name.sample.startsWith('HG0')
    const anchored = await subgraphForHaplotypes(db, chr6, 31503000, 31504000, {
      keep,
    })
    const sampled = await sampledRoute(db, chr6, 31503000, 31504000, keep)
    const records = await expectSameRecords(db, anchored, sampled)
    expect(records.length).toBeGreaterThan(50)
    expect(records.some(r => r.strand === '-')).toBe(true)
    expect(records.some(r => r.strand === '+')).toBe(true)
    expect(anchored.stats.anchorWalk?.anchorOffset).toBe(2500)
    expect(anchored.stats.anchorWalk?.walks.length).toBe(records.length)
  })

  it('holds the reference walk and the kept walks’ nodes, private ones included', async () => {
    const db = await openMicb()
    const keep = (name: PathName) => name.sample.startsWith('HG0')
    const anchored = await subgraphForHaplotypes(db, chr6, 31509000, 31511000, {
      keep,
    })
    const sampled = await sampledRoute(db, chr6, 31509000, 31511000, keep)
    await expectSameRecords(db, anchored, sampled)
    const json = anchored.toSubgraphJson({ names: 'resolved' })
    const visited = new Set(json.paths.flatMap(p => p.path.map(s => s.id)))
    expect(json.nodes.every(n => visited.has(n.id))).toBe(true)
    expect(json.nodes.length).toBeGreaterThan(sampled.nodeCount)
    expect(json.paths[0]?.name.startsWith('GRCh38#0#chr6[')).toBe(true)
  })

  it('works with the other reference as the window’s path', async () => {
    const db = await openMicb()
    const chm13 = { sample: 'CHM13', contig: 'chr6' }
    const keep = (name: PathName) => name.sample !== 'CHM13'
    const anchored = await subgraphForHaplotypes(
      db,
      chm13,
      31352000,
      31352500,
      { keep },
    )
    const sampled = await sampledRoute(db, chm13, 31352000, 31352500, keep)
    const records = await expectSameRecords(db, anchored, sampled)
    expect(records.length).toBeGreaterThan(50)
    expect(records.some(r => r.resolved && r.name.sample === 'GRCh38')).toBe(
      true,
    )
  })

  it('walks a contig off the reference’s end without a trailing private stretch', async () => {
    const db = await openSplit()
    const chr1 = { sample: 'GRCh38', contig: 'chr1' }
    const keep = (name: PathName) => name.sample === 'HG001'
    const anchored = await subgraphForHaplotypes(db, chr1, 200, 500, { keep })
    const sampled = await sampledRoute(db, chr1, 200, 500, keep)
    const records = await expectSameRecords(db, anchored, sampled)
    expect(records.map(r => r.refEnd)).toEqual([501, 501])
    expect(anchored.stats.anchorWalk?.walks.map(w => w.end)).toEqual([
      'ended in the window',
      'ended in the window',
    ])
    const second = await subgraphForHaplotypes(db, chr1, 1500, 1600, {
      keep: name => name.sample === 'HG002',
    })
    expect(second.alignments().map(recordKey)).toEqual([
      'HG002#1#ctgB[0-150] + 1500-1650',
    ])
    expect(second.stats.anchorWalk?.anchorOffset).toBe(0)
  })

  it('walks a wanted contig with no anchor row from its sample in the window, back to the reference and through', async () => {
    const db = await openMicb()
    const keep = (name: PathName) => name.sample === 'HG01106'
    const rows = await db.haplotypeSamplesAtNode(2)
    const dropped = rows.find(
      row => row.pathHandle !== 0 && row.pathHandle !== 1,
    )!
    const gbzPath = (await db.getPath(dropped.pathHandle))!
    const wanted = (name: PathName) =>
      keep(name) || name.contig === gbzPath.name.contig
    Object.defineProperty(db, 'haplotypeSamplesAtNode', {
      value: (handle: number) =>
        db
          .haplotypeSamplesInRange(handle, handle)
          .then(all =>
            all.filter(row => row.pathHandle !== dropped.pathHandle),
          ),
    })
    const anchored = await subgraphForHaplotypes(db, chr6, 31500000, 31501000, {
      keep: wanted,
      context: 0,
    })
    const stats = anchored.stats.anchorWalk!
    expect(stats.fallback).toBeUndefined()
    expect(stats.walks.map(w => w.from)).toEqual(['anchor', 'anchor', 'sample'])
    expect(stats.walks[2]?.pathHandle).toBe(dropped.pathHandle)
    expect(stats.walks[2]?.end).toBe('through the window')
    expect(anchored.stats.identification.chains).toEqual([])
    const sampled = await sampledRoute(db, chr6, 31500000, 31501000, wanted)
    const records = await expectSameRecords(db, anchored, sampled)
    expect(
      records.some(r => r.resolved && r.pathHandle === dropped.pathHandle),
    ).toBe(true)
  })

  it('finds a contig stored against the reference from a sample of the orientation that runs with it', async () => {
    const db = await openMicb()
    const keep = (name: PathName) => name.sample === 'HG01106'
    const anchor = (await db.haplotypeAnchor(0, 0))!
    const rows = await db.haplotypeSamplesAtNode(anchor.node)
    const dropped = rows.find(
      row =>
        row.pathHandle !== 0 &&
        row.pathHandle !== 1 &&
        row.orientation === 'reverse',
    )!
    const gbzPath = (await db.getPath(dropped.pathHandle))!
    const wanted = (name: PathName) =>
      keep(name) || name.contig === gbzPath.name.contig
    Object.defineProperty(db, 'haplotypeSamplesAtNode', {
      value: (handle: number) =>
        db
          .haplotypeSamplesInRange(handle, handle)
          .then(all =>
            all.filter(row => row.pathHandle !== dropped.pathHandle),
          ),
    })
    const anchored = await subgraphForHaplotypes(db, chr6, 31500000, 31501000, {
      keep: wanted,
      context: 0,
    })
    const stats = anchored.stats.anchorWalk!
    expect(stats.fallback).toBeUndefined()
    const fromSample = stats.walks.find(w => w.from === 'sample')!
    expect(fromSample.pathHandle).toBe(dropped.pathHandle)
    expect(fromSample.end).toBe('through the window')
    const sampled = await sampledRoute(db, chr6, 31500000, 31501000, wanted)
    const records = await expectSameRecords(db, anchored, sampled)
    const record = records.find(
      r => r.resolved && r.pathHandle === dropped.pathHandle,
    )!
    expect(record.strand).toBe('-')
  })

  it('falls back to the sampled route when a walk cannot be completed', async () => {
    const db = await openMicb()
    const keep = (name: PathName) => name.sample === 'HG01106'
    const spy = vi
      .spyOn(Subgraph.prototype, 'walkHaplotypesFromAnchor')
      .mockResolvedValue('the walk hit its bound')
    try {
      const anchored = await subgraphForHaplotypes(
        db,
        chr6,
        31500000,
        31501000,
        { keep, context: 0 },
      )
      expect(anchored.stats.anchorWalk).toBeUndefined()
      expect(anchored.stats.identification.chains.length).toBeGreaterThan(0)
      const sampled = await sampledRoute(db, chr6, 31500000, 31501000, keep)
      const records = await expectSameRecords(db, anchored, sampled)
      expect(records.length).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses anchor rows that do not include the reference’s own visit', async () => {
    const db = await openMicb()
    Object.defineProperty(db, 'haplotypeSamplesAtNode', {
      value: () => Promise.resolve([]),
    })
    await expect(
      subgraphForHaplotypes(db, chr6, 31500000, 31501000, {
        keep: name => name.sample === 'HG01106',
      }),
    ).rejects.toThrow(/no anchor row for GRCh38#0#chr6/)
  })

  it('is what keep uses on the range queries, and degrades without anchors', async () => {
    const chr6Name = 'GRCh38#0#chr6'
    const keep = (name: PathName) => name.sample === 'HG01106'
    const withAnchors = await openMicb()
    const anchored = await withAnchors.getSubgraphForRange(
      chr6Name,
      31500000,
      31501000,
      { keep },
    )
    expect(anchored?.stats.anchorWalk?.fallback).toBeUndefined()
    expect(anchored?.stats.anchorWalk?.walks.length).toBe(2)
    const alignments = await withAnchors.getAlignmentsForRange(
      chr6Name,
      31500000,
      31501000,
      { keep },
    )
    const embedded = await GBZBase.open(
      new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
    )
    const plain = await embedded.getSubgraphForRange(
      chr6Name,
      31500000,
      31501000,
      { keep, context: 0 },
    )
    expect(plain?.stats.anchorWalk).toBeUndefined()
    expect(alignments.map(recordKey).sort()).toEqual(
      plain!.alignments().map(recordKey).sort(),
    )
    const distinct = await withAnchors.getSubgraphForRange(
      chr6Name,
      31500000,
      31501000,
      { keep, haplotypes: 'distinct' },
    )
    expect(distinct?.stats.anchorWalk).toBeUndefined()
  })
})
