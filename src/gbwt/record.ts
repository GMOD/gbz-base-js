import { ByteCodeReader, RunReader } from './bytecode.ts'
import { ENDMARKER, flipNode, nodeId } from './node.ts'

export interface Pos {
  node: number
  offset: number
}

export function decompressEdges(bytes: Uint8Array): Pos[] {
  const reader = new ByteCodeReader(bytes)
  const sigma = reader.int()
  if (sigma === undefined || sigma === 0) {
    return []
  }
  const edges: Pos[] = []
  let prev = 0
  for (let i = 0; i < sigma; i++) {
    const delta = reader.int()
    const offset = reader.int()
    if (delta === undefined || offset === undefined) {
      throw new Error('GBWT edge list ends early')
    }
    prev += delta
    edges.push({ node: prev, offset })
  }
  return edges
}

export class GbwtRecord {
  readonly edges: Pos[]
  readonly bwt: Uint8Array

  constructor(edges: Pos[], bwt: Uint8Array) {
    this.edges = edges
    this.bwt = bwt
  }

  runs() {
    return new RunReader(this.bwt, this.edges.length)
  }

  private edge(rank: number) {
    const edge = this.edges[rank]
    if (edge === undefined) {
      throw new Error(
        `GBWT run refers to edge rank ${rank} of ${this.edges.length}`,
      )
    }
    return edge
  }

  lf(i: number): Pos | undefined {
    const offsets = this.edges.map(e => e.offset)
    let offset = 0
    for (const run of this.runs()) {
      const edge = this.edge(run.value)
      const soFar = offsets[run.value]!
      if (offset + run.len > i) {
        return edge.node === ENDMARKER
          ? undefined
          : { node: edge.node, offset: soFar + (i - offset) }
      }
      offsets[run.value] = soFar + run.len
      offset += run.len
    }
    return undefined
  }

  private edgeTo(node: number) {
    let low = 0
    let high = this.edges.length
    while (low < high) {
      const mid = (low + high) >> 1
      const edge = this.edges[mid]!
      if (edge.node === node) {
        return mid
      }
      if (edge.node < node) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return undefined
  }

  offsetTo(pos: Pos): number | undefined {
    if (pos.node === ENDMARKER) {
      return undefined
    }
    const rank = this.edgeTo(pos.node)
    if (rank === undefined) {
      return undefined
    }
    let succRank = this.edges[rank]!.offset
    if (succRank > pos.offset) {
      return undefined
    }
    let offset = 0
    for (const run of this.runs()) {
      offset += run.len
      if (run.value !== rank) {
        continue
      }
      succRank += run.len
      if (succRank > pos.offset) {
        return offset - (succRank - pos.offset)
      }
    }
    return undefined
  }

  predecessorAt(i: number): number | undefined {
    const counts = this.edges.map(e => ({
      node: e.node === ENDMARKER ? ENDMARKER : flipNode(e.node),
      count: 0,
    }))
    for (const run of this.runs()) {
      const entry = counts[run.value]
      if (entry) {
        entry.count += run.len
      }
    }
    for (let rank = 1; rank < counts.length; rank++) {
      const prev = counts[rank - 1] as { node: number; count: number }
      const curr = counts[rank] as { node: number; count: number }
      if (nodeId(prev.node) === nodeId(curr.node)) {
        counts[rank - 1] = curr
        counts[rank] = prev
      }
    }
    let offset = 0
    for (const entry of counts) {
      offset += entry.count
      if (offset > i) {
        return entry.node === ENDMARKER ? undefined : entry.node
      }
    }
    return undefined
  }

  decompressArrays() {
    const offsets = this.edges.map(e => e.offset)
    let total = 0
    for (const run of this.runs()) {
      total += run.len
    }
    const nodes = new Int32Array(total)
    const nextOffsets = new Int32Array(total)
    let i = 0
    for (const run of this.runs()) {
      const edge = this.edge(run.value)
      let offset = offsets[run.value]!
      for (let k = 0; k < run.len; k++) {
        nodes[i] = edge.node
        nextOffsets[i] = offset
        offset += 1
        i += 1
      }
      offsets[run.value] = offset
    }
    return { nodes, offsets: nextOffsets }
  }

  decompress(): Pos[] {
    const offsets = this.edges.map(e => e.offset)
    const result: Pos[] = []
    for (const run of this.runs()) {
      const edge = this.edge(run.value)
      for (let k = 0; k < run.len; k++) {
        result.push({ node: edge.node, offset: offsets[run.value]! })
        offsets[run.value] = offsets[run.value]! + 1
      }
    }
    return result
  }
}
