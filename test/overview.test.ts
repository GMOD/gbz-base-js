import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { dataDir } from './fixtures.ts'
import {
  GBZBase,
  OVERVIEW_ABSENT,
  OVERVIEW_REFERENCE,
  OVERVIEW_VARIANT,
} from '../src/db.ts'

function openMicb() {
  return GBZBase.open({
    source: new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
    haplotypeIndex: new LocalFile(
      path.join(dataDir, 'micb-kir3dl1.haplotype-index.db'),
    ),
  })
}

const chr6 = { sample: 'GRCh38', contig: 'chr6' }

describe('the haplotype overview', () => {
  it('classes every haplotype in every bin of the window', async () => {
    const db = await openMicb()
    const [fragment] = await db.getPathFragments({
      path: chr6,
      start: 0,
      end: Number.MAX_SAFE_INTEGER,
    })
    const overview = await db.haplotypeOverview({
      path: chr6,
      start: fragment!.start,
      end: fragment!.end,
    })
    expect(overview).toBeDefined()
    const { bins, haplotypes, cells, bin, level } = overview!
    expect(level).toBe(0)
    expect(bin).toBe(100)
    expect(bins.length).toBe(Math.ceil((fragment!.end - fragment!.start) / bin))
    expect(bins[0]!.start).toBe(fragment!.start)
    expect(bins[bins.length - 1]!.end).toBe(fragment!.end)
    expect(cells.length).toBe(bins.length * haplotypes.length)
    const own = haplotypes.findIndex(
      h => h.sample === 'GRCh38' && h.haplotype === 0,
    )
    expect(own).toBeGreaterThanOrEqual(0)
    bins.forEach((summary, b) => {
      expect(summary.classes.reduce((n, c) => n + c, 0)).toBe(haplotypes.length)
      expect(summary.end).toBeGreaterThan(summary.start)
      const row = cells.subarray(
        b * haplotypes.length,
        (b + 1) * haplotypes.length,
      )
      expect(row[own]).toBe(OVERVIEW_REFERENCE)
      const counted = [0, 0, 0, 0]
      for (const cell of row) {
        expect(cell & 3).toBeLessThanOrEqual(OVERVIEW_VARIANT)
        if ((cell & 3) !== OVERVIEW_VARIANT) {
          expect(cell >> 2).toBe(0)
        }
        counted[cell & 3] += 1
      }
      expect(counted).toEqual(summary.classes)
    })
    const absent = cells.filter(cell => (cell & 3) === OVERVIEW_ABSENT).length
    const variant = cells.filter(cell => (cell & 3) === OVERVIEW_VARIANT).length
    expect(absent).toBeGreaterThan(0)
    expect(variant).toBeGreaterThan(0)
  })

  it('picks the coarsest level whose bins fit the bp per pixel', async () => {
    const db = await openMicb()
    const window = { path: chr6, start: 31500000, end: 31510000 }
    const fine = await db.haplotypeOverview({ ...window, bpPerPixel: 399 })
    const middle = await db.haplotypeOverview({ ...window, bpPerPixel: 400 })
    const coarse = await db.haplotypeOverview({ ...window, bpPerPixel: 1e9 })
    expect(fine!.level).toBe(0)
    expect(middle!.level).toBe(1)
    expect(middle!.bin).toBe(400)
    expect(coarse!.level).toBeGreaterThan(1)
    expect(coarse!.bin).toBe(100 * 4 ** coarse!.level)
    expect(coarse!.bins.length).toBeLessThan(fine!.bins.length)
    expect(fine!.bins[0]!.start).toBeLessThanOrEqual(window.start)
    expect(fine!.bins[fine!.bins.length - 1]!.end).toBeGreaterThanOrEqual(
      window.end,
    )
    const coarseVariants = coarse!.bins.reduce((n, b) => n + b.variants, 0)
    const fineVariants = fine!.bins.reduce((n, b) => n + b.variants, 0)
    expect(coarseVariants).toBeGreaterThanOrEqual(fineVariants)
  })

  it('reads a whole contig in a handful of requests', async () => {
    const db = await openMicb()
    await db.paths()
    const before = db.fetchStats().haplotypeIndex!.fetches
    const overview = await db.haplotypeOverview({
      path: chr6,
      start: 0,
      end: Number.MAX_SAFE_INTEGER,
      bpPerPixel: 20000,
    })
    expect(overview!.bins.length).toBeGreaterThan(0)
    expect(
      db.fetchStats().haplotypeIndex!.fetches - before,
    ).toBeLessThanOrEqual(8)
  })

  it('is undefined for an index without overview tables', async () => {
    const db = await GBZBase.open({
      source: new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
      haplotypeIndex: new LocalFile(
        path.join(dataDir, 'micb-kir3dl1.format2.haplotype-index.db'),
      ),
    })
    expect(
      await db.haplotypeOverview({
        path: chr6,
        start: 31500000,
        end: 31501000,
      }),
    ).toBeUndefined()
  })
})
