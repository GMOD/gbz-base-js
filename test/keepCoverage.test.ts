import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'

import type { PathName } from '../src/pathName.ts'

// Both fixtures: a 96 kb reference of 48 nodes x 2000 bp with anchors every
// 16,384 bp at 0, 16000, 32000, 49024, 65024 and 81024, and haplotype samples
// every 65,536 bp, so walks find every piece and no sample does.
//
// two-copies.gfa: after node 40, HG001#2 passes nodes 19-25 again and HG002#1
// passes them inverted, each visiting the anchor at 49024 a second time.
//
// far-pass.gfa: after node 40, HG001#1 passes the window's nodes 19-20 again,
// 31 kb past its visit to the anchor at 49024, and HG004#1 passes 17-20 again,
// visiting the anchor at 32000 a second time at 80000. HG005#1's contig is
// three fragments, at 0, 50000 and 62000, and the middle one visits no anchor.
//
// unplaced.gfa: HG006#1 has a second contig of 12 kb that runs private node 49,
// nodes 18-20 and private node 50. It visits no anchor, and its only samples
// lie on the private nodes, outside a window on nodes 19-20.
const dataDir = path.join(import.meta.dirname, 'data')

function open(fixture: string) {
  return GBZBase.open({
    source: new LocalFile(path.join(dataDir, `${fixture}.gbz.db`)),
    haplotypeIndex: new LocalFile(
      path.join(dataDir, `${fixture}.haplotype-index.db`),
    ),
  })
}

const chr1 = { sample: 'GRCh38', contig: 'chr1' }

async function routes(
  fixture: string,
  windows: [number, number][],
  keepSets: string[][],
) {
  const db = await open(fixture)
  const fallbacks: (string | undefined)[] = []
  for (const [start, end] of windows) {
    for (const context of [0, 100, 1000]) {
      for (const set of keepSets) {
        const keep = (name: PathName) =>
          set.includes(`${name.sample}#${name.haplotype}`)
        const kept = await db.subgraphInInterval({
          path: chr1,
          start,
          end,
          context,
          keep,
        })
        const sampled = await db.subgraphInInterval({
          path: chr1,
          start,
          end,
          context,
        })
        await sampled.identifyPaths()
        sampled.keepHaplotypes(keep)
        expect(await kept.toGFA({ names: 'resolved' })).toBe(
          await sampled.toGFA({ names: 'resolved' }),
        )
        expect(kept.alignments()).toEqual(sampled.alignments())
        fallbacks.push(kept.stats.keep?.fallback)
      }
    }
  }
  return fallbacks
}

describe('the keep route', () => {
  it('walks both copies of the region when a path visits an anchor from each', async () => {
    const fallbacks = await routes(
      'two-copies',
      [
        [36000, 40000],
        [37000, 39000],
      ],
      [['HG001#2'], ['HG002#1'], ['HG002#2'], ['HG001#2', 'HG002#1']],
    )
    expect(fallbacks.every(f => f === undefined)).toBe(true)
  })

  it('finds a pass over the window far along a chosen path from its anchor visits', async () => {
    const fallbacks = await routes(
      'far-pass',
      [
        [36000, 40000],
        [37000, 39000],
      ],
      [['HG001#1'], ['HG002#2'], ['HG004#1'], ['HG001#1', 'HG004#1']],
    )
    expect(fallbacks.every(f => f === undefined)).toBe(true)
  })

  it('walks a fragment of a chosen contig that lies between the anchors', async () => {
    const fallbacks = await routes(
      'far-pass',
      [[55000, 56500]],
      [['HG005#1'], ['HG005#1', 'HG002#2']],
    )
    expect(fallbacks.every(f => f === undefined)).toBe(true)
  })

  it('walks a contig that visits no anchor and has no sample in the window', async () => {
    const fallbacks = await routes(
      'unplaced',
      [
        [36000, 40000],
        [37000, 39000],
      ],
      [['HG006#1'], ['HG006#1', 'HG002#2']],
    )
    expect(fallbacks.every(f => f === undefined)).toBe(true)
  })

  it('identifies every walk, that contig among them, with a haplotype index that has no stray rows', async () => {
    const db = await open('unplaced')
    Object.defineProperty(db, 'haplotypeStrayOptions', {
      value: () => Promise.resolve(undefined),
    })
    const kept = await db.subgraphInInterval({
      path: chr1,
      start: 36000,
      end: 40000,
      context: 100,
      keep: name => name.sample === 'HG006',
    })
    expect(kept.stats.keep?.fallback).toMatch(/no stray rows/)
    const gfa = await kept.toGFA({ names: 'resolved' })
    expect(gfa).toContain('\tctg1\t')
    expect(gfa).toContain('\tctg2\t')
  })
})
