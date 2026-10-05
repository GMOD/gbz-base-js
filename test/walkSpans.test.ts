import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { formatPathName } from '../src/pathName.ts'

const dataDir = path.join(import.meta.dirname, 'data')

describe('walkSpans', () => {
  it('names each walk the output names, with its span on its own path', async () => {
    const db = await GBZBase.open({
      source: new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
      haplotypeIndex: new LocalFile(
        path.join(dataDir, 'micb-kir3dl1.haplotype-index.db'),
      ),
    })
    const [subgraph] = await db.getSubgraphs({
      path: 'GRCh38#0#chr6',
      start: 31500000,
      end: 31501000,
      context: 100,
    })
    const spans = subgraph!.walkSpans()
    expect(spans.length).toBeGreaterThan(1)
    expect(spans.every(s => s.end > s.start)).toBe(true)
    const named = new Set(subgraph!.toCompactSubgraph().paths.map(p => p.name))
    for (const { name, start, end } of spans) {
      expect(named.has(formatPathName({ ...name, fragment: start, end }))).toBe(
        true,
      )
    }
  })
})
