import { existsSync } from 'node:fs'

import { LocalFile, RemoteFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { checkResolvedRecordAgainstSamples } from './walkBack.ts'
import { GBZBase } from '../src/db.ts'
import { subgraphForHaplotypes, subgraphInInterval } from '../src/query.ts'

import type { PathName } from '../src/pathName.ts'

const graphUrl =
  'https://s3-us-west-2.amazonaws.com/human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/v2.1/hprc-v2.1-mc-grch38/hprc-v2.1-mc-grch38.gbz.db'
const hostedIndex =
  'https://jbrowse.org/demos/hprc/hprc-v2.1-mc-grch38.haplotype-index.anchored.db'
const companion = process.env.GBZ_HPRC_INDEX ?? hostedIndex
const anchoredCompanion = process.env.GBZ_HPRC_ANCHORED_INDEX ?? hostedIndex

const isRemote = (file: string) => /^https?:\/\//.test(file)
const available = (file: string) => isRemote(file) || existsSync(file)

function openHprc(index = companion) {
  return GBZBase.open(new RemoteFile(graphUrl), {
    haplotypeIndex: isRemote(index)
      ? new RemoteFile(index)
      : new LocalFile(index),
  })
}

const eight = [
  'HG00097#1',
  'HG00099#1',
  'HG00128#1',
  'HG00133#1',
  'HG01109#1',
  'HG01123#1',
  'HG01960#1',
  'HG02055#1',
]
const keepEight = (name: PathName) =>
  eight.includes(`${name.sample}#${name.haplotype}`)

describe.skipIf(!available(companion))('the published HPRC v2.1 graph', () => {
  it('names the AMY1 window without scanning the companion across id gaps', async () => {
    const db = await openHprc()
    const subgraph = await subgraphInInterval(
      db,
      { sample: 'GRCh38', contig: 'chr1' },
      103690000,
      103780000,
      { context: 1000, snarls: 'contained' },
    )
    await subgraph.identifyPaths()
    const alignments = subgraph.alignments()
    expect(subgraph.nodeCount).toBe(12240)
    expect(alignments.length).toBe(1362)
    expect(alignments.every(a => a.resolved)).toBe(true)
    const haplotypes = new Set(
      alignments.flatMap(a => (a.resolved ? [a.pathHandle] : [])),
    )
    expect(haplotypes.size).toBe(490)
    const { scans, windowSamples, chains } = subgraph.stats.identification
    expect(scans.length).toBe(5)
    expect(windowSamples).toBeLessThan(16000)
    expect(chains.reduce((n, c) => n + c.fragments, 0)).toBe(1912)
    expect(db.index?.pager.bytesFetched).toBeLessThan(4 * 1024 * 1024)
    for (const alignment of alignments) {
      if (alignment.resolved) {
        let query = 0
        let reference = 0
        for (const [, len, op] of alignment.cigar.matchAll(/(\d+)([MID])/g)) {
          query += op === 'D' ? 0 : Number(len)
          reference += op === 'I' ? 0 : Number(len)
        }
        expect(alignment.hapEnd - alignment.hapStart).toBe(query)
        expect(alignment.refEnd - alignment.refStart).toBe(reference)
      }
    }
  }, 120000)
})

describe.skipIf(!available(anchoredCompanion))(
  'the anchored companion for the published HPRC v2.1 graph',
  () => {
    it('returns the sampled route’s walks for the tutorial’s eight haplotypes at KIV-2, AMY1 and MHC class II', async () => {
      const db = await openHprc(anchoredCompanion)
      expect(await db.haplotypeAnchorSpacing()).toBeDefined()
      // An index with stray rows answers all three on the keep route, AMY1
      // included, where HG01243#2's contig JAHEOX020000063.1 starts inside the
      // window and passes it again in reverse 500 kb later. An index built
      // before them identifies every walk.
      const strays = (await db.haplotypeStrayOptions()) !== undefined
      const windows: [string, number, number][] = [
        ['chr6', 160616002, 160646753],
        ['chr1', 103690000, 103780000],
        ['chr6', 32510000, 32600000],
      ]
      for (const [contig, start, end] of windows) {
        const query = { sample: 'GRCh38', contig }
        const opts = {
          context: 1000,
          snarls: 'contained' as const,
          keep: keepEight,
        }
        const subgraph = await subgraphForHaplotypes(
          db,
          query,
          start,
          end,
          opts,
        )
        if (strays) {
          expect(subgraph.stats.keep?.fallback).toBeUndefined()
          expect(subgraph.stats.identification.chains).toEqual([])
        } else {
          expect(subgraph.stats.keep?.fallback).toMatch(/no stray rows/)
        }
        const sampled = await subgraphInInterval(db, query, start, end, opts)
        await sampled.identifyPaths()
        sampled.keepHaplotypes(keepEight)
        expect(await subgraph.toGFA({ names: 'resolved' })).toBe(
          await sampled.toGFA({ names: 'resolved' }),
        )
        expect(subgraph.alignments()).toEqual(sampled.alignments())
        const alignments = subgraph.alignments()
        const haplotypes = new Set(
          alignments.map(a =>
            a.resolved ? `${a.name.sample}#${a.name.haplotype}` : '',
          ),
        )
        expect([...haplotypes].sort()).toEqual(eight)
        for (const alignment of alignments) {
          const check = await checkResolvedRecordAgainstSamples(db, alignment)
          expect(check.sampleOrientation).toBe(
            alignment.strand === '+' ? 'forward' : 'reverse',
          )
          expect(check.bpBefore).toBe(check.claimedBefore)
          expect(check.hapLen).toBe(check.consumed.query)
          expect(check.refLen).toBe(check.consumed.reference)
        }
      }
    }, 300000)
  },
)
