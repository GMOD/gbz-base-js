import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { dataDir } from './fixtures.ts'
import { GBZBase } from '../src/db.ts'

import type { PathName } from '../src/pathName.ts'

const chr1 = { sample: 'GRCh38', contig: 'chr1' }

// Graphs that test/fuzz generated and a query on each that returned a wrong
// answer.
describe('cases the fuzzer found', () => {
  // reverse-reference.gfa: the reference runs <1>2<3, so its walk through a
  // window on node 2 starts on a reverse handle, and its twin >3<2>1 starts
  // on a forward one.
  it('finds a reference walk that starts on a reverse handle before the window', async () => {
    const db = await GBZBase.open({
      source: new LocalFile(path.join(dataDir, 'reverse-reference.gbz.db')),
    })
    const subgraph = await db.subgraphInInterval({
      path: chr1,
      start: 12,
      end: 18,
      context: 10,
    })
    expect(subgraph.nodeCount).toBe(3)
    expect(subgraph.referenceInterval).toMatchObject({ start: 0, end: 30 })
  })

  // stray-end.gfa: a junction pulls node 150 into a window at 15,498. HG002#1
  // passes that node 4,767 bp along its second fragment, in a stray row of one
  // visit that starts where the walk from the anchor before it stops.
  it('walks a stray row whose last visit starts where an earlier walk stopped', async () => {
    const db = await GBZBase.open({
      source: new LocalFile(path.join(dataDir, 'stray-end.gbz.db')),
      haplotypeIndex: new LocalFile(
        path.join(dataDir, 'stray-end.haplotype-index.db'),
      ),
    })
    const keep = (name: PathName) =>
      name.sample === 'HG002' && name.haplotype === 1
    const kept = await db.subgraphInInterval({
      path: chr1,
      start: 15498,
      end: 15870,
      context: 1,
      keep,
    })
    const sampled = await db.subgraphInInterval({
      path: chr1,
      start: 15498,
      end: 15870,
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
    const db = await GBZBase.open({
      source: new LocalFile(path.join(dataDir, 'anchor-at-bound.gbz.db')),
      haplotypeIndex: new LocalFile(
        path.join(dataDir, 'anchor-at-bound.haplotype-index.db'),
      ),
    })
    const keep = (name: PathName) => name.sample === 'HG001'
    const kept = await db.subgraphInInterval({
      path: chr1,
      start: 3800,
      end: 3900,
      context: 100,
      keep,
    })
    const sampled = await db.subgraphInInterval({
      path: chr1,
      start: 3800,
      end: 3900,
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

// keep-bounds.gfa, hand-written: anchors every 1,000 bp, bins of 2,000, a
// bound of 1,000 and a stray context of 1. Each haplotype is a short contig
// with no other walk near the piece under test, and the index has no sample of
// that piece in either orientation, so a walk that the keep route skips at a
// boundary leaves the piece out of the result instead of falling back.
describe('the boundaries of the keep route', () => {
  const keptSpans = async (
    sample: string,
    start: number,
    end: number,
    context: number,
  ) => {
    const db = await GBZBase.open({
      source: new LocalFile(path.join(dataDir, 'keep-bounds.gbz.db')),
      haplotypeIndex: new LocalFile(
        path.join(dataDir, 'keep-bounds.haplotype-index.db'),
      ),
    })
    const keep = (name: PathName) => name.sample === sample
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
    expect(kept.stats.keep?.fallback).toBeUndefined()
    expect(await kept.toGFA({ names: 'resolved' })).toBe(
      await sampled.toGFA({ names: 'resolved' }),
    )
    return kept
      .alignments()
      .map(a => (a.resolved ? `${a.hapStart}-${a.hapEnd}` : ''))
  }

  // The window's bin starts at 16,000, where node 19 starts and anchors
  // 17,000. HG003 runs node 18, the anchor of 16,000, then node 20 at
  // 17,000-17,500, then node 19, so its section's high anchor starts exactly
  // at the bins.
  it('walks a section whose high anchor starts exactly at the bins', async () => {
    expect(await keptSpans('HG003', 17200, 17300, 0)).toEqual(['1000-1500'])
  })

  // Node 28 starts at 23,999, one base before the window's bin ends, and
  // anchors 24,000. HG004 runs node 28, then node 27 at 23,000-23,999, then
  // node 29, the anchor of 25,000, so its section's low anchor lies one base
  // inside the bins.
  it('walks a section whose low anchor starts one base before the bins end', async () => {
    expect(await keptSpans('HG004', 23400, 23500, 0)).toEqual(['501-1500'])
  })

  // Node 8 anchors 8,000 and starts at 7,000, exactly the bound before the
  // window's bin. HG001 visits node 8 at 2,000 along its contig and the 1 bp
  // window node 10 exactly the bound before and after that, between visits to
  // node 7, the anchor of 7,000. Only the walk around the visit to node 8
  // reaches node 10, and only when both of its ends are inclusive.
  it('walks exactly the bound to each side of an anchor visit the bound before the bins', async () => {
    expect(await keptSpans('HG001', 8200, 8201, 0)).toEqual([
      '1000-1001',
      '3000-3001',
    ])
  })

  // HG002 runs nodes 7 and 8 to 2,000 along its contig, then a 1 bp node,
  // then node 50 at 2,001, a neighbour of window node 10 past HG002's last
  // anchor visit, so in a stray row. Node 51 after it neighbours no node of
  // the bin, so the row ends at 2,001, one base past where the walk around
  // the visit to node 8 reaches.
  it('walks a stray row that ends one base past a walk around an anchor visit', async () => {
    expect(await keptSpans('HG002', 8200, 8201, 1)).toEqual([
      '0-2000',
      '2001-2051',
    ])
  })

  // HG005 runs node 48, 1 bp and a neighbour of the window's first bin, then
  // node 49 at 1, a neighbour of the second bin alone, then node 52, a
  // neighbour of neither. Each of the first two visits makes a stray row of
  // its bin, and the walk of the first row reaches 1, one base short of where
  // the second ends.
  it('walks a stray row that ends one base past the row walked before it', async () => {
    expect(await keptSpans('HG005', 31950, 32050, 1)).toEqual(['1-101'])
  })
})
