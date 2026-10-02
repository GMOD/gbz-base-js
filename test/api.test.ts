import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { dataDir, openSampled } from './fixtures.ts'
import { GBZBase, UnknownPathError } from '../src/db.ts'
import { parsePathName } from '../src/pathName.ts'
import { Subgraph, SubgraphLimitError } from '../src/subgraph.ts'

const chr6 = 'GRCh38#0#chr6'

function openMicb() {
  return openSampled('micb-kir3dl1.gbz.db')
}

it('builds a subgraph only through a query', () => {
  // @ts-expect-error the constructor is private
  expect(() => new Subgraph()).toThrow()
})

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
    const [fragment] = await db.getPathFragments({
      path: chr6,
      start: 31500000,
      end: 31501000,
    })
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

  it('reports nothing outside the fragment, and throws for an unknown path', async () => {
    const db = await openMicb()
    expect(
      await db.getPathFragments({ path: chr6, start: 0, end: 1000 }),
    ).toEqual([])
    await expect(
      db.getPathFragments({ path: 'nonexistent', start: 0, end: 1000 }),
    ).rejects.toThrow(UnknownPathError)
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
    return (await db.getPathFragments({ path: chr6, start, end })).map(
      f => f.start,
    )
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
  it('says how far into the window the node limit tripped', async () => {
    const db = await openMicb()
    const error = await db
      .getAlignments({ path: chr6, start: 31500000, end: 31501000, limit: 3 })
      .then(() => undefined)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SubgraphLimitError)
    if (error instanceof SubgraphLimitError) {
      expect(error.limit).toBe(3)
      expect(error.windowBp).toBe(1000)
      expect(error.walkedBp).toBeGreaterThanOrEqual(0)
      expect(error.walkedBp).toBeLessThan(1000)
      expect(error.message).toMatch(/bp into a 1000 bp window/)
    }
  })

  it('takes a PanSN string and resolves names in one call', async () => {
    const db = await openMicb()
    const alignments = await db.getAlignments({
      path: chr6,
      start: 31500000,
      end: 31501000,
    })
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
      db.getAlignments({ path: chr6, start: 31500000, end: 31501000 }),
      db.getAlignments({
        path: { sample: 'GRCh38', haplotype: 0, contig: 'chr6' },
        start: 31500000,
        end: 31501000,
      }),
    ])
    expect(fromString).toEqual(fromObject)
  })

  it('clamps the window to the fragment rather than walking off its end', async () => {
    const db = await openMicb()
    const [fragment] = await db.getPathFragments({
      path: chr6,
      start: 31500000,
      end: 31501000,
    })
    const alignments = await db.getAlignments({
      path: chr6,
      start: fragment!.end - 200,
      end: fragment!.end + 100000,
    })
    expect(alignments.length).toBeGreaterThan(0)
    expect(Math.max(...alignments.map(a => a.refEnd))).toBeLessThanOrEqual(
      fragment!.end,
    )
  })

  it('returns nothing for a window no fragment covers', async () => {
    const db = await openMicb()
    expect(await db.getAlignments({ path: chr6, start: 0, end: 1000 })).toEqual(
      [],
    )
  })

  it('leaves haplotypes unresolved on a database with no index', async () => {
    const db = await openMicb()
    Object.defineProperty(db, 'hasHaplotypeIndex', { value: false })
    const alignments = await db.getAlignments({
      path: chr6,
      start: 31500000,
      end: 31501000,
    })
    expect(alignments.length).toBeGreaterThan(0)
    expect(alignments.every(a => !a.resolved)).toBe(true)
  })

  it('rejects an aborted signal', async () => {
    const db = await openMicb()
    await expect(
      db.getAlignments({
        path: chr6,
        start: 31500000,
        end: 31501000,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow()
  })

  it('collapses identical walks under distinct, and only accepts outputs it can align', async () => {
    const db = await openMicb()
    const all = await db.getAlignments({
      path: chr6,
      start: 31500000,
      end: 31501000,
    })
    const distinct = await db.getAlignments({
      path: chr6,
      start: 31500000,
      end: 31501000,
      haplotypes: 'distinct',
    })
    expect(distinct.length).toBeLessThan(all.length)
    expect(all.every(a => a.weight === undefined)).toBe(true)
    expect(distinct.every(a => a.weight !== undefined && a.weight >= 1)).toBe(
      true,
    )
    // @ts-expect-error alignments need haplotypes to align
    void db.getAlignments({ path: chr6, start: 0, end: 1, haplotypes: 'none' })
    // @ts-expect-error snarls do not shape an alignment record
    void db.getAlignments({ path: chr6, start: 0, end: 1, snarls: 'contained' })
  })
})

describe('getSubgraphForRange', () => {
  it('hands back a query object with names already resolved', async () => {
    const db = await openMicb()
    const [subgraph] = await db.getSubgraphs({
      path: chr6,
      start: 31500000,
      end: 31501000,
    })
    const gfa = await subgraph!.toGFA()
    expect(gfa).not.toMatch(/\bunknown#/)
    expect(
      subgraph!.toSubgraphJson({ names: 'anonymous' }).paths[1]?.name,
    ).toMatch(/^unknown#/)
    const json = subgraph!.toSubgraphJson({ cigar: true })
    expect(json.nodes.length).toBeGreaterThan(0)
    expect(json.paths[0]?.name).toMatch(/^GRCh38#0#chr6\[\d+-\d+\]$/)
  })

  it('reports the interval it actually answered', async () => {
    const db = await openMicb()
    const [fragment] = await db.getPathFragments({
      path: chr6,
      start: 31500000,
      end: 31501000,
    })
    const [subgraph] = await db.getSubgraphs({
      path: chr6,
      start: 31500000,
      end: fragment!.end + 100000,
      context: 0,
    })
    expect(subgraph?.referenceInterval?.end).toBe(fragment!.end)
  })

  it('is empty when no fragment covers the window, and throws for a path the graph lacks', async () => {
    const db = await openMicb()
    expect(await db.getSubgraphs({ path: chr6, start: 0, end: 1000 })).toEqual(
      [],
    )
    expect(
      await db.getSubgraphs({ path: chr6, start: 1000, end: 1000 }),
    ).toEqual([])
    const unknown = db.getSubgraphs({ path: 'chr6', start: 0, end: 1000 })
    await expect(unknown).rejects.toThrow(UnknownPathError)
    await expect(unknown).rejects.toThrow(
      'the graph has no path named _gbwt_ref#0#chr6',
    )
    await expect(
      db.getAlignments({ path: 'nonexistent', start: 0, end: 1000 }),
    ).rejects.toThrow(UnknownPathError)
  })

  it('reports a reference interval that runs to node boundaries and through context', async () => {
    const db = await openMicb()
    const [tight] = await db.getSubgraphs({
      path: chr6,
      start: 31500000,
      end: 31501000,
      context: 0,
    })
    const [wide] = await db.getSubgraphs({
      path: chr6,
      start: 31500000,
      end: 31501000,
      context: 100,
    })
    expect(tight?.referenceInterval?.start).toBeLessThanOrEqual(31500000)
    expect(tight?.referenceInterval?.end).toBeGreaterThanOrEqual(31501000)
    expect(wide?.referenceInterval?.end).toBeGreaterThan(
      tight!.referenceInterval!.end,
    )
  })
})

describe('subgraphInInterval', () => {
  it('rejects an interval that is empty, reversed or not a number', async () => {
    const db = await openMicb()
    const path = { sample: 'GRCh38', contig: 'chr6' }
    for (const end of [31500000, 31499900, Number.NaN]) {
      await expect(
        db.subgraphInInterval({ path, start: 31500000, end, context: 0 }),
      ).rejects.toThrow('Interval length must be greater than 0')
    }
  })
})

describe('subgraphAroundNodes', () => {
  it('takes overlapping snarls around one node named twice, as upstream does', async () => {
    const db = await openMicb()
    const around = (nodeIds: number[]) =>
      db.subgraphAroundNodes({ nodeIds, context: 0, snarls: 'overlapping' })
    const once = await around([129])
    const twice = await around([129, 129])
    expect(await twice.toGFA()).toBe(await once.toGFA())
    await expect(around([129, 130])).rejects.toThrow(
      'Overlapping snarls cannot be extracted for a node-based query with multiple nodes',
    )
  })
})

describe('keep', () => {
  const wanted = (name: { sample: string }) => name.sample === 'HG01106'

  it('narrows a range subgraph to the reference and the kept walks', async () => {
    const db = await openMicb()
    const [whole] = await db.getSubgraphs({
      path: chr6,
      start: 31500000,
      end: 31501000,
    })
    const [kept] = await db.getSubgraphs({
      path: chr6,
      start: 31500000,
      end: 31501000,
      keep: wanted,
    })
    expect(kept?.pathCount).toBe(3)
    expect(kept!.nodeCount).toBeLessThan(whole!.nodeCount)
    const walks = (await kept!.toGFA({ names: 'resolved' }))
      .split('\n')
      .filter(line => line.startsWith('W\t'))
      .map(line => line.split('\t')[1])
    expect(walks).toEqual(['GRCh38', 'HG01106', 'HG01106'])
  })

  it('counts the reference among the pieces it breaks down by source', async () => {
    const db = await GBZBase.open({
      source: new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
      haplotypeIndex: new LocalFile(
        path.join(dataDir, 'micb-kir3dl1.haplotype-index.db'),
      ),
    })
    const [kept] = await db.getSubgraphs({
      path: chr6,
      start: 31500000,
      end: 31501000,
      keep: wanted,
    })
    const stats = kept!.stats.keep!
    expect(stats.fallback).toBeUndefined()
    expect(stats.sources.reference).toBe(1)
    expect(Object.values(stats.sources).reduce((sum, n) => sum + n, 0)).toBe(
      stats.pieces,
    )
  })

  it('aligns only the kept walks, and each the same as in the whole window', async () => {
    const db = await openMicb()
    const whole = await db.getAlignments({
      path: chr6,
      start: 31500000,
      end: 31501000,
    })
    const kept = await db.getAlignments({
      path: chr6,
      start: 31500000,
      end: 31501000,
      keep: wanted,
    })
    expect(kept.length).toBe(2)
    expect(kept).toEqual(
      whole.filter(alignment => alignment.resolved && wanted(alignment.name)),
    )
  })

  it('refuses on a database that cannot name its walks', async () => {
    const db = await openMicb()
    Object.defineProperty(db, 'hasHaplotypeIndex', { value: false })
    await expect(
      db.getAlignments({
        path: chr6,
        start: 31500000,
        end: 31501000,
        keep: wanted,
      }),
    ).rejects.toThrow(/keep needs the haplotype index/)
  })
})
