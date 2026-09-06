import { formatPathName } from './db.ts'
import {
  ENDMARKER,
  edgeIsCanonical,
  encodeNode,
  entryOrientation,
  entrySide,
  exitOrientation,
  exitSide,
  flipSide,
  isReverse,
  nodeId,
  nodeOrientation,
  pathIsCanonical,
} from './gbwt/node.ts'
import { weightedLcs } from './lcs.ts'

import type {
  GBZBase,
  GbzPath,
  GbzRecord,
  HaplotypeSample,
  PathName,
} from './db.ts'
import type { NodeSide, Orientation } from './gbwt/node.ts'
import type { Pos } from './gbwt/record.ts'

export type HaplotypeOutput = 'all' | 'distinct' | 'reference-only' | 'none'

export interface PathPosition {
  seqOffset: number
  handle: number
  nodeOffset: number
  gbwtOffset: number
}

export interface ReferencePath {
  position: PathPosition
  name: PathName
  handle: number
}

export interface PathIdentity {
  pathHandle: number
  name: PathName
  orientation: Orientation
  hapStart: number
  hapEnd: number
}

interface PathInfo {
  path: number[]
  positions: Pos[]
  len: number
  weight: number | undefined
  identity: PathIdentity | undefined
}

type EditOp = 'M' | 'I' | 'D'
type Edit = [EditOp, number]

export interface SubgraphPath {
  name: string
  weight?: number
  cigar?: string
  path: { id: string; is_reverse: boolean }[]
}

export interface SubgraphJson {
  nodes: { id: string; sequence: string }[]
  edges: {
    from: string
    from_is_reverse: boolean
    to: string
    to_is_reverse: boolean
  }[]
  paths: SubgraphPath[]
}

export interface HaplotypeAlignment {
  pathHandle: number | undefined
  name: PathName | undefined
  strand: '+' | '-'
  hapStart: number | undefined
  hapEnd: number | undefined
  refStart: number
  refEnd: number
  cigar: string
  weight: number | undefined
  path: number[]
  start: Pos
}

export interface ToJsonOptions {
  names?: 'anonymous' | 'resolved'
}

class SideQueue {
  private items: [number, number, NodeSide][] = []

  push(distance: number, node: number, side: NodeSide) {
    this.items.push([distance, node, side])
  }

  pop() {
    let best = 0
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i]!
      const b = this.items[best]!
      if (
        a[0] < b[0] ||
        (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))
      ) {
        best = i
      }
    }
    const [item] = this.items.splice(best, 1)
    return item
  }

  get size() {
    return this.items.length
  }
}

function posKey(pos: Pos) {
  return `${pos.node}:${pos.offset}`
}

interface Anchor {
  pathHandle: number
  orientation: Orientation
  base: number
}

export class Subgraph {
  private records = new Map<number, GbzRecord>()
  private paths: PathInfo[] = []
  private refId: number | undefined
  private refPath: PathName | undefined
  private refHandle: number | undefined
  private refInterval: [number, number] | undefined
  private refIndexCache: Map<number, number[]> | undefined
  private refPrefixCache: number[] | undefined
  limit: number | undefined
  readonly stats = {
    orderedAlignments: 0,
    lcsAlignments: 0,
    identificationSteps: 0,
    identificationFetches: 0,
  }

  private db: GBZBase

  constructor(db: GBZBase) {
    this.db = db
  }

  get nodeCount() {
    return this.records.size / 2
  }

  get pathCount() {
    return this.paths.length
  }

  get referenceInterval() {
    return this.refInterval && this.refPath
      ? {
          name: this.refPath,
          start: this.refPath.fragment + this.refInterval[0],
          end: this.refPath.fragment + this.refInterval[1],
        }
      : undefined
  }

  hasNode(id: number) {
    return this.records.has(encodeNode(id, 'forward'))
  }

  hasHandle(handle: number) {
    return this.records.has(handle)
  }

  private record(handle: number) {
    const record = this.records.get(handle)
    if (!record) {
      throw new Error(`Subgraph has no record for handle ${handle}`)
    }
    return record
  }

  private sortedHandles() {
    return [...this.records.keys()].sort((a, b) => a - b)
  }

  private async addNode(id: number) {
    if (this.limit !== undefined && this.nodeCount >= this.limit) {
      throw new Error(`Subgraph size limit of ${this.limit} nodes exceeded`)
    }
    const forward = await this.db.getRecord(encodeNode(id, 'forward'))
    const reverse = await this.db.getRecord(encodeNode(id, 'reverse'))
    if (!forward || !reverse) {
      throw new Error(`Node ${id} does not exist in the graph`)
    }
    this.records.set(forward.handle, forward)
    this.records.set(reverse.handle, reverse)
  }

  private async ensureNode(id: number) {
    if (!this.hasNode(id)) {
      await this.addNode(id)
    }
  }

  private clearPaths() {
    this.paths = []
    this.refId = undefined
    this.refPath = undefined
    this.refHandle = undefined
    this.refInterval = undefined
    this.refIndexCache = undefined
    this.refPrefixCache = undefined
  }

  async pathPosition(query: PathName): Promise<ReferencePath> {
    const path = await this.db.findPath(query)
    if (!path) {
      throw new Error(
        `Cannot find a path covering ${formatPathName(query, query.fragment)}`,
      )
    }
    if (!path.isIndexed) {
      throw new Error(
        `Path ${formatPathName(path.name, path.name.fragment)} has not been indexed for random access`,
      )
    }
    const queryOffset = query.fragment - path.name.fragment
    const indexed = await this.db.indexedPosition(path.handle, queryOffset)
    if (!indexed) {
      throw new Error(
        `Path ${formatPathName(path.name, path.name.fragment)} has not been indexed for random access`,
      )
    }
    return this.findPathPosition(
      path,
      queryOffset,
      indexed.pathOffset,
      indexed.pos,
    )
  }

  private async findPathPosition(
    path: GbzPath,
    queryOffset: number,
    startOffset: number,
    start: Pos,
  ): Promise<ReferencePath> {
    let pathOffset = startOffset
    let pos = start
    for (;;) {
      await this.ensureNode(nodeId(pos.node))
      const record = this.record(pos.node)
      if (pathOffset + record.sequenceLen > queryOffset) {
        return {
          position: {
            seqOffset: queryOffset,
            handle: pos.node,
            nodeOffset: queryOffset - pathOffset,
            gbwtOffset: pos.offset,
          },
          name: path.name,
          handle: path.handle,
        }
      }
      pathOffset += record.sequenceLen
      const next = record.gbwt().lf(pos.offset)
      if (!next) {
        throw new Error(
          `Path ${formatPathName(path.name, path.name.fragment)} does not contain offset ${queryOffset}`,
        )
      }
      pos = next
    }
  }

  async aroundPosition(handle: number, nodeOffset: number, context: number) {
    const id = nodeId(handle)
    await this.ensureNode(id)
    const record = this.record(handle)
    const orientation = nodeOrientation(handle)
    const active = new SideQueue()
    active.push(nodeOffset, id, entrySide(orientation))
    active.push(record.sequenceLen - nodeOffset - 1, id, exitSide(orientation))
    return this.insertContext(active, context)
  }

  async aroundInterval(start: PathPosition, len: number, context: number) {
    if (len === 0) {
      throw new Error('Interval length must be greater than 0')
    }
    let pos: Pos = { node: start.handle, offset: start.gbwtOffset }
    let offset = start.nodeOffset
    let remaining = len
    const active = new SideQueue()
    for (;;) {
      const id = nodeId(pos.node)
      const orientation = nodeOrientation(pos.node)
      await this.ensureNode(id)
      const record = this.record(pos.node)
      if (offset >= record.sequenceLen) {
        throw new Error(
          `Offset ${offset} in node ${id} of length ${record.sequenceLen}`,
        )
      }
      active.push(offset, id, entrySide(orientation))
      const distanceToNext = record.sequenceLen - offset
      if (remaining <= distanceToNext) {
        active.push(
          remaining === distanceToNext ? 0 : distanceToNext - remaining - 1,
          id,
          exitSide(orientation),
        )
        break
      }
      active.push(0, id, exitSide(orientation))
      const next = record.gbwt().lf(pos.offset)
      if (!next) {
        throw new Error(
          `No successor for GBWT position (${pos.node}, ${pos.offset})`,
        )
      }
      pos = next
      offset = 0
      remaining -= distanceToNext
    }
    return this.insertContext(active, context)
  }

  async aroundNodes(nodes: Iterable<number>, context: number) {
    const active = new SideQueue()
    for (const id of nodes) {
      await this.ensureNode(id)
      active.push(0, id, 'left')
      active.push(0, id, 'right')
    }
    return this.insertContext(active, context)
  }

  private async insertContext(active: SideQueue, context: number) {
    this.clearPaths()
    const visited = new Set<string>()
    const toRemove = new Set<number>()
    for (const handle of this.records.keys()) {
      toRemove.add(nodeId(handle))
    }
    let inserted = 0
    while (active.size > 0) {
      const [distance, id, side] = active.pop()!
      const key = `${id}:${side}`
      if (visited.has(key)) {
        continue
      }
      visited.add(key)
      toRemove.delete(id)
      if (!this.hasNode(id)) {
        await this.addNode(id)
        inserted += 1
      }
      const otherSide = flipSide(side)
      if (!visited.has(`${id}:${otherSide}`)) {
        const record = this.record(encodeNode(id, entryOrientation(side)))
        const nextDistance = distance + record.sequenceLen - 1
        if (nextDistance <= context) {
          active.push(nextDistance, id, otherSide)
        }
      }
      const record = this.record(encodeNode(id, exitOrientation(side)))
      const nextDistance = distance + 1
      if (nextDistance <= context) {
        for (const successor of record.successors()) {
          const successorId = nodeId(successor)
          const successorSide = entrySide(nodeOrientation(successor))
          if (!visited.has(`${successorId}:${successorSide}`)) {
            active.push(nextDistance, successorId, successorSide)
          }
        }
      }
    }
    for (const id of toRemove) {
      this.records.delete(encodeNode(id, 'forward'))
      this.records.delete(encodeNode(id, 'reverse'))
    }
    return { inserted, removed: toRemove.size }
  }

  extractPaths(reference: ReferencePath | undefined, output: HaplotypeOutput) {
    this.clearPaths()
    if (output === 'none') {
      return
    }
    const refPos = reference?.position
    this.refPath = reference?.name
    this.refHandle = reference?.handle
    const handles = this.sortedHandles()
    const successors = new Map<
      number,
      { next: Pos; hasPredecessor: boolean }[]
    >()
    for (const handle of handles) {
      successors.set(
        handle,
        this.record(handle)
          .gbwt()
          .decompress()
          .map(next => ({ next, hasPredecessor: false })),
      )
    }
    for (const handle of handles) {
      for (const { next } of successors.get(handle) as { next: Pos }[]) {
        const entry = successors.get(next.node)?.[next.offset]
        if (entry) {
          entry.hasPredecessor = true
        }
      }
    }
    let refOffset: number | undefined
    for (const handle of handles) {
      const entries = successors.get(handle) as {
        next: Pos
        hasPredecessor: boolean
      }[]
      entries.forEach((entry, offset) => {
        if (entry.hasPredecessor) {
          return
        }
        let curr: Pos | undefined = { node: handle, offset }
        let isRef = false
        const path: number[] = []
        const positions: Pos[] = []
        let len = 0
        while (curr) {
          if (
            curr.node === refPos?.handle &&
            curr.offset === refPos.gbwtOffset
          ) {
            this.refId = this.paths.length
            refOffset = path.length
            isRef = true
          }
          path.push(curr.node)
          positions.push(curr)
          len += this.record(curr.node).sequenceLen
          const step: { next: Pos } | undefined = successors.get(curr.node)?.[
            curr.offset
          ]
          curr =
            step &&
            step.next.node !== ENDMARKER &&
            successors.has(step.next.node)
              ? step.next
              : undefined
        }
        if (isRef || pathIsCanonical(path)) {
          this.paths.push({
            path,
            positions,
            len,
            weight: undefined,
            identity: undefined,
          })
        }
      })
    }
    if (refPos) {
      if (refOffset === undefined || this.refId === undefined) {
        this.clearPaths()
        throw new Error('Could not find the reference path')
      }
      const info = this.paths[this.refId]!
      let before = refPos.nodeOffset
      for (const handle of info.path.slice(0, refOffset)) {
        before += this.record(handle).sequenceLen
      }
      const start = refPos.seqOffset - before
      this.refInterval = [start, start + info.len]
      info.identity = {
        pathHandle: reference.handle,
        name: reference.name,
        orientation: 'forward',
        hapStart: start,
        hapEnd: start + info.len,
      }
    }
    if (output === 'distinct') {
      this.distinctPaths()
    } else if (output === 'reference-only') {
      if (this.refId === undefined) {
        throw new Error('Reference path is required for reference-only output')
      }
      this.paths = [this.paths[this.refId]!]
      this.refId = 0
    }
  }

  private distinctPaths() {
    const refPath =
      this.refId === undefined ? undefined : this.paths[this.refId]!.path
    this.paths.sort((x, y) => comparePaths(x.path, y.path) || x.len - y.len)
    const merged: PathInfo[] = []
    let refId: number | undefined
    for (const info of this.paths) {
      const last = merged[merged.length - 1]
      if (last && comparePaths(last.path, info.path) === 0) {
        last.weight = (last.weight ?? 0) + 1
      } else {
        if (refPath && comparePaths(info.path, refPath) === 0) {
          refId = merged.length
        }
        merged.push({ ...info, weight: 1 })
      }
    }
    this.paths = merged
    this.refId = refId
  }

  async identifyPaths() {
    if (!this.db.hasHaplotypeIndex) {
      throw new Error(
        'The database has no HaplotypeSamples table; run gbz-haplotype-index on it',
      )
    }
    const interval = (await this.db.haplotypeSampleInterval()) ?? 4096
    const handles = this.sortedHandles()
    const minHandle = handles[0]
    const maxHandle = handles[handles.length - 1]
    if (minHandle === undefined || maxHandle === undefined) {
      return
    }
    const samples = new Map<string, HaplotypeSample>()
    for (const sample of await this.db.haplotypeSamplesInRange(
      minHandle,
      maxHandle,
    )) {
      samples.set(posKey(sample), sample)
    }
    const starts = new Map<string, number>()
    this.paths.forEach((info, index) => {
      const first = info.positions[0]
      if (first && index !== this.refId) {
        starts.set(posKey(first), index)
      }
    })
    const outside = new Map<number, GbzRecord>()
    const recordAt = async (handle: number) => {
      const inside = this.records.get(handle)
      if (inside) {
        return inside
      }
      let record = outside.get(handle)
      if (!record) {
        record = await this.db.getRecord(handle)
        this.stats.identificationFetches += 1
        if (!record) {
          throw new Error(`Node record ${handle} is missing from the database`)
        }
        outside.set(handle, record)
      }
      return record
    }
    const sampleAt = async (pos: Pos) => {
      if (pos.node >= minHandle && pos.node <= maxHandle) {
        return samples.get(posKey(pos))
      }
      this.stats.identificationFetches += 1
      return this.db.haplotypeSampleAt(pos.node, pos.offset)
    }
    const names = new Map<number, PathName>()
    const nameOf = async (pathHandle: number) => {
      let name = names.get(pathHandle)
      if (!name) {
        const path = await this.db.getPath(pathHandle)
        if (!path) {
          throw new Error(`Path ${pathHandle} is missing from the database`)
        }
        name = path.name
        names.set(pathHandle, name)
      }
      return name
    }
    const anchorFromSample = (
      sample: HaplotypeSample,
      counter: number,
      nodeLen: number,
    ): Anchor =>
      sample.orientation === 'forward'
        ? {
            pathHandle: sample.pathHandle,
            orientation: 'forward',
            base: sample.pathOffset - counter,
          }
        : {
            pathHandle: sample.pathHandle,
            orientation: 'reverse',
            base: sample.pathOffset + counter + nodeLen,
          }
    const anchorFromIdentity = (
      identity: PathIdentity,
      counter: number,
    ): Anchor =>
      identity.orientation === 'forward'
        ? {
            pathHandle: identity.pathHandle,
            orientation: 'forward',
            base: identity.hapStart - counter,
          }
        : {
            pathHandle: identity.pathHandle,
            orientation: 'reverse',
            base: identity.hapEnd + counter,
          }

    for (let start = 0; start < this.paths.length; start++) {
      const startInfo = this.paths[start]!
      if (start === this.refId || startInfo.identity) {
        continue
      }
      const chain: { index: number; startBp: number }[] = []
      const visited = new Set<number>()
      let anchor: Anchor | undefined
      let counter = 0
      let current: number | undefined = start
      let pos: Pos | undefined
      while (anchor === undefined) {
        if (current !== undefined) {
          if (visited.has(current)) {
            break
          }
          visited.add(current)
          const info = this.paths[current]!
          chain.push({ index: current, startBp: counter })
          let bp = counter
          for (const position of info.positions) {
            const sample = samples.get(posKey(position))
            const nodeLen = this.record(position.node).sequenceLen
            if (sample) {
              anchor = anchorFromSample(sample, bp, nodeLen)
              break
            }
            bp += nodeLen
          }
          counter += info.len
          if (anchor) {
            break
          }
          const last = info.positions[info.positions.length - 1]!
          pos = this.record(last.node).gbwt().lf(last.offset)
          current = undefined
        }
        if (pos === undefined || pos.node === ENDMARKER) {
          break
        }
        const known = starts.get(posKey(pos))
        if (known !== undefined) {
          const identity = this.paths[known]!.identity
          if (identity) {
            anchor = anchorFromIdentity(identity, counter)
            break
          }
          current = known
          continue
        }
        const sample = await sampleAt(pos)
        const record = await recordAt(pos.node)
        if (sample) {
          anchor = anchorFromSample(sample, counter, record.sequenceLen)
          break
        }
        this.stats.identificationSteps += 1
        if (
          counter - (chain[chain.length - 1] as { startBp: number }).startBp >
          4 * interval + 4 * record.sequenceLen
        ) {
          break
        }
        counter += record.sequenceLen
        pos = record.gbwt().lf(pos.offset)
      }
      if (anchor) {
        const name = await nameOf(anchor.pathHandle)
        for (const { index, startBp } of chain) {
          const info = this.paths[index]!
          info.identity =
            anchor.orientation === 'forward'
              ? {
                  pathHandle: anchor.pathHandle,
                  name,
                  orientation: 'forward',
                  hapStart: anchor.base + startBp,
                  hapEnd: anchor.base + startBp + info.len,
                }
              : {
                  pathHandle: anchor.pathHandle,
                  name,
                  orientation: 'reverse',
                  hapStart: anchor.base - startBp - info.len,
                  hapEnd: anchor.base - startBp,
                }
        }
      }
    }
  }

  private refIndex(ref: number[]) {
    if (this.refIndexCache === undefined) {
      const index = new Map<number, number[]>()
      ref.forEach((handle, i) => {
        const occurrences = index.get(handle)
        if (occurrences) {
          occurrences.push(i)
        } else {
          index.set(handle, [i])
        }
      })
      this.refIndexCache = index
    }
    return this.refIndexCache
  }

  private refPrefix(ref: number[]) {
    if (this.refPrefixCache === undefined) {
      const prefix = [0]
      ref.forEach((handle, i) => {
        prefix.push(prefix[i]! + this.record(handle).sequenceLen)
      })
      this.refPrefixCache = prefix
    }
    return this.refPrefixCache
  }

  private orderedMatches(
    path: number[],
    ref: number[],
  ): [number, number][] | undefined {
    const index = this.refIndex(ref)
    const pairs: [number, number][] = []
    let last = -1
    for (let i = 0; i < path.length; i++) {
      const occurrences = index.get(path[i]!)
      if (occurrences) {
        const j = occurrences.find(x => x > last)
        if (j === undefined) {
          return undefined
        }
        pairs.push([i, j])
        last = j
      }
    }
    return pairs
  }

  private pathLen(path: number[]) {
    let total = 0
    for (const handle of path) {
      total += this.record(handle).sequenceLen
    }
    return total
  }

  private prefixMatches(path: number[], ref: number[]) {
    let result = 0
    let pi = 0
    let ri = 0
    let pb = 0
    let rb = 0
    while (pi < path.length && ri < ref.length) {
      const a = this.record(path[pi]!).sequence
      const b = this.record(ref[ri]!).sequence
      while (pb < a.length && rb < b.length) {
        if (a[pb] !== b[rb]) {
          return result
        }
        pb += 1
        rb += 1
        result += 1
      }
      if (pb === a.length) {
        pi += 1
        pb = 0
      }
      if (rb === b.length) {
        ri += 1
        rb = 0
      }
    }
    return result
  }

  private suffixMatches(path: number[], ref: number[]) {
    let result = 0
    let pi = 0
    let ri = 0
    let pb = 0
    let rb = 0
    while (pi < path.length && ri < ref.length) {
      const a = this.record(path[path.length - pi - 1]!).sequence
      const b = this.record(ref[ref.length - ri - 1]!).sequence
      while (pb < a.length && rb < b.length) {
        if (a[a.length - pb - 1] !== b[b.length - rb - 1]) {
          return result
        }
        pb += 1
        rb += 1
        result += 1
      }
      if (pb === a.length) {
        pi += 1
        pb = 0
      }
      if (rb === b.length) {
        ri += 1
        rb = 0
      }
    }
    return result
  }

  private align(path: number[], ref: number[], edits: Edit[]) {
    const pathLen = this.pathLen(path)
    const refLen = this.pathLen(ref)
    const prefix = this.prefixMatches(path, ref)
    let suffix = this.suffixMatches(path, ref)
    if (prefix + suffix > pathLen) {
      suffix = pathLen - prefix
    }
    if (prefix + suffix > refLen) {
      suffix = refLen - prefix
    }
    appendEdit(edits, 'M', prefix)
    const pathMiddle = pathLen - prefix - suffix
    const refMiddle = refLen - prefix - suffix
    if (pathMiddle === 0) {
      appendEdit(edits, 'D', refMiddle)
    } else if (refMiddle === 0) {
      appendEdit(edits, 'I', pathMiddle)
    } else {
      const mismatch = Math.min(pathMiddle, refMiddle)
      const mismatchIndel =
        4 * mismatch +
        gapPenalty(pathMiddle - mismatch) +
        gapPenalty(refMiddle - mismatch)
      const insertionDeletion = gapPenalty(pathMiddle) + gapPenalty(refMiddle)
      if (mismatchIndel <= insertionDeletion) {
        appendEdit(edits, 'M', mismatch)
        appendEdit(edits, 'I', pathMiddle - mismatch)
        appendEdit(edits, 'D', refMiddle - mismatch)
      } else {
        appendEdit(edits, 'I', pathMiddle)
        appendEdit(edits, 'D', refMiddle)
      }
    }
    appendEdit(edits, 'M', suffix)
  }

  private edits(pathIndex: number): Edit[] | undefined {
    const info = this.paths[pathIndex]
    if (this.refId === undefined || pathIndex === this.refId || !info) {
      return undefined
    }
    const ref = this.paths[this.refId]!.path
    const ordered = this.orderedMatches(info.path, ref)
    if (ordered) {
      this.stats.orderedAlignments += 1
    } else {
      this.stats.lcsAlignments += 1
    }
    const lcs =
      ordered ??
      weightedLcs(info.path, ref, handle => this.record(handle).sequenceLen)[0]
    const edits: Edit[] = []
    let pathOffset = 0
    let refOffset = 0
    for (const [nextPath, nextRef] of lcs) {
      this.align(
        info.path.slice(pathOffset, nextPath),
        ref.slice(refOffset, nextRef),
        edits,
      )
      appendEdit(edits, 'M', this.record(info.path[nextPath]!).sequenceLen)
      pathOffset = nextPath + 1
      refOffset = nextRef + 1
    }
    this.align(info.path.slice(pathOffset), ref.slice(refOffset), edits)
    return edits
  }

  alignToRef(pathIndex: number) {
    return this.edits(pathIndex)
      ?.map(([op, len]) => `${len}${op}`)
      .join('')
  }

  alignments(): HaplotypeAlignment[] {
    const reference = this.referenceInterval
    if (this.refId === undefined || !reference) {
      throw new Error('Alignments need a reference path')
    }
    const ref = this.paths[this.refId]!.path
    const refTotal = this.refPrefix(ref)[ref.length]!
    const result: HaplotypeAlignment[] = []
    this.paths.forEach((info, index) => {
      if (index === this.refId) {
        return
      }
      const edits = this.edits(index)!
      let first = 0
      let leading = 0
      while (first < edits.length && edits[first]![0] === 'D') {
        leading += edits[first]![1]
        first += 1
      }
      let last = edits.length
      let trailing = 0
      while (last > first && edits[last - 1]![0] === 'D') {
        trailing += edits[last - 1]![1]
        last -= 1
      }
      const identity = info.identity
      const strand =
        info.path.some(handle => isReverse(handle)) &&
        !info.path.some(handle => !isReverse(handle))
          ? '-'
          : '+'
      result.push({
        pathHandle: identity?.pathHandle,
        name: identity?.name,
        strand: identity
          ? identity.orientation === 'forward'
            ? '+'
            : '-'
          : strand,
        hapStart: identity
          ? identity.name.fragment + identity.hapStart
          : undefined,
        hapEnd: identity ? identity.name.fragment + identity.hapEnd : undefined,
        start: info.positions[0]!,
        refStart: reference.start + leading,
        refEnd: reference.start + refTotal - trailing,
        cigar: edits
          .slice(first, last)
          .map(([op, len]) => `${len}${op}`)
          .join(''),
        weight: info.weight,
        path: info.path,
      })
    })
    return result
  }

  toJSON(cigar: boolean, opts: ToJsonOptions = {}): SubgraphJson {
    const handles = this.sortedHandles()
    const nodes = handles
      .filter(handle => !isReverse(handle))
      .map(handle => ({
        id: String(nodeId(handle)),
        sequence: this.record(handle).sequence,
      }))
    const edges: SubgraphJson['edges'] = []
    for (const handle of handles) {
      for (const successor of this.record(handle).successors()) {
        if (this.hasHandle(successor) && edgeIsCanonical(handle, successor)) {
          edges.push({
            from: String(nodeId(handle)),
            from_is_reverse: isReverse(handle),
            to: String(nodeId(successor)),
            to_is_reverse: isReverse(successor),
          })
        }
      }
    }
    const paths: SubgraphPath[] = []
    const contig = this.refPath?.contig ?? 'unknown'
    if (this.refId !== undefined && this.refPath && this.refInterval) {
      const info = this.paths[this.refId]!
      const name = {
        ...this.refPath,
        fragment: this.refPath.fragment + this.refInterval[0],
      }
      paths.push(
        jsonPath(
          info,
          formatPathName(name, this.refPath.fragment + this.refInterval[1]),
          undefined,
        ),
      )
    }
    let haplotype = 1
    this.paths.forEach((info, index) => {
      if (index === this.refId) {
        return
      }
      const resolved = opts.names === 'resolved' ? info.identity : undefined
      const name = resolved
        ? formatPathName(
            {
              ...resolved.name,
              fragment: resolved.name.fragment + resolved.hapStart,
            },
            resolved.name.fragment + resolved.hapEnd,
          )
        : formatPathName(
            { sample: 'unknown', contig, haplotype, fragment: 0 },
            info.len,
          )
      paths.push(
        jsonPath(info, name, cigar ? this.alignToRef(index) : undefined),
      )
      haplotype += 1
    })
    return { nodes, edges, paths }
  }
}

function jsonPath(
  info: PathInfo,
  name: string,
  cigar: string | undefined,
): SubgraphPath {
  return {
    name,
    ...(info.weight === undefined ? {} : { weight: info.weight }),
    ...(cigar === undefined ? {} : { cigar }),
    path: info.path.map(handle => ({
      id: String(nodeId(handle)),
      is_reverse: isReverse(handle),
    })),
  }
}

function comparePaths(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]!
    const y = b[i]!
    if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return a.length - b.length
}

function appendEdit(edits: Edit[], op: EditOp, len: number) {
  if (len === 0) {
    return
  }
  const last = edits[edits.length - 1]
  if (last?.[0] === op) {
    last[1] += len
  } else {
    edits.push([op, len])
  }
}

function gapPenalty(len: number) {
  return len === 0 ? 0 : 6 + (len - 1)
}
