import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { parsePathName } from '../src/pathName.ts'

const dataDir = path.join(import.meta.dirname, 'data')
const micb = path.join(dataDir, 'micb-kir3dl1.gbz.db')
const chr6 = 'GRCh38#0#chr6'

function openMicb() {
  return GBZBase.open(new LocalFile(micb))
}

describe('parsePathName', () => {
  it('reads a PanSN name', () => {
    expect(parsePathName(chr6)).toEqual({
      sample: 'GRCh38',
      haplotype: 0,
      contig: 'chr6',
    })
  })

  it('reads a bare contig', () => {
    expect(parsePathName('chrM')).toEqual({ contig: 'chrM' })
  })

  it('round-trips the interval suffix this package prints', () => {
    expect(parsePathName('HG002#1#chr6[100-200]')).toEqual({
      sample: 'HG002',
      haplotype: 1,
      contig: 'chr6',
    })
  })

  it('rejects a name that is neither', () => {
    expect(() => parsePathName('GRCh38#chr6')).toThrow(/not a path name/)
  })
})

describe('pathFragmentsForRange', () => {
  it('bounds a fragment by its own length', async () => {
    const db = await openMicb()
    const [fragment] = await db.pathFragmentsForRange(chr6, 31500000, 31501000)
    expect(fragment?.start).toBe(31498140)
    expect(fragment?.end).toBe(31498140 + 13033)
  })

  it('measures a fragment without consulting the haplotype index', async () => {
    const withIndex = await openMicb()
    const withoutIndex = await openMicb()
    Object.defineProperty(withoutIndex, 'hasHaplotypeIndex', { value: false })
    const indexed = (await withIndex.paths()).filter(p => p.isIndexed)
    for (const gbzPath of indexed) {
      expect(await withoutIndex.pathLength(gbzPath.handle)).toBe(
        await withIndex.pathLength(gbzPath.handle),
      )
    }
  })

  it('reports nothing outside the fragment, and nothing for an unknown path', async () => {
    const db = await openMicb()
    expect(await db.pathFragmentsForRange(chr6, 0, 1000)).toEqual([])
    expect(await db.pathFragmentsForRange('nonexistent', 0, 1000)).toEqual([])
    expect(await db.hasPath(chr6)).toBe(true)
    expect(await db.hasPath('nonexistent')).toBe(false)
  })
})

describe('fragment selection', () => {
  const lengths = new Map([
    [1, 1000],
    [2, 1000],
    [3, 1000],
  ])

  async function splitContig() {
    const db = await openMicb()
    const paths = [...lengths.keys()].map((handle, i) => ({
      handle,
      fwStart: { node: 0, offset: 0 },
      revStart: { node: 0, offset: 0 },
      name: {
        sample: 'GRCh38',
        contig: 'chr6',
        haplotype: 0,
        fragment: i * 1500,
      },
      isIndexed: true,
    }))
    Object.defineProperty(db, 'paths', { value: () => Promise.resolve(paths) })
    Object.defineProperty(db, 'pathLength', {
      value: (handle: number) => Promise.resolve(lengths.get(handle)),
    })
    return db
  }

  async function starts(start: number, end: number) {
    const db = await splitContig()
    return (await db.pathFragmentsForRange(chr6, start, end)).map(f => f.start)
  }

  it('spans the fragments a window touches', async () => {
    expect(await starts(500, 600)).toEqual([0])
    expect(await starts(900, 1600)).toEqual([0, 1500])
    expect(await starts(0, 5000)).toEqual([0, 1500, 3000])
  })

  it('reports nothing for a window inside a gap between fragments', async () => {
    expect(await starts(1000, 1400)).toEqual([])
    expect(await starts(2500, 3000)).toEqual([])
  })

  it('treats fragment bounds as half-open', async () => {
    expect(await starts(1500, 1600)).toEqual([1500])
    expect(await starts(999, 1000)).toEqual([0])
    expect(await starts(1000, 1001)).toEqual([])
  })

  it('reports nothing for an empty window', async () => {
    expect(await starts(500, 500)).toEqual([])
    expect(await starts(600, 500)).toEqual([])
  })
})

describe('getAlignmentsForRange', () => {
  it('takes a PanSN string and resolves names in one call', async () => {
    const db = await openMicb()
    const alignments = await db.getAlignmentsForRange(chr6, 31500000, 31501000)
    expect(alignments.length).toBeGreaterThan(0)
    for (const alignment of alignments) {
      expect(alignment.resolved).toBe(true)
      if (alignment.resolved) {
        expect(alignment.label).toMatch(/^\S+#\d+#\S+\[\d+-\d+\]$/)
        expect(alignment.name.sample).toBeTruthy()
        expect(alignment.hapEnd).toBeGreaterThan(alignment.hapStart)
      }
      expect(alignment.refEnd).toBeGreaterThan(alignment.refStart)
    }
  })

  it('matches the object form of the path reference', async () => {
    const db = await openMicb()
    const [fromString, fromObject] = await Promise.all([
      db.getAlignmentsForRange(chr6, 31500000, 31501000),
      db.getAlignmentsForRange(
        { sample: 'GRCh38', haplotype: 0, contig: 'chr6' },
        31500000,
        31501000,
      ),
    ])
    expect(fromString).toEqual(fromObject)
  })

  it('clamps the window to the fragment rather than walking off its end', async () => {
    const db = await openMicb()
    const [fragment] = await db.pathFragmentsForRange(chr6, 31500000, 31501000)
    const alignments = await db.getAlignmentsForRange(
      chr6,
      fragment!.end - 200,
      fragment!.end + 100000,
    )
    expect(alignments.length).toBeGreaterThan(0)
    expect(Math.max(...alignments.map(a => a.refEnd))).toBeLessThanOrEqual(
      fragment!.end,
    )
  })

  it('returns nothing for a window or path with no fragment', async () => {
    const db = await openMicb()
    expect(await db.getAlignmentsForRange('nonexistent', 0, 1000)).toEqual([])
    expect(await db.getAlignmentsForRange(chr6, 0, 1000)).toEqual([])
  })

  it('leaves haplotypes unresolved on a database with no index', async () => {
    const db = await openMicb()
    Object.defineProperty(db, 'hasHaplotypeIndex', { value: false })
    const alignments = await db.getAlignmentsForRange(chr6, 31500000, 31501000)
    expect(alignments.length).toBeGreaterThan(0)
    expect(alignments.every(a => !a.resolved)).toBe(true)
  })

  it('rejects an aborted signal', async () => {
    const db = await openMicb()
    await expect(
      db.getAlignmentsForRange(chr6, 31500000, 31501000, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow()
  })
})

describe('getSubgraphForRange', () => {
  it('hands back a query object with names already resolved', async () => {
    const db = await openMicb()
    const subgraph = await db.getSubgraphForRange(chr6, 31500000, 31501000)
    const gfa = await subgraph!.toGFA({ names: 'resolved' })
    expect(gfa).not.toMatch(/\bunknown#/)
    const json = subgraph!.toSubgraphJson({ cigar: true, names: 'resolved' })
    expect(json.nodes.length).toBeGreaterThan(0)
    expect(json.paths[0]?.name).toMatch(/^GRCh38#0#chr6\[\d+-\d+\]$/)
  })

  it('reports the interval it actually answered', async () => {
    const db = await openMicb()
    const [fragment] = await db.pathFragmentsForRange(chr6, 31500000, 31501000)
    const subgraph = await db.getSubgraphForRange(
      chr6,
      31500000,
      fragment!.end + 100000,
      { context: 0 },
    )
    expect(subgraph?.referenceInterval?.end).toBe(fragment!.end)
  })

  it('is undefined when no fragment covers the window', async () => {
    const db = await openMicb()
    expect(await db.getSubgraphForRange('nonexistent', 0, 1000)).toBeUndefined()
    expect(await db.getSubgraphForRange(chr6, 0, 1000)).toBeUndefined()
  })
})
