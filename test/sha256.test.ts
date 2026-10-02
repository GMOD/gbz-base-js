import { createHash } from 'node:crypto'
import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { sha256 } from '../src/sha256.ts'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('sha256', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('matches node:crypto across the padding boundaries', () => {
    let seed = 1
    for (const length of [
      0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 100_000,
    ]) {
      const bytes = Uint8Array.from({ length }, () => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed >> 16
      })
      expect(hex(sha256(bytes))).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      )
    }
  })

  it('names a GFA the same way without crypto.subtle', async () => {
    const db = await GBZBase.open({
      source: new LocalFile(
        path.join(import.meta.dirname, 'data', 'micb-kir3dl1.gbz.db'),
      ),
    })
    const subgraph = await db.subgraphInInterval({
      path: 'GRCh38#0#chr6',
      start: 31500000,
      end: 31501000,
      context: 100,
    })
    const secure = await subgraph.toGFA()
    vi.stubGlobal('crypto', {})
    expect(await subgraph.toGFA()).toBe(secure)
    expect(secure).toMatch(/\nH\tNM:Z:[0-9a-f]{64}\n/)
  })
})
