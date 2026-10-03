import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { dataDir } from './fixtures.ts'
import { GBZBase } from '../src/db.ts'

function openWith(index: string) {
  return GBZBase.open({
    source: new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
    haplotypeIndex: new LocalFile(path.join(dataDir, index)),
  })
}

const chr6 = { sample: 'GRCh38', contig: 'chr6' }

describe('the haplotype index format', () => {
  it('refuses an index from before format 3', async () => {
    await expect(
      openWith('micb-kir3dl1.format2.haplotype-index.db'),
    ).rejects.toThrow(
      /predates format 3; rebuild it with gbz-haplotype-index 0.3/,
    )
  })

  it('opens a format 3 index with 64 KiB pages', async () => {
    const db = await openWith('micb-kir3dl1.haplotype-index.db')
    expect(db.index!.pager.pageSize).toBe(65536)
    expect(db.sqlite.pager.pageSize).toBe(4096)
  })

  it('reads a keep query in a few requests', async () => {
    const db = await openWith('micb-kir3dl1.haplotype-index.db')
    await db.paths()
    const before = db.fetchStats().haplotypeIndex!
    const subgraph = await db.subgraphInInterval({
      path: chr6,
      start: 31500000,
      end: 31501000,
      keep: name => name.sample === 'HG01106',
    })
    expect(subgraph.stats.keep?.fallback).toBeUndefined()
    const after = db.fetchStats().haplotypeIndex!
    expect(after.fetches - before.fetches).toBeLessThanOrEqual(6)
  })
})
