import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { dataDir } from './fixtures.ts'
import { GBZBase } from '../src/db.ts'

import type { PathName } from '../src/pathName.ts'

const chr6 = { sample: 'GRCh38', contig: 'chr6' }
const [start, end] = [31500000, 31501000]

const open = () =>
  GBZBase.open({
    source: new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
    haplotypeIndex: new LocalFile(
      path.join(dataDir, 'micb-kir3dl1.haplotype-index.db'),
    ),
  })

describe('keep with distinct walks', () => {
  it('merges the kept walks, so every kept walk counts in a weight', async () => {
    const db = await open()
    const names = new Set<string>()
    for (const alignment of await db.getAlignments({
      path: chr6,
      start,
      end,
    })) {
      if (alignment.resolved) {
        names.add(`${alignment.name.sample}#${alignment.name.haplotype}`)
      }
    }
    expect(names.size).toBeGreaterThan(80)
    let apart = 0
    for (const wanted of names) {
      const keep = (name: PathName) =>
        `${name.sample}#${name.haplotype}` === wanted
      const all = await db.subgraphInInterval({ path: chr6, start, end, keep })
      const distinct = await db.subgraphInInterval({
        path: chr6,
        start,
        end,
        keep,
        haplotypes: 'distinct',
      })
      const { paths } = distinct.toSubgraphJson({ names: 'resolved' })
      const weight = paths.reduce((sum, path) => sum + (path.weight ?? 1), 0)
      expect(weight).toBe(all.pathCount)
      expect(
        paths.every(
          path =>
            path.name.startsWith('GRCh38#') || path.name.startsWith(wanted),
        ),
      ).toBe(true)
      const records = await db.getAlignments({
        path: chr6,
        start,
        end,
        keep,
        haplotypes: 'distinct',
      })
      expect(records.length).toBe(paths.length - 1)
      apart += records.length
    }
    expect(apart).toBeGreaterThan(60)
  })

  it('refuses to choose haplotypes among merged or unnamed walks', async () => {
    const db = await open()
    const keep = (name: PathName) => name.sample === 'HG01106'
    const merged = await db.subgraphInInterval({
      path: chr6,
      start,
      end,
      haplotypes: 'distinct',
    })
    await merged.identifyPaths()
    expect(() => {
      merged.keepHaplotypes(keep)
    }).toThrow(/one walk per haplotype/)
    const unnamed = await db.subgraphInInterval({ path: chr6, start, end })
    expect(() => {
      unnamed.keepHaplotypes(keep)
    }).toThrow(/have no name/)
  })
})
