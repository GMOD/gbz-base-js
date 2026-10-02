import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'

const chr20 =
  process.env.GBZ_CHR20_DB ??
  path.join(os.homedir(), 'src', 'hprc-chr20.gbz.db')
const chr20Index =
  process.env.GBZ_CHR20_INDEX ??
  path.join(os.homedir(), 'src', 'hprc-chr20.haplotype-index.db')
const chm13 = 'CHM13#0#chr20'

function openChr20() {
  return GBZBase.open({
    source: new LocalFile(chr20),
    haplotypeIndex: new LocalFile(chr20Index),
  })
}

describe.skipIf(!existsSync(chr20) || !existsSync(chr20Index))(
  'a reference stored in fragments',
  () => {
    it('bounds every fragment by the length the haplotype index recorded', async () => {
      const db = await openChr20()
      const fragments = await db.getPathFragments({
        path: chm13,
        start: 0,
        end: 100_000_000,
      })
      expect(fragments.map(f => f.start)).toEqual([
        100864, 29927279, 30368374, 30835230, 31839593, 32887477, 49663956,
      ])
      for (const fragment of fragments) {
        expect(fragment.end - fragment.start).toBe(
          await db.haplotypeLength(fragment.path.handle),
        )
      }
      fragments.slice(1).forEach((fragment, i) => {
        expect(fragment.start).toBeGreaterThan(fragments[i]!.end)
      })
    })

    it('measures a fragment the same way without the haplotype index', async () => {
      const db = await openChr20()
      const withoutIndex = await openChr20()
      Object.defineProperty(withoutIndex, 'hasHaplotypeIndex', { value: false })
      for (const fragment of await db.getPathFragments({
        path: chm13,
        start: 0,
        end: 1e9,
      })) {
        expect(await withoutIndex.pathLength(fragment.path.handle)).toBe(
          fragment.end - fragment.start,
        )
      }
    })

    it('spans a fragment boundary by concatenating the per-fragment answers', async () => {
      const db = await openChr20()
      const [a, b] = await db.getPathFragments({
        path: chm13,
        start: 30_000_000,
        end: 30_400_000,
      })
      const start = a!.end - 2000
      const end = b!.start + 2000
      const spanned = await db.getAlignments({
        path: chm13,
        start,
        end,
        context: 0,
      })
      const separate = [
        ...(await db.getAlignments({
          path: chm13,
          start,
          end: a!.end,
          context: 0,
        })),
        ...(await db.getAlignments({
          path: chm13,
          start: b!.start,
          end,
          context: 0,
        })),
      ]
      expect(spanned.length).toBeGreaterThan(separate.length / 2)
      expect(spanned).toEqual(separate)
      expect(spanned.every(alignment => alignment.resolved)).toBe(true)
      const [subgraph] = await db.getSubgraphs({
        path: chm13,
        start,
        end,
        context: 0,
      })
      expect(subgraph?.referenceInterval?.end).toBe(a!.end)
    })

    it('aligns haplotypes to a reference walk stored against node orientation', async () => {
      const db = await openChr20()
      const start = 30368374
      const fromChm13 = await db.getAlignments({
        path: chm13,
        start,
        end: start + 300,
        context: 0,
      })
      expect(fromChm13.length).toBeGreaterThan(50)
      expect(fromChm13.every(a => a.refEnd > a.refStart)).toBe(true)
      expect(fromChm13.every(a => a.cigar.includes('M'))).toBe(true)
      const grch38 = fromChm13.find(
        a => a.resolved && a.name.sample === 'GRCh38',
      )
      expect(grch38?.resolved && grch38.strand).toBe('-')
      expect(grch38?.cigar).toBe('395M')
      if (grch38?.resolved) {
        const fromGrch38 = await db.getAlignments({
          path: 'GRCh38#0#chr20',
          start: grch38.hapStart,
          end: grch38.hapEnd,
          context: 0,
        })
        const seenBack = fromGrch38.filter(
          a => a.resolved && a.name.sample === 'CHM13',
        )
        expect(seenBack.map(a => [a.strand, a.cigar])).toEqual([['-', '395M']])
      }
    })

    it('answers nothing inside the gap between two fragments', async () => {
      const db = await openChr20()
      const [a, b] = await db.getPathFragments({
        path: chm13,
        start: 30_000_000,
        end: 30_400_000,
      })
      const middle = Math.floor((a!.end + b!.start) / 2)
      expect(
        await db.getAlignments({
          path: chm13,
          start: middle,
          end: middle + 100,
        }),
      ).toEqual([])
      expect(
        await db.getSubgraphs({
          path: chm13,
          start: middle,
          end: middle + 100,
        }),
      ).toEqual([])
    })
  },
)
