import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LocalFile, RemoteFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { checkResolvedRecordAgainstSamples } from './walkBack.ts'
import { GBZBase } from '../src/db.ts'
import { subgraphForHaplotypes, subgraphInInterval } from '../src/query.ts'

import type { PathName } from '../src/pathName.ts'

const graphUrl =
  'https://s3-us-west-2.amazonaws.com/human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/v2.1/hprc-v2.1-mc-grch38/hprc-v2.1-mc-grch38.gbz.db'
const companion =
  process.env.GBZ_HPRC_INDEX ??
  path.join(
    os.homedir(),
    'src',
    'hprc-gbz',
    'hprc-v2.1-mc-grch38.haplotype-index.db',
  )

const anchoredCompanion =
  process.env.GBZ_HPRC_ANCHORED_INDEX ??
  path.join(
    os.homedir(),
    'src',
    'hprc-gbz',
    'hprc-v2.1-mc-grch38.haplotype-index.anchored.db',
  )

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
    expect(alignments.length).toBe(1395)
    expect(alignments.every(a => a.resolved)).toBe(true)
    const haplotypes = new Set(
      alignments.flatMap(a => (a.resolved ? [a.pathHandle] : [])),
    )
    expect(haplotypes.size).toBe(490)
    const { scans, windowSamples, chains } = subgraph.stats.identification
    expect(scans.length).toBe(5)
    expect(windowSamples).toBeLessThan(10000)
    expect(chains.reduce((n, c) => n + c.fragments, 0)).toBe(1912)
    expect(db.index.pager.bytesFetched).toBeLessThan(4 * 1024 * 1024)
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
    it('walks the tutorial’s eight haplotypes at KIV-2, AMY1 and MHC class II from the anchors, never falling back', async () => {
      const db = await openHprc(anchoredCompanion)
      expect(await db.haplotypeAnchorSpacing()).toBe(131072)
      const windows: [string, number, number][] = [
        ['chr6', 160616002, 160646753],
        ['chr1', 103690000, 103780000],
        ['chr6', 32510000, 32600000],
      ]
      for (const [contig, start, end] of windows) {
        const subgraph = await subgraphForHaplotypes(
          db,
          { sample: 'GRCh38', contig },
          start,
          end,
          { context: 1000, snarls: 'contained', keep: keepEight },
        )
        const stats = subgraph.stats.anchorWalk!
        expect(stats.fallback).toBeUndefined()
        expect(stats.walks.every(w => w.end === 'through the window')).toBe(
          true,
        )
        expect(subgraph.stats.identification.chains).toEqual([])
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
