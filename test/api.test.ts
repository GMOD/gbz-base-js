import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { parsePathName } from '../src/pathName.ts'

const dataDir = path.join(import.meta.dirname, 'data')
const micb = path.join(dataDir, 'micb-kir3dl1.gbz.db')

function openMicb() {
  return GBZBase.open(new LocalFile(micb))
}

describe('parsePathName', () => {
  it('reads a PanSN name', () => {
    expect(parsePathName('GRCh38#0#chr6')).toEqual({
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

describe('getFeaturesForRange', () => {
  it('takes a PanSN string and resolves names in one call', async () => {
    const db = await openMicb()
    const features = await db.getFeaturesForRange(
      'GRCh38#0#chr6',
      31500000,
      31501000,
    )
    expect(features.length).toBeGreaterThan(0)
    for (const feature of features) {
      expect(feature.resolved).toBe(true)
      if (feature.resolved) {
        expect(feature.name).toMatch(/^\S+#\d+#\S+\[\d+-\d+\]$/)
        expect(feature.hapEnd).toBeGreaterThan(feature.hapStart)
      }
      expect(feature.refEnd).toBeGreaterThan(feature.refStart)
    }
  })

  it('matches the object form of the path reference', async () => {
    const db = await openMicb()
    const [fromString, fromObject] = await Promise.all([
      db.getFeaturesForRange('GRCh38#0#chr6', 31500000, 31501000),
      db.getFeaturesForRange(
        { sample: 'GRCh38', haplotype: 0, contig: 'chr6' },
        31500000,
        31501000,
      ),
    ])
    expect(fromString).toEqual(fromObject)
  })

  it('adds no context unless asked, unlike the low-level query', async () => {
    const db = await openMicb()
    const bare = await db.getFeaturesForRange(
      'GRCh38#0#chr6',
      31500000,
      31501000,
    )
    const padded = await db.getFeaturesForRange(
      'GRCh38#0#chr6',
      31500000,
      31501000,
      { context: 100 },
    )
    expect(padded.length).not.toBe(bare.length)
  })

  it('returns nothing for a contig the graph does not have', async () => {
    const db = await openMicb()
    expect(await db.getFeaturesForRange('nonexistent', 0, 1000)).toEqual([])
    expect(await db.getFeaturesForRange('GRCh38#7#chr6', 0, 1000)).toEqual([])
    expect(await db.hasPath('GRCh38#0#chr6')).toBe(true)
    expect(await db.hasPath('nonexistent')).toBe(false)
  })

  it('leaves haplotypes unresolved on a database with no index', async () => {
    const db = await openMicb()
    Object.defineProperty(db, 'hasHaplotypeIndex', { value: false })
    const features = await db.getFeaturesForRange(
      'GRCh38#0#chr6',
      31500000,
      31501000,
    )
    expect(features.length).toBeGreaterThan(0)
    expect(features.every(f => !f.resolved)).toBe(true)
  })

  it('rejects an aborted signal', async () => {
    const db = await openMicb()
    await expect(
      db.getFeaturesForRange('GRCh38#0#chr6', 31500000, 31501000, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow()
  })
})

describe('getGraphForRange', () => {
  it('returns a named subgraph in one call', async () => {
    const db = await openMicb()
    const graph = await db.getGraphForRange('GRCh38#0#chr6', 31500000, 31501000)
    expect(graph.nodes.length).toBeGreaterThan(0)
    expect(graph.edges.length).toBeGreaterThan(0)
    expect(graph.paths[0]?.name).toMatch(/^GRCh38#0#chr6\[\d+-\d+\]$/)
    expect(
      graph.paths.slice(1).every(p => !p.name.startsWith('unknown#')),
    ).toBe(true)
    expect(graph.paths.slice(1).every(p => p.cigar !== undefined)).toBe(true)
  })

  it('omits cigars when asked to', async () => {
    const db = await openMicb()
    const graph = await db.getGraphForRange(
      'GRCh38#0#chr6',
      31500000,
      31501000,
      { cigar: false },
    )
    expect(graph.paths.every(p => p.cigar === undefined)).toBe(true)
  })

  it('returns an empty graph for a contig the graph does not have', async () => {
    const db = await openMicb()
    expect(await db.getGraphForRange('nonexistent', 0, 1000)).toEqual({
      nodes: [],
      edges: [],
      paths: [],
    })
  })
})
