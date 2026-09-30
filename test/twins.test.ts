import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { dataDir } from './fixtures.ts'
import { GBZBase } from '../src/db.ts'
import { subgraphForHaplotypes, subgraphInInterval } from '../src/query.ts'

import type { PathName } from '../src/pathName.ts'

// reverse-reference.gfa: GRCh38 runs <1>2<3 and CHM13 >2<1, so each reference
// walk through its window starts or ends on a reverse handle and its twin is
// the canonical orientation, kept as a walk like any other. HG002#1 is stored
// against GRCh38 as >3<2>1, the twin's handles, and HG002#2 walks <1>2<3 as
// GRCh38 does.
const open = (index = 'reverse-reference.haplotype-index.db') =>
  GBZBase.open(new LocalFile(path.join(dataDir, 'reverse-reference.gbz.db')), {
    haplotypeIndex: new LocalFile(path.join(dataDir, index)),
  })

const grch38 = 'GRCh38#0#chr1'
const chm13 = 'CHM13#0#chr1'
const haplotype = (name: PathName) => `${name.sample}#${name.haplotype}`
const walks = (gfa: string) =>
  gfa
    .split('\n')
    .filter(line => line.startsWith('W\t'))
    .map(line => line.split('\t').slice(1).join('\t'))

describe('the twin of a reference walk that is not canonical', () => {
  it('is not a haplotype record', async () => {
    const db = await open()
    const records = await db.getAlignmentsForRange(grch38, 12, 18, {
      context: 10,
    })
    expect(
      records.map(r => (r.resolved ? `${haplotype(r.name)} ${r.strand}` : '?')),
    ).toEqual(['CHM13#0 +', 'HG002#1 -', 'HG002#2 +'])
    const other = await db.getAlignmentsForRange(chm13, 0, 20, { context: 10 })
    expect(other.map(r => (r.resolved ? haplotype(r.name) : '?'))).toEqual([
      'GRCh38#0',
      'HG002#1',
      'HG002#2',
    ])
  })

  it('is not a W line on either route', async () => {
    const db = await open()
    const sampled = await db.getSubgraphForRange(grch38, 12, 18, {
      context: 10,
    })
    expect(walks(await sampled!.toGFA({ names: 'resolved' }))).toEqual([
      'GRCh38\t0\tchr1\t0\t30\t<1>2<3',
      'CHM13\t0\tchr1\t0\t20\t>2<1',
      'HG002\t1\tctg1\t0\t30\t>3<2>1',
      'HG002\t2\tctg1\t0\t30\t<1>2<3',
    ])
    const keep = (name: PathName) => name.sample === 'GRCh38'
    const kept = await subgraphForHaplotypes(
      db,
      { sample: 'GRCh38', contig: 'chr1' },
      12,
      18,
      { context: 10, keep },
    )
    expect(kept.stats.keep?.fallback).toBeUndefined()
    expect(walks(await kept.toGFA({ names: 'resolved' }))).toEqual([
      'GRCh38\t0\tchr1\t0\t30\t<1>2<3',
    ])
    const narrowed = await subgraphInInterval(
      db,
      { sample: 'GRCh38', contig: 'chr1' },
      12,
      18,
      { context: 10 },
    )
    await narrowed.identifyPaths()
    narrowed.keepHaplotypes(keep)
    expect(await narrowed.toGFA({ names: 'resolved' })).toBe(
      await kept.toGFA({ names: 'resolved' }),
    )
  })

  it('does not stand for the haplotypes that share its walk under distinct', async () => {
    const db = await open()
    const subgraph = await db.getSubgraphForRange(grch38, 12, 18, {
      context: 10,
      haplotypes: 'distinct',
    })
    expect(walks(await subgraph!.toGFA({ names: 'resolved' }))).toEqual([
      'GRCh38\t0\tchr1\t0\t30\t<1>2<3\tWT:i:1',
      'CHM13\t0\tchr1\t0\t20\t>2<1\tWT:i:1',
      'HG002\t1\tctg1\t0\t30\t>3<2>1\tWT:i:2',
    ])
    const records = await db.getAlignmentsForRange(grch38, 12, 18, {
      context: 10,
      haplotypes: 'distinct',
    })
    expect(
      records.map(r => (r.resolved ? `${haplotype(r.name)} ${r.weight}` : '?')),
    ).toEqual(['CHM13#0 1', 'HG002#1 2'])
  })
})

describe('the reference walk under distinct', () => {
  it('keeps its own identity, so pairAlignments can take it as the target', async () => {
    const db = await GBZBase.open(
      new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
      {
        haplotypeIndex: new LocalFile(
          path.join(dataDir, 'micb-kir3dl1.haplotype-index.db'),
        ),
      },
    )
    const target = { sample: 'GRCh38', haplotype: 0 }
    const all = await db.getSubgraphForRange(
      'GRCh38#0#chr6',
      31500000,
      31501000,
    )
    const distinct = await db.getSubgraphForRange(
      'GRCh38#0#chr6',
      31500000,
      31501000,
      { haplotypes: 'distinct' },
    )
    const against = (pairs: { query: PathName }[]) =>
      new Set(pairs.map(pair => haplotype(pair.query)))
    expect(all!.pairAlignments({ target }).length).toBeGreaterThan(0)
    expect(against(distinct!.pairAlignments({ target })).size).toBe(
      distinct!.pathCount - 1,
    )
    expect(distinct!.pairAlignments({ target }).length).toBeLessThan(
      all!.pairAlignments({ target }).length,
    )
  })
})

// stray-end.gfa: HG005#2 and HG001#1 each walk into a hairpin, so a walk
// starts and ends at one node in opposite orientations, and extractPaths
// keeps it in both orientations.
describe('a walk through a hairpin', () => {
  const openStrayEnd = () =>
    GBZBase.open(new LocalFile(path.join(dataDir, 'stray-end.gbz.db')), {
      haplotypeIndex: new LocalFile(
        path.join(dataDir, 'stray-end.haplotype-index.db'),
      ),
    })
  const label = (record: { resolved: boolean; label?: string }) =>
    record.resolved ? record.label : '?'

  it('is one record, aligned in whichever orientation shares more sequence', async () => {
    const db = await openStrayEnd()
    const records = await db.getAlignmentsForRange(grch38, 8554, 20452, {
      context: 17,
    })
    const hg001 = records.filter(
      r => r.resolved && haplotype(r.name) === 'HG001#1',
    )
    expect(new Set(hg001.map(label)).size).toBe(hg001.length)
    const hairpin = hg001.find(r => label(r) === 'HG001#1#ctg1[13005-18984]')
    expect(hairpin).toMatchObject({ strand: '-', cigar: '550I40M46I5343M' })
    const kept = await db.getAlignmentsForRange(grch38, 8554, 20452, {
      context: 17,
      keep: name => haplotype(name) === 'HG001#1',
    })
    expect(kept.map(r => [label(r), r.strand, r.cigar])).toEqual(
      hg001.map(r => [label(r), r.strand, r.cigar]),
    )
  })

  it('counts once under distinct', async () => {
    const db = await openStrayEnd()
    const records = await db.getAlignmentsForRange(chm13, 16459, 27264, {
      context: 17,
      haplotypes: 'distinct',
    })
    const hg005 = records.filter(
      r => r.resolved && haplotype(r.name) === 'HG005#2',
    )
    expect(hg005.map(r => `${label(r)} ${r.weight}`)).toEqual([
      'HG005#2#ctg1[12777-19189] 1',
      'HG005#2#ctg1[5580-12146] 1',
    ])
  })
})
