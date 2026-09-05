import path from 'node:path'
import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import type { ByteSource } from '../src/filehandle.ts'
import { subgraphInInterval } from '../src/query.ts'

class CountingSource implements ByteSource {
  requests: [number, number][] = []

  constructor(private inner: LocalFile) {}

  read(length: number, position: number) {
    this.requests.push([position, length])
    return this.inner.read(length, position)
  }

  stat() {
    return this.inner.stat()
  }
}

describe('request pattern', () => {
  it('opens with a single read and answers a small query in a handful of block reads', async () => {
    const source = new CountingSource(new LocalFile(path.join(import.meta.dirname, 'data', 'micb-kir3dl1.gbz.db')))
    const db = await GBZBase.open(source, { blockSize: 16384 })
    expect(source.requests).toEqual([[0, 16384]])
    const subgraph = await subgraphInInterval(db, { sample: 'GRCh38', contig: 'chr6' }, 31500000, 31501000, { context: 0 })
    await subgraph.identifyPaths()
    expect(subgraph.alignments().length).toBeGreaterThan(0)
    expect(source.requests.length).toBeLessThan(12)
    expect(new Set(source.requests.map(([position]) => position)).size).toBe(source.requests.length)
  })
})
