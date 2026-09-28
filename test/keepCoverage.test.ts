import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { subgraphForHaplotypes, subgraphInInterval } from '../src/query.ts'

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
const dataDir = path.join(import.meta.dirname, 'data')

function open(fixture: string) {
  return GBZBase.open(new LocalFile(path.join(dataDir, `${fixture}.gbz.db`)), {
    haplotypeIndex: new LocalFile(
      path.join(dataDir, `${fixture}.haplotype-index.db`),
    ),
  })
}

async function routes(
  fixture: string,
  windows: [number, number][],
  keepSets: string[][],
  strays: boolean,
) {
  const db = await open(fixture)
  if (!strays) {
    Object.defineProperty(db, 'haplotypeStrayContext', {
      value: () => undefined,
    })
  }
  const chr1 = { sample: 'GRCh38', contig: 'chr1' }
  const fallbacks: (string | undefined)[] = []
  for (const [start, end] of windows) {
    for (const context of [0, 100, 1000]) {
      for (const set of keepSets) {
        const keep = (name: PathName) =>
          set.includes(`${name.sample}#${name.haplotype}`)
        const kept = await subgraphForHaplotypes(db, chr1, start, end, {
          context,
          keep,
        })
        const sampled = await subgraphInInterval(db, chr1, start, end, {
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
  const twoCopies = (strays: boolean) =>
    routes(
      'two-copies',
      [
        [36000, 40000],
        [37000, 39000],
      ],
      [['HG001#2'], ['HG002#1'], ['HG002#2'], ['HG001#2', 'HG002#1']],
      strays,
    )

  it('identifies every walk when a path visits an anchor from two copies of the region', async () => {
    const fallbacks = await twoCopies(false)
    expect(fallbacks.every(f => f?.includes('copies of the region'))).toBe(true)
  })

  it('walks both copies of the region from the stray rows', async () => {
    const fallbacks = await twoCopies(true)
    expect(fallbacks.every(f => f === undefined)).toBe(true)
  })

  it('walks as far past each visit as the sample check allows', async () => {
    for (const strays of [false, true]) {
      const fallbacks = await routes(
        'far-pass',
        [
          [36000, 40000],
          [37000, 39000],
        ],
        [['HG001#1'], ['HG002#2'], ['HG004#1'], ['HG001#1', 'HG004#1']],
        strays,
      )
      expect(fallbacks.every(f => f === undefined)).toBe(true)
    }
  })

  it('walks a fragment of a chosen contig that lies between the anchors', async () => {
    for (const strays of [false, true]) {
      const fallbacks = await routes(
        'far-pass',
        [[55000, 56500]],
        [['HG005#1'], ['HG005#1', 'HG002#2']],
        strays,
      )
      expect(fallbacks.every(f => f === undefined)).toBe(true)
    }
  })
})
