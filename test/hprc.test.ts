import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LocalFile, RemoteFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { subgraphInInterval } from '../src/query.ts'

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

describe.skipIf(!existsSync(companion))('the published HPRC v2.1 graph', () => {
  it('names the AMY1 window without scanning the companion across id gaps', async () => {
    const db = await GBZBase.open(new RemoteFile(graphUrl), {
      haplotypeIndex: new LocalFile(companion),
    })
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
    expect(alignments.length).toBe(1912)
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
    for (const alignment of alignments.filter((_, i) => i % 97 === 0)) {
      if (alignment.resolved) {
        let pathLen = 0
        for (const handle of alignment.path) {
          pathLen += (await db.getRecord(handle))?.sequenceLen ?? 0
        }
        expect(alignment.hapEnd - alignment.hapStart).toBe(pathLen)
      }
    }
  }, 120000)
})
