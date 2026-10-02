import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { SubgraphLimitError } from '../src/subgraph.ts'

const dataDir = path.join(import.meta.dirname, 'data')
const chr1 = 'GRCh38#0#chr1'

function openSplit(withIndex = true) {
  return GBZBase.open({
    source: new LocalFile(path.join(dataDir, 'split-contig.gbz.db')),
    haplotypeIndex: withIndex
      ? new LocalFile(path.join(dataDir, 'split-contig.haplotype-index.db'))
      : undefined,
  })
}

describe('a reference contig stored as two fragments', () => {
  it('bounds each fragment by its own length', async () => {
    const db = await openSplit()
    const fragments = await db.getPathFragments({
      path: chr1,
      start: 0,
      end: 5000,
    })
    expect(fragments.map(f => [f.start, f.end])).toEqual([
      [0, 501],
      [1500, 2001],
    ])
    expect(fragments.every(f => f.path.isIndexed)).toBe(true)
  })

  it('measures the fragments the same way without the index', async () => {
    const db = await openSplit(false)
    const fragments = await db.getPathFragments({
      path: chr1,
      start: 0,
      end: 5000,
    })
    expect(fragments.map(f => [f.start, f.end])).toEqual([
      [0, 501],
      [1500, 2001],
    ])
  })

  it('answers nothing inside the gap', async () => {
    const db = await openSplit()
    expect(
      await db.getPathFragments({ path: chr1, start: 600, end: 1400 }),
    ).toEqual([])
    expect(
      await db.getAlignments({ path: chr1, start: 600, end: 1400 }),
    ).toEqual([])
    expect(
      await db.getSubgraphs({ path: chr1, start: 600, end: 1400 }),
    ).toEqual([])
  })

  it('spans the boundary by concatenating the per-fragment answers', async () => {
    const db = await openSplit()
    const spanned = await db.getAlignments({
      path: chr1,
      start: 400,
      end: 1600,
      context: 0,
    })
    const separate = [
      ...(await db.getAlignments({
        path: chr1,
        start: 400,
        end: 501,
        context: 0,
      })),
      ...(await db.getAlignments({
        path: chr1,
        start: 1500,
        end: 1600,
        context: 0,
      })),
    ]
    expect(spanned).toEqual(separate)
    expect(spanned.filter(a => a.refEnd <= 501)).toHaveLength(3)
    expect(spanned.filter(a => a.refStart >= 1500)).toHaveLength(3)
    const labels = spanned.map(a => (a.resolved ? a.label : 'unresolved'))
    expect(labels).toContain('HG001#1#ctg1[321-501]')
    expect(labels).toContain('HG001#1#ctg1[651-801]')
    expect(labels).not.toContain('unresolved')
  })

  it('cuts one subgraph per fragment the window overlaps', async () => {
    const db = await openSplit()
    const spanned = await db.getSubgraphs({
      path: chr1,
      start: 400,
      end: 1600,
      context: 0,
    })
    expect(spanned.map(subgraph => subgraph.referenceInterval)).toEqual([
      {
        name: { sample: 'GRCh38', contig: 'chr1', haplotype: 0, fragment: 0 },
        start: 321,
        end: 501,
      },
      {
        name: {
          sample: 'GRCh38',
          contig: 'chr1',
          haplotype: 0,
          fragment: 1500,
        },
        start: 1500,
        end: 1650,
      },
    ])
    const [subgraph] = await db.getSubgraphs({
      path: chr1,
      start: 400,
      end: 501,
      context: 0,
    })
    expect(subgraph?.referenceInterval).toEqual({
      name: { sample: 'GRCh38', contig: 'chr1', haplotype: 0, fragment: 0 },
      start: 321,
      end: 501,
    })
    const gfa = await subgraph!.toGFA({ names: 'resolved' })
    expect(gfa).toContain('W\tGRCh38\t0\tchr1\t321\t501\t>5')
    expect(gfa).toContain('W\tHG001\t1\tctg1\t321\t501\t>5')
    expect(
      await db.getSubgraphs({ path: chr1, start: 1500, end: 1600, context: 0 }),
    ).toHaveLength(1)
  })

  it('reports the node limit from the start of the window, not of the fragment that tripped it', async () => {
    const db = await openSplit()
    const error = await db
      .getSubgraphs({
        path: chr1,
        start: 1000,
        end: 2001,
        context: 0,
        limit: 3,
      })
      .catch((error: unknown) => error)
    expect(error).toBeInstanceOf(SubgraphLimitError)
    expect(error).toMatchObject({ windowBp: 1001, walkedBp: 861 })
  })

  it('names a haplotype in the second fragment in its own coordinates', async () => {
    const db = await openSplit()
    const alignments = await db.getAlignments({
      path: chr1,
      start: 1500,
      end: 2001,
      context: 0,
    })
    const hg001Hap2 = alignments.filter(
      a => a.resolved && a.name.sample === 'HG001' && a.name.haplotype === 2,
    )
    expect(hg001Hap2.map(a => (a.resolved ? a.label : ''))).toEqual([
      'HG001#2#ctg1[651-1152]',
    ])
    expect(hg001Hap2[0]?.cigar).toBe('501M')
  })

  it('leaves names unresolved without the index', async () => {
    const db = await openSplit(false)
    const spanned = await db.getAlignments({
      path: chr1,
      start: 400,
      end: 1600,
      context: 0,
    })
    expect(spanned).toHaveLength(6)
    expect(spanned.every(a => !a.resolved)).toBe(true)
  })

  it('walks off the fragment in the lower-level query, as upstream does', async () => {
    const db = await openSplit()
    await expect(
      db.subgraphInInterval({
        path: { sample: 'GRCh38', contig: 'chr1' },
        start: 400,
        end: 1600,
        context: 0,
      }),
    ).rejects.toThrow(/No successor for GBWT position/)
  })
})
