import {
  ENDMARKER,
  edgeIsCanonical,
  encodeNode,
  entryOrientation,
  entrySide,
  exitOrientation,
  exitSide,
  flipNode,
  flipSide,
  isReverse,
  nodeId,
  nodeOrientation,
  pathEndsAreCanonical,
  pathIsCanonical,
} from './gbwt/node.ts'
import { gfaHeaderLines, sha256Hex, subgraphName } from './graphName.ts'
import { weightedLcs } from './lcs.ts'
import { formatPathName } from './pathName.ts'

import type { GBZBase, GbzPath, GbzRecord, HaplotypeSample } from './db.ts'
import type { NodeSide, Orientation } from './gbwt/node.ts'
import type { Pos } from './gbwt/record.ts'
import type { PathName } from './pathName.ts'

export type HaplotypeOutput = 'all' | 'distinct' | 'reference-only' | 'none'

export type SnarlOutput = 'none' | 'contained' | 'overlapping'

type HandleType =
  | { kind: 'snarl-exit'; snarl: [number, number] }
  | { kind: 'chain' }
  | { kind: 'regular' }

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
  offsets: number[]
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

export interface AlignmentSpan {
  strand: '+' | '-'
  refStart: number
  refEnd: number
  cigar: string
  weight: number | undefined
  path: number[]
  start: Pos
}

export type HaplotypeAlignment = AlignmentSpan &
  (
    | {
        resolved: true
        name: PathName
        label: string
        pathHandle: number
        hapStart: number
        hapEnd: number
      }
    | { resolved: false }
  )

export interface SubgraphOutputOptions {
  cigar?: boolean | undefined
  names?: 'anonymous' | 'resolved' | undefined
}

export interface SubgraphOptions {
  limit?: number | undefined
  signal?: AbortSignal | undefined
}

function sideBefore(
  a: [number, number, NodeSide],
  b: [number, number, NodeSide],
) {
  return (
    a[0] < b[0] ||
    (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))
  )
}

class SideQueue {
  private heap: [number, number, NodeSide][] = []

  push(distance: number, node: number, side: NodeSide) {
    const heap = this.heap
    heap.push([distance, node, side])
    let i = heap.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (sideBefore(heap[i]!, heap[parent]!)) {
        ;[heap[i], heap[parent]] = [heap[parent]!, heap[i]!]
        i = parent
      } else {
        break
      }
    }
  }

  pop() {
    const heap = this.heap
    const top = heap[0]
    const last = heap.pop()
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = left + 1
        let smallest = i
        if (left < heap.length && sideBefore(heap[left]!, heap[smallest]!)) {
          smallest = left
        }
        if (right < heap.length && sideBefore(heap[right]!, heap[smallest]!)) {
          smallest = right
        }
        if (smallest === i) {
          break
        }
        ;[heap[i], heap[smallest]] = [heap[smallest]!, heap[i]!]
        i = smallest
      }
    }
    return top
  }

  get size() {
    return this.heap.length
  }
}

function posKey(pos: Pos) {
  return `${pos.node}:${pos.offset}`
}

function pathPosition(info: PathInfo, k: number): Pos {
  return { node: info.path[k]!, offset: info.offsets[k]! }
}

const SCAN_GAP = 4096

function handleRuns(sortedHandles: number[]) {
  const runs: [number, number][] = []
  for (const handle of sortedHandles) {
    const last = runs[runs.length - 1]
    if (last && handle - last[1] <= SCAN_GAP) {
      last[1] = handle
    } else {
      runs.push([handle, handle])
    }
  }
  return runs
}

interface Anchor {
  pathHandle: number
  orientation: Orientation
  base: number
}

export type ChainEnd =
  | 'in-fragment sample'
  | 'identified sibling'
  | 'out-of-window sample'
  | 'bound'
  | 'endmarker'
  | 'cycle'

export interface ChainRecord {
  fragments: number
  steps: number
  seeks: number
  reentries: number
  twinLandings: number
  end: ChainEnd
  pathHandle: number | undefined
}

export interface IdentificationStats {
  interval: number
  scans: [number, number][]
  windowSamples: number
  fragmentLengths: number[]
  companionSeeks: number
  companionMisses: number
  graphLookups: number
  graphFetches: number
  chains: ChainRecord[]
}

interface SubgraphStats {
  orderedAlignments: number
  lcsAlignments: number
  identificationSteps: number
  identificationFetches: number
  identification: IdentificationStats
}

export class Subgraph {
  private records = new Map<number, GbzRecord>()
  private paths: PathInfo[] = []
  private twinStarts = new Set<string>()
  private refId: number | undefined
  private refPath: PathName | undefined
  private refHandle: number | undefined
  private refInterval: [number, number] | undefined
  private refIndexCache: Map<number, number[]> | undefined
  private refPrefixCache: number[] | undefined
  readonly stats: SubgraphStats = {
    orderedAlignments: 0,
    lcsAlignments: 0,
    identificationSteps: 0,
    identificationFetches: 0,
    identification: {
      interval: 0,
      scans: [],
      windowSamples: 0,
      fragmentLengths: [],
      companionSeeks: 0,
      companionMisses: 0,
      graphLookups: 0,
      graphFetches: 0,
      chains: [],
    },
  }

  private db: GBZBase
  private readonly limit: number | undefined
  private readonly signal: AbortSignal | undefined

  constructor(db: GBZBase, opts: SubgraphOptions = {}) {
    this.db = db
    this.limit = opts.limit
    this.signal = opts.signal
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
    this.signal?.throwIfAborted()
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
    this.twinStarts.clear()
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

  async prefetchReferenceWalk(reference: ReferencePath, len: number) {
    const last = await this.db.indexedPosition(
      reference.handle,
      reference.position.seqOffset + len,
    )
    if (last) {
      const a = reference.position.handle
      const b = last.pos.node
      await this.db.prefetchRecords(Math.min(a, b), Math.max(a, b) + 1)
    }
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

  async betweenNodes(start: number, end: number) {
    this.clearPaths()
    const active = [start, flipNode(end)]
    const visited = new Set([nodeId(start), nodeId(end)])
    let inserted = 0
    while (active.length > 0) {
      const curr = active.pop()!
      const id = nodeId(curr)
      if (!this.hasNode(id)) {
        await this.addNode(id)
        inserted += 1
      }
      for (const successor of this.record(curr).successors()) {
        const successorId = nodeId(successor)
        if (!visited.has(successorId)) {
          active.push(successor, flipNode(successor))
          visited.add(successorId)
        }
      }
    }
    return inserted
  }

  async extractSnarls(snarls: SnarlOutput) {
    let inserted = 0
    for (const [start, end] of await this.overlappingSnarls(snarls)) {
      inserted += await this.betweenNodes(start, end)
    }
    return inserted
  }

  private async overlappingSnarls(snarls: SnarlOutput) {
    const result: [number, number][] = []
    if (snarls !== 'none') {
      let foundLink = false
      for (const handle of this.sortedHandles()) {
        const record = this.record(handle)
        const next = record.next
        if (next !== undefined) {
          foundLink = true
          if (this.hasHandle(next)) {
            if (edgeIsCanonical(handle, next)) {
              result.push([handle, next])
            }
          } else if (
            snarls === 'overlapping' &&
            this.isSnarlEntryInSubgraph(record)
          ) {
            result.push([handle, next])
          }
        }
      }
      if (
        !foundLink &&
        snarls === 'overlapping' &&
        (await this.db.hasChainLinks())
      ) {
        const covering = await this.findCoveringSnarl()
        if (covering) {
          result.push(covering)
        }
      }
    }
    return result
  }

  private isSnarlEntryInSubgraph(record: GbzRecord) {
    const successors = record.successors()
    const first = successors.find(handle => this.hasHandle(handle))
    return first === undefined
      ? false
      : successors.length > 1 ||
          this.record(flipNode(first)).successors().length > 1
  }

  private recordReader(onFetch?: () => void) {
    const outside = new Map<number, GbzRecord>()
    return async (handle: number) => {
      const inside = this.records.get(handle)
      if (inside) {
        return inside
      }
      let record = outside.get(handle)
      if (!record) {
        record = await this.db.getRecord(handle)
        onFetch?.()
        if (!record) {
          throw new Error(`Node record ${handle} is missing from the database`)
        }
        outside.set(handle, record)
      }
      return record
    }
  }

  private async findCoveringSnarl() {
    const read = this.recordReader()
    const isSnarlEntry = async (record: GbzRecord) => {
      const successors = record.successors()
      const first = successors[0]
      return first === undefined
        ? false
        : successors.length > 1 ||
            (await read(flipNode(first))).successors().length > 1
    }
    const classify = async (handle: number): Promise<HandleType> => {
      const reverse = await read(flipNode(handle))
      return reverse.next !== undefined
        ? (await isSnarlEntry(reverse))
          ? { kind: 'snarl-exit', snarl: [flipNode(handle), reverse.next] }
          : { kind: 'chain' }
        : (await read(handle)).next !== undefined
          ? { kind: 'chain' }
          : { kind: 'regular' }
    }
    const visited = new Set<number>()
    const queue = this.sortedHandles().flatMap(handle =>
      this.record(handle).successors(),
    )
    let result: [number, number] | undefined
    let done = false
    while (!done && queue.length > 0) {
      const handle = queue.shift()!
      const id = nodeId(handle)
      if (!this.hasHandle(handle) && !visited.has(id)) {
        visited.add(id)
        const type = await classify(handle)
        if (type.kind === 'snarl-exit') {
          result = type.snarl
          done = true
        } else if (type.kind === 'chain') {
          done = true
        } else {
          for (const orientation of ['forward', 'reverse'] as const) {
            queue.push(
              ...(await read(encodeNode(id, orientation))).successors(),
            )
          }
        }
      }
    }
    return result
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
    const count = handles.length
    const indexOf = new Map<number, number>()
    handles.forEach((handle, i) => indexOf.set(handle, i))
    const nextIndex: Int32Array[] = []
    const nextOffset: Int32Array[] = []
    const hasPredecessor: Uint8Array[] = []
    const seqLen = new Int32Array(count)
    for (let i = 0; i < count; i++) {
      const record = this.record(handles[i]!)
      const { nodes, offsets } = record.gbwt().decompressArrays()
      seqLen[i] = record.sequenceLen
      nextIndex.push(nodes)
      nextOffset.push(offsets)
      hasPredecessor.push(new Uint8Array(nodes.length))
    }
    for (let i = 0; i < count; i++) {
      const nodes = nextIndex[i]!
      const offsets = nextOffset[i]!
      for (let k = 0; k < nodes.length; k++) {
        const j = indexOf.get(nodes[k]!)
        if (j === undefined) {
          nodes[k] = -1
        } else {
          nodes[k] = j
          hasPredecessor[j]![offsets[k]!] = 1
        }
      }
    }
    const refIndex =
      refPos === undefined ? undefined : indexOf.get(refPos.handle)
    const refGbwtOffset = refPos?.gbwtOffset
    let refOffset: number | undefined
    const walk = (i: number, offset: number, path: number[] | undefined) => {
      const offsets: number[] = []
      let steps = 0
      let len = 0
      let refAt = -1
      let cur = i
      let off = offset
      for (;;) {
        if (cur === refIndex && off === refGbwtOffset) {
          refAt = steps
        }
        if (path) {
          path.push(handles[cur]!)
          offsets.push(off)
        }
        steps += 1
        len += seqLen[cur]!
        const next = nextIndex[cur]![off]!
        if (next < 0) {
          break
        }
        off = nextOffset[cur]![off]!
        cur = next
      }
      return { offsets, len, refAt, last: cur }
    }
    const keep = (
      path: number[],
      offsets: number[],
      len: number,
      refAt: number,
    ) => {
      if (refAt >= 0) {
        this.refId = this.paths.length
        refOffset = refAt
      }
      this.paths.push({
        path,
        offsets,
        len,
        weight: undefined,
        identity: undefined,
      })
    }
    const twinsExpected = new Int32Array(count)
    const refMayStartReversed =
      refIndex !== undefined && isReverse(handles[refIndex]!)
    for (let i = 0; i < count; i++) {
      const first = handles[i]!
      if (!isReverse(first)) {
        const starts = hasPredecessor[i]!
        for (let offset = 0; offset < starts.length; offset++) {
          if (starts[offset] === 0) {
            const path: number[] = []
            const { offsets, len, refAt, last } = walk(i, offset, path)
            const lastHandle = handles[last]!
            if (refAt >= 0 || pathEndsAreCanonical(first, lastHandle)) {
              keep(path, offsets, len, refAt)
              if (!isReverse(lastHandle)) {
                const twinRecord = indexOf.get(flipNode(lastHandle))!
                twinsExpected[twinRecord] = twinsExpected[twinRecord]! + 1
              }
            } else {
              this.twinStarts.add(posKey({ node: first, offset }))
            }
          }
        }
      }
    }
    for (let i = 0; i < count; i++) {
      const first = handles[i]!
      if (isReverse(first)) {
        const starts = hasPredecessor[i]!
        let startCount = 0
        for (const flag of starts) {
          if (flag === 0) {
            startCount += 1
          }
        }
        const allTwins = !refMayStartReversed && startCount === twinsExpected[i]
        for (let offset = 0; offset < starts.length; offset++) {
          if (starts[offset] === 0) {
            const bare = allTwins ? undefined : walk(i, offset, undefined)
            if (
              bare &&
              (bare.refAt >= 0 ||
                pathEndsAreCanonical(first, handles[bare.last]))
            ) {
              const path: number[] = []
              const { offsets, len, refAt } = walk(i, offset, path)
              keep(path, offsets, len, refAt)
            } else {
              this.twinStarts.add(posKey({ node: first, offset }))
            }
          }
        }
      }
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
    const runs = handleRuns(this.sortedHandles())
    if (runs.length === 0) {
      return
    }
    const samples = new Map<string, HaplotypeSample>()
    for (const [first, last] of runs) {
      for (const sample of await this.db.haplotypeSamplesInRange(first, last)) {
        samples.set(posKey(sample), sample)
      }
    }
    const scanned = (handle: number) => {
      let lo = 0
      let hi = runs.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (runs[mid]![0] <= handle) {
          lo = mid
        } else {
          hi = mid - 1
        }
      }
      const run = runs[lo]!
      return run[0] <= handle && handle <= run[1]
    }
    const starts = new Map<string, number>()
    this.paths.forEach((info, index) => {
      if (info.path.length > 0 && index !== this.refId) {
        starts.set(posKey(pathPosition(info, 0)), index)
      }
    })
    const identification = this.stats.identification
    identification.interval = interval
    identification.scans = runs
    identification.windowSamples = samples.size
    this.paths.forEach((info, index) => {
      if (index !== this.refId) {
        identification.fragmentLengths.push(info.len)
      }
    })
    const readRecord = this.recordReader(() => {
      this.stats.identificationFetches += 1
      identification.graphFetches += 1
    })
    const recordAt = (handle: number) => {
      identification.graphLookups += 1
      return readRecord(handle)
    }
    const sampleAt = async (pos: Pos, chain: ChainRecord) => {
      if (scanned(pos.node)) {
        return samples.get(posKey(pos))
      }
      this.stats.identificationFetches += 1
      identification.companionSeeks += 1
      chain.seeks += 1
      const sample = await this.db.haplotypeSampleAt(pos.node, pos.offset)
      if (!sample) {
        identification.companionMisses += 1
      }
      return sample
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
      const record: ChainRecord = {
        fragments: 0,
        steps: 0,
        seeks: 0,
        reentries: 0,
        twinLandings: 0,
        end: 'endmarker',
        pathHandle: undefined,
      }
      identification.chains.push(record)
      let anchor: Anchor | undefined
      let counter = 0
      let current: number | undefined = start
      let pos: Pos | undefined
      while (anchor === undefined) {
        this.signal?.throwIfAborted()
        if (current !== undefined) {
          if (visited.has(current)) {
            record.end = 'cycle'
            break
          }
          visited.add(current)
          const info = this.paths[current]!
          chain.push({ index: current, startBp: counter })
          record.fragments += 1
          let bp = counter
          for (let k = 0; k < info.path.length; k++) {
            const position = pathPosition(info, k)
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
            record.end = 'in-fragment sample'
            break
          }
          const last = pathPosition(info, info.path.length - 1)
          pos = this.record(last.node).gbwt().lf(last.offset)
          current = undefined
        }
        if (pos === undefined || pos.node === ENDMARKER) {
          record.end = 'endmarker'
          break
        }
        const key = posKey(pos)
        const known = starts.get(key)
        if (known !== undefined) {
          const identity = this.paths[known]!.identity
          if (identity) {
            anchor = anchorFromIdentity(identity, counter)
            record.end = 'identified sibling'
            break
          }
          current = known
          continue
        }
        if (this.records.has(pos.node)) {
          record.reentries += 1
        }
        if (this.twinStarts.has(key)) {
          record.twinLandings += 1
        }
        const sample = await sampleAt(pos, record)
        const node = await recordAt(pos.node)
        if (sample) {
          anchor = anchorFromSample(sample, counter, node.sequenceLen)
          record.end = 'out-of-window sample'
          break
        }
        this.stats.identificationSteps += 1
        record.steps += 1
        if (
          counter - (chain[chain.length - 1] as { startBp: number }).startBp >
          4 * interval + 4 * node.sequenceLen
        ) {
          record.end = 'bound'
          break
        }
        counter += node.sequenceLen
        pos = node.gbwt().lf(pos.offset)
      }
      if (anchor) {
        record.pathHandle = anchor.pathHandle
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

  private sharedWeight(path: number[], ref: number[]) {
    const index = this.refIndex(ref)
    let weight = 0
    for (const handle of path) {
      if (index.has(handle)) {
        weight += this.record(handle).sequenceLen
      }
    }
    return weight
  }

  private editsAgainst(path: number[], ref: number[]) {
    const ordered = this.orderedMatches(path, ref)
    if (ordered) {
      this.stats.orderedAlignments += 1
    } else {
      this.stats.lcsAlignments += 1
    }
    const lcs =
      ordered ??
      weightedLcs(path, ref, handle => this.record(handle).sequenceLen)[0]
    const edits: Edit[] = []
    let matched = 0
    let pathOffset = 0
    let refOffset = 0
    for (const [nextPath, nextRef] of lcs) {
      this.align(
        path.slice(pathOffset, nextPath),
        ref.slice(refOffset, nextRef),
        edits,
      )
      const nodeLen = this.record(path[nextPath]!).sequenceLen
      appendEdit(edits, 'M', nodeLen)
      matched += nodeLen
      pathOffset = nextPath + 1
      refOffset = nextRef + 1
    }
    this.align(path.slice(pathOffset), ref.slice(refOffset), edits)
    return { edits, matched }
  }

  private alignment(pathIndex: number) {
    const info = this.paths[pathIndex]
    if (this.refId === undefined || pathIndex === this.refId || !info) {
      return undefined
    }
    const ref = this.paths[this.refId]!.path
    const flippedPath = pathIsCanonical(ref)
      ? []
      : info.path.map(handle => flipNode(handle)).reverse()
    const forwardBound = this.sharedWeight(info.path, ref)
    const flippedBound = this.sharedWeight(flippedPath, ref)
    let result: { edits: Edit[]; flipped: boolean }
    if (flippedBound === 0) {
      result = {
        edits: this.editsAgainst(info.path, ref).edits,
        flipped: false,
      }
    } else if (forwardBound === 0) {
      result = {
        edits: this.editsAgainst(flippedPath, ref).edits,
        flipped: true,
      }
    } else {
      const forward = this.editsAgainst(info.path, ref)
      const flipped = this.editsAgainst(flippedPath, ref)
      result =
        flipped.matched > forward.matched
          ? { edits: flipped.edits, flipped: true }
          : { edits: forward.edits, flipped: false }
    }
    return result
  }

  alignToRef(pathIndex: number) {
    return this.alignment(pathIndex)
      ?.edits.map(([op, len]) => `${len}${op}`)
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
      const { edits, flipped } = this.alignment(index)!
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
      const alongReference = identity
        ? (identity.orientation === 'forward') !== flipped
        : !flipped
      const span: AlignmentSpan = {
        strand: alongReference ? '+' : '-',
        refStart: reference.start + leading,
        refEnd: reference.start + refTotal - trailing,
        cigar: edits
          .slice(first, last)
          .map(([op, len]) => `${len}${op}`)
          .join(''),
        weight: info.weight,
        path: info.path,
        start: pathPosition(info, 0),
      }
      if (identity) {
        const hapStart = identity.name.fragment + identity.hapStart
        const hapEnd = identity.name.fragment + identity.hapEnd
        result.push({
          ...span,
          resolved: true,
          name: identity.name,
          label: formatPathName(
            { ...identity.name, fragment: hapStart },
            hapEnd,
          ),
          pathHandle: identity.pathHandle,
          hapStart,
          hapEnd,
        })
      } else {
        result.push({ ...span, resolved: false })
      }
    })
    return result
  }

  private canonicalEdges(id: number) {
    const edges: [number, number, number][] = []
    for (const orientation of ['forward', 'reverse'] as const) {
      const handle = encodeNode(id, orientation)
      for (const successor of this.record(handle).successors()) {
        if (this.hasHandle(successor) && edgeIsCanonical(handle, successor)) {
          edges.push([
            orientation === 'reverse' ? 1 : 0,
            nodeId(successor),
            isReverse(successor) ? 1 : 0,
          ])
        }
      }
    }
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    return edges.filter(
      (edge, i) =>
        i === 0 ||
        edge[0] !== edges[i - 1]![0] ||
        edge[1] !== edges[i - 1]![1] ||
        edge[2] !== edges[i - 1]![2],
    )
  }

  async stableName() {
    const encoder = new TextEncoder()
    const chunks: Uint8Array[] = []
    for (const handle of this.sortedHandles()) {
      if (!isReverse(handle)) {
        const id = nodeId(handle)
        let text = `S\t${id}\t${this.record(handle).sequence}\n`
        for (const [fromReverse, toId, toReverse] of this.canonicalEdges(id)) {
          text += `L\t${id}\t${fromReverse ? '-' : '+'}\t${toId}\t${toReverse ? '-' : '+'}\n`
        }
        chunks.push(encoder.encode(text))
      }
    }
    return sha256Hex(chunks)
  }

  async toGFA(opts: SubgraphOutputOptions = {}) {
    const cigar = opts.cigar ?? false
    const lines = [
      this.refPath ? `H\tVN:Z:1.1\tRS:Z:${this.refPath.sample}` : 'H\tVN:Z:1.1',
      ...gfaHeaderLines(
        subgraphName(await this.stableName(), await this.db.graphName()),
      ),
    ]
    const handles = this.sortedHandles()
    for (const handle of handles) {
      if (!isReverse(handle)) {
        lines.push(`S\t${nodeId(handle)}\t${this.record(handle).sequence}`)
      }
    }
    const sign = (handle: number) => (isReverse(handle) ? '-' : '+')
    for (const handle of handles) {
      for (const successor of this.record(handle).successors()) {
        if (this.hasHandle(successor) && edgeIsCanonical(handle, successor)) {
          lines.push(
            `L\t${nodeId(handle)}\t${sign(handle)}\t${nodeId(successor)}\t${sign(successor)}\t0M`,
          )
        }
      }
    }
    const walk = (
      info: PathInfo,
      name: PathName,
      end: number,
      cigarString: string | undefined,
    ) => {
      const steps = info.path
        .map(handle => `${isReverse(handle) ? '<' : '>'}${nodeId(handle)}`)
        .join('')
      const weight = info.weight === undefined ? '' : `\tWT:i:${info.weight}`
      const cg = cigarString === undefined ? '' : `\tCG:Z:${cigarString}`
      return `W\t${name.sample}\t${name.haplotype}\t${name.contig}\t${name.fragment}\t${end}\t${steps}${weight}${cg}`
    }
    const contig = this.refPath?.contig ?? 'unknown'
    if (this.refId !== undefined && this.refPath && this.refInterval) {
      lines.push(
        walk(
          this.paths[this.refId]!,
          {
            ...this.refPath,
            fragment: this.refPath.fragment + this.refInterval[0],
          },
          this.refPath.fragment + this.refInterval[1],
          undefined,
        ),
      )
    }
    let haplotype = 1
    this.paths.forEach((info, index) => {
      if (index !== this.refId) {
        const resolved = opts.names === 'resolved' ? info.identity : undefined
        const cigarString = cigar ? this.alignToRef(index) : undefined
        lines.push(
          resolved
            ? walk(
                info,
                {
                  ...resolved.name,
                  fragment: resolved.name.fragment + resolved.hapStart,
                },
                resolved.name.fragment + resolved.hapEnd,
                cigarString,
              )
            : walk(
                info,
                { sample: 'unknown', contig, haplotype, fragment: 0 },
                info.len,
                cigarString,
              ),
        )
        haplotype += 1
      }
    })
    return `${lines.join('\n')}\n`
  }

  toSubgraphJson(opts: SubgraphOutputOptions = {}): SubgraphJson {
    const cigar = opts.cigar ?? false
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
