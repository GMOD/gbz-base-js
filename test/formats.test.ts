import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { dataDir } from './fixtures.ts'
import { GBZBase } from '../src/db.ts'

import type { PathName } from '../src/pathName.ts'

// The same graph with its haplotype index in format 2 (a rowid table of
// samples, anchors without their visits, node lists and stray rows in two
// tables) and in format 3.
function openWith(index: string) {
  return GBZBase.open({
    source: new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
    haplotypeIndex: new LocalFile(path.join(dataDir, index)),
  })
}

const chr6 = { sample: 'GRCh38', contig: 'chr6' }
const windows: [{ sample: string; contig: string }, number, number][] = [
  [chr6, 31500000, 31501000],
  [chr6, 31505000, 31505100],
  [chr6, 31498140, 31511000],
  [{ sample: 'GRCh38', contig: 'chr19' }, 54816500, 54830000],
  [{ sample: 'CHM13', contig: 'chr6' }, 31352000, 31352500],
]
const keeps: [string, ((name: PathName) => boolean) | undefined][] = [
  ['every walk', undefined],
  ['HG01106', name => name.sample === 'HG01106'],
  ['HG00438#1', name => name.sample === 'HG00438' && name.haplotype === 1],
]

describe('haplotype index formats', () => {
  it('answers every query the same from format 2 and format 3', async () => {
    const [two, three] = await Promise.all([
      openWith('micb-kir3dl1.format2.haplotype-index.db'),
      openWith('micb-kir3dl1.haplotype-index.db'),
    ])
    expect(three.sqlite.pager.pageSize).toBe(4096)
    expect(three.index!.pager.pageSize).toBe(65536)
    expect(two.index!.pager.pageSize).toBe(4096)
    for (const [query, start, end] of windows) {
      for (const [label, keep] of keeps) {
        const results = await Promise.all(
          [two, three].map(async db => {
            const subgraph = await db.subgraphInInterval({
              path: query,
              start,
              end,
              keep,
            })
            if (!keep) {
              await subgraph.identifyPaths()
            }
            return subgraph
          }),
        )
        const [a, b] = results as [(typeof results)[0], (typeof results)[0]]
        expect(
          await b.toGFA({ names: 'resolved' }),
          `${label} at ${start}`,
        ).toBe(await a.toGFA({ names: 'resolved' }))
        expect(b.alignments()).toEqual(a.alignments())
        if (keep) {
          expect(a.stats.keep?.fallback).toBeUndefined()
          expect(b.stats.keep?.fallback).toBeUndefined()
          expect(b.stats.keep?.anchorsRead).toBe(a.stats.keep?.anchorsRead)
        }
      }
    }
  })

  it('reads a keep query from a format 3 index in a few requests', async () => {
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
