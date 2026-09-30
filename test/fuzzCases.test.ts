import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { dataDir } from './fixtures.ts'
import { GBZBase } from '../src/db.ts'
import { subgraphForHaplotypes, subgraphInInterval } from '../src/query.ts'

import type { PathName } from '../src/pathName.ts'

const chr1 = { sample: 'GRCh38', contig: 'chr1' }

// Graphs that test/fuzz generated and a query on each that returned a wrong
// answer.
describe('cases the fuzzer found', () => {
  // reverse-reference.gfa: the reference runs <1>2<3, so its walk through a
  // window on node 2 starts on a reverse handle, and its twin >3<2>1 starts
  // on a forward one.
  it('finds a reference walk that starts on a reverse handle before the window', async () => {
    const db = await GBZBase.open(
      new LocalFile(path.join(dataDir, 'reverse-reference.gbz.db')),
    )
    const subgraph = await subgraphInInterval(db, chr1, 12, 18, { context: 10 })
    expect(subgraph.nodeCount).toBe(3)
    expect(subgraph.referenceInterval).toMatchObject({ start: 0, end: 30 })
  })

  // stray-end.gfa: a junction pulls node 150 into a window at 15,498. HG002#1
  // passes that node 4,767 bp along its second fragment, in a stray row of one
  // visit that starts where the walk from the anchor before it stops.
  it('walks a stray row whose last visit starts where an earlier walk stopped', async () => {
    const db = await GBZBase.open(
      new LocalFile(path.join(dataDir, 'stray-end.gbz.db')),
      {
        haplotypeIndex: new LocalFile(
          path.join(dataDir, 'stray-end.haplotype-index.db'),
        ),
      },
    )
    const keep = (name: PathName) =>
      name.sample === 'HG002' && name.haplotype === 1
    const kept = await subgraphForHaplotypes(db, chr1, 15498, 15870, {
      context: 1,
      keep,
    })
    const sampled = await subgraphInInterval(db, chr1, 15498, 15870, {
      context: 1,
    })
    await sampled.identifyPaths()
    sampled.keepHaplotypes(keep)
    expect(kept.stats.keep?.fallback).toBeUndefined()
    expect(await kept.toGFA({ names: 'resolved' })).toBe(
      await sampled.toGFA({ names: 'resolved' }),
    )
    const spans = kept
      .alignments()
      .map(a => (a.resolved ? `${a.hapStart}-${a.hapEnd}` : ''))
    expect(spans).toContain('18327-18877')
    expect(spans.length).toBe(4)
  })

  // anchor-at-bound.gfa, hand-written: with 500 bp anchors, bins of 1,000 and
  // a bound of 2,000, node 7 (600 bp, so the anchor for multiple 13 alone)
  // starts at 6,000, exactly the bound past the bin of a window in node 4.
  // The indexer counts HG001#1's visit to node 10, 600 bp along from node 7,
  // as reached by the section from anchor 13 to 14, so it has no stray row.
  // The reader used to stop reading anchors at 13 and never planned that
  // section, and no sample lay on node 10 to show the piece missing.
  it('reads the anchor past the one that starts exactly `bound` outside the bins', async () => {
    const db = await GBZBase.open(
      new LocalFile(path.join(dataDir, 'anchor-at-bound.gbz.db')),
      {
        haplotypeIndex: new LocalFile(
          path.join(dataDir, 'anchor-at-bound.haplotype-index.db'),
        ),
      },
    )
    const keep = (name: PathName) => name.sample === 'HG001'
    const kept = await subgraphForHaplotypes(db, chr1, 3800, 3900, {
      context: 100,
      keep,
    })
    const sampled = await subgraphInInterval(db, chr1, 3800, 3900, {
      context: 100,
    })
    await sampled.identifyPaths()
    sampled.keepHaplotypes(keep)
    expect(kept.stats.keep?.fallback).toBeUndefined()
    expect(kept.stats.keep?.anchorsRead).toBe(14)
    expect(await kept.toGFA({ names: 'resolved' })).toBe(
      await sampled.toGFA({ names: 'resolved' }),
    )
    const spans = kept
      .alignments()
      .map(a => (a.resolved ? `${a.hapStart}-${a.hapEnd}` : ''))
    expect(spans).toContain('6600-6800')
  })
})
