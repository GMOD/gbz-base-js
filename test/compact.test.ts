import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { isReverse, nodeId } from '../src/gbwt/node.ts'
import { subgraphInInterval } from '../src/query.ts'
import { compactSubgraphTransferables } from '../src/subgraph.ts'

const dataDir = path.join(import.meta.dirname, 'data')
const micb = path.join(dataDir, 'micb-kir3dl1.gbz.db')
const window = { sample: 'GRCh38', contig: 'chr6' }

async function subgraph() {
  const db = await GBZBase.open(new LocalFile(micb))
  return subgraphInInterval(db, window, 31500000, 31501000, { context: 100 })
}

describe('toCompactSubgraph', () => {
  it('lists node ids ascending, with sequences beside them', async () => {
    const compact = (await subgraph()).toCompactSubgraph()
    const ids = [...compact.nodeIds]
    expect(ids.length).toBeGreaterThan(0)
    expect(compact.nodeSequences).toHaveLength(ids.length)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(compact.nodeSequences.every(seq => /^[ACGTN]+$/.test(seq))).toBe(
      true,
    )
  })

  it('encodes steps as handles the node helpers read back', async () => {
    const sg = await subgraph()
    const compact = sg.toCompactSubgraph()
    const json = sg.toSubgraphJson()
    compact.paths.forEach((path, i) => {
      const expected = json.paths[i]!.path
      expect(path.steps).toHaveLength(expected.length)
      ;[...path.steps].forEach((handle, j) => {
        expect(String(nodeId(handle))).toBe(expected[j]!.id)
        expect(isReverse(handle)).toBe(expected[j]!.is_reverse)
      })
    })
  })

  it('pairs edge endpoints end to end', async () => {
    const compact = (await subgraph()).toCompactSubgraph()
    expect(compact.edges.length % 2).toBe(0)
    const ids = new Set(compact.nodeIds)
    for (const handle of compact.edges) {
      expect(ids.has(nodeId(handle))).toBe(true)
    }
  })

  it('carries a CIGAR only when asked', async () => {
    const sg = await subgraph()
    expect(sg.toCompactSubgraph().paths.every(p => p.cigar === undefined)).toBe(
      true,
    )
    const withCigar = sg.toCompactSubgraph({ cigar: true })
    expect(withCigar.paths[0]!.cigar).toBeUndefined()
    for (const path of withCigar.paths.slice(1)) {
      expect(path.cigar).toMatch(/^[0-9MID]+$/)
    }
  })

  it('names the reference walk first, then the haplotypes', async () => {
    const compact = (await subgraph()).toCompactSubgraph()
    expect(compact.paths[0]!.name).toMatch(/^GRCh38#0#chr6\[/)
    expect(
      compact.paths.slice(1).every(p => p.name.startsWith('unknown#')),
    ).toBe(true)
  })

  it('survives a structured clone', async () => {
    const compact = (await subgraph()).toCompactSubgraph({ cigar: true })
    const cloned = structuredClone(compact)
    expect([...cloned.nodeIds]).toEqual([...compact.nodeIds])
    expect([...cloned.paths[1]!.steps]).toEqual([...compact.paths[1]!.steps])
    expect(cloned.paths[1]!.cigar).toBe(compact.paths[1]!.cigar)
  })

  it('offers every buffer it owns as a transferable', async () => {
    const compact = (await subgraph()).toCompactSubgraph()
    const buffers = compactSubgraphTransferables(compact)
    expect(buffers).toHaveLength(compact.paths.length + 2)
    expect(new Set(buffers).size).toBe(buffers.length)
    expect(buffers).toContain(compact.nodeIds.buffer)
    expect(buffers).toContain(compact.edges.buffer)
  })
})
