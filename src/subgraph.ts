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

import type {
  GBZBase,
  GbzPath,
  GbzRecord,
  HaplotypeAnchor,
  HaplotypeSample,
  IndexedPosition,
} from './db.ts'
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

export class SubgraphLimitError extends Error {
  override name = 'SubgraphLimitError'
  readonly limit: number
  readonly windowBp: number | undefined
  readonly walkedBp: number | undefined

  constructor(limit: number, walk?: { windowBp: number; walkedBp: number }) {
    super(
      walk === undefined
        ? `Subgraph size limit of ${limit} nodes exceeded`
        : `Subgraph size limit of ${limit} nodes exceeded ${walk.walkedBp} bp into a ${walk.windowBp} bp window`,
    )
    this.limit = limit
    this.windowBp = walk?.windowBp
    this.walkedBp = walk?.walkedBp
  }
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

interface FragmentAlignment {
  strand: '+' | '-'
  refStart: number
  refEnd: number
  edits: Edit[]
  weight: number | undefined
  path: number[]
  start: Pos
  identity:
    | {
        pathHandle: number
        name: PathName
        hapStart: number
        hapEnd: number
        walkForward: boolean
      }
    | undefined
}

function joinable(a: FragmentAlignment, b: FragmentAlignment) {
  const insertion = b.identity!.hapStart - a.identity!.hapEnd
  const deletion =
    a.strand === '+' ? b.refStart - a.refEnd : a.refStart - b.refEnd
  return a.strand === b.strand && insertion >= 0 && deletion >= 0
    ? { insertion, deletion }
    : undefined
}

function joinPair(
  a: FragmentAlignment,
  b: FragmentAlignment,
  gap: { insertion: number; deletion: number },
): FragmentAlignment {
  const [left, right] = a.strand === '+' ? [a, b] : [b, a]
  const edits = left.edits.map(([op, len]): Edit => [op, len])
  appendGap(edits, gap.insertion, gap.deletion)
  for (const [op, len] of right.edits) {
    appendEdit(edits, op, len)
  }
  const walkForward = a.identity!.walkForward
  const [first, second] = walkForward ? [a, b] : [b, a]
  return {
    strand: a.strand,
    refStart: left.refStart,
    refEnd: right.refEnd,
    edits,
    weight: undefined,
    path: [...first.path, ...second.path],
    start: first.start,
    identity: {
      pathHandle: a.identity!.pathHandle,
      name: a.identity!.name,
      hapStart: a.identity!.hapStart,
      hapEnd: b.identity!.hapEnd,
      walkForward,
    },
  }
}

function joinSiblings(fragments: FragmentAlignment[]) {
  if (fragments.some(f => f.weight !== undefined)) {
    return fragments
  }
  const byPath = new Map<number, number[]>()
  fragments.forEach((fragment, index) => {
    if (fragment.identity) {
      const siblings = byPath.get(fragment.identity.pathHandle)
      if (siblings) {
        siblings.push(index)
      } else {
        byPath.set(fragment.identity.pathHandle, [index])
      }
    }
  })
  const joined = new Map<number, FragmentAlignment>()
  const consumed = new Set<number>()
  for (const siblings of byPath.values()) {
    siblings.sort(
      (x, y) =>
        fragments[x]!.identity!.hapStart - fragments[y]!.identity!.hapStart,
    )
    let head = siblings[0]!
    let current = fragments[head]!
    for (const index of siblings.slice(1)) {
      const next = fragments[index]!
      const gap = joinable(current, next)
      if (gap) {
        current = joinPair(current, next, gap)
        consumed.add(index)
      } else {
        joined.set(head, current)
        head = index
        current = next
      }
    }
    joined.set(head, current)
  }
  return fragments.flatMap((fragment, index) =>
    consumed.has(index) ? [] : [joined.get(index) ?? fragment],
  )
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

export type AnchorWalkEnd =
  | 'through the window'
  | 'before the window'
  | 'past the window'
  | 'ended in the window'
  | 'bound'
  | 'cycle'

export interface AnchorWalkRecord {
  pathHandle: number
  from: 'anchor' | 'sample'
  steps: number
  pieces: number
  end: AnchorWalkEnd
}

export interface AnchorWalkStats {
  spacing: number
  anchorOffset: number
  anchorNodeOffset: number
  anchorHandle: number
  referenceSteps: number
  rows: number
  walks: AnchorWalkRecord[]
  graphFetches: number
  scans: [number, number][]
  scanRows: number
  fallback: string | undefined
  ms: {
    reference: number
    rows: number
    walks: number
    scan: number
    sampled: number
  }
}

interface SubgraphStats {
  orderedAlignments: number
  lcsAlignments: number
  identificationSteps: number
  identificationFetches: number
  identification: IdentificationStats
  anchorWalk: AnchorWalkStats | undefined
}

const PREFETCH_RUN_GAP = 32768

interface WalkStep {
  pos: Pos
  at: number
  len: number
}

const ANCHOR_WALK_MARGIN = 65536

function rowidRuns(handles: number[]) {
  const sorted = [...handles].sort((a, b) => a - b)
  const runs: [number, number][] = []
  for (const handle of sorted) {
    const last = runs[runs.length - 1]
    if (last && handle - last[1] <= PREFETCH_RUN_GAP) {
      last[1] = handle
    } else {
      runs.push([handle, handle])
    }
  }
  return runs
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
  private walkedBp: number | undefined
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
    anchorWalk: undefined,
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
      throw new SubgraphLimitError(this.limit)
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

  prefetchReferenceWalk(reference: ReferencePath, len: number) {
    return this.prefetchReferenceRange(
      reference.handle,
      reference.position.seqOffset,
      reference.position.seqOffset + len,
    )
  }

  // One request for the reference walk's node records where their rowids are
  // close, and one per run of them where the walk crosses a gap in node ids
  // (AMY1's reference walk spans two gaps of millions), so the walk after it
  // never fetches leaf pages one at a time.
  private async prefetchReferenceRange(
    pathHandle: number,
    fromOffset: number,
    toOffset: number,
  ) {
    const [first, last] = await Promise.all([
      this.db.indexedPosition(pathHandle, fromOffset),
      this.db.indexedPosition(pathHandle, toOffset),
    ])
    if (first && last) {
      const a = first.pos.node
      const b = last.pos.node
      const whole = await this.db.prefetchRecords(
        Math.min(a, b),
        Math.max(a, b) + 1,
      )
      if (!whole) {
        const positions = await this.db.indexedPositionsBetween(
          pathHandle,
          fromOffset,
          toOffset,
        )
        const runs = rowidRuns(positions.map(p => p.pos.node))
        await Promise.all(
          runs.map(([lo, hi]) => this.db.prefetchRecords(lo, hi + 2)),
        )
      }
    }
    return first
  }

  async aroundInterval(start: PathPosition, len: number, context: number) {
    if (len === 0) {
      throw new Error('Interval length must be greater than 0')
    }
    this.walkedBp = 0
    try {
      return await this.walkInterval(start, len, context)
    } catch (error) {
      throw error instanceof SubgraphLimitError && error.windowBp === undefined
        ? new SubgraphLimitError(error.limit, {
            windowBp: len,
            walkedBp: this.walkedBp,
          })
        : error
    }
  }

  get referenceWalkedBp() {
    return this.walkedBp
  }

  private async walkInterval(
    start: PathPosition,
    len: number,
    context: number,
  ) {
    let pos: Pos = { node: start.handle, offset: start.gbwtOffset }
    let offset = start.nodeOffset
    let remaining = len
    const active = new SideQueue()
    for (;;) {
      const id = nodeId(pos.node)
      const orientation = nodeOrientation(pos.node)
      this.walkedBp = len - remaining
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
    this.walkedBp = len
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

  // Narrows an identified subgraph to the reference walk and the named walks
  // `wanted` accepts, and drops every node only the discarded walks visited,
  // so a cut for a chosen set draws that set's private sequence and nothing
  // else's. Unresolved walks are discarded with the rest.
  keepHaplotypes(wanted: (name: PathName) => boolean) {
    const refInfo =
      this.refId === undefined ? undefined : this.paths[this.refId]
    const kept = this.paths.filter(
      (info, index) =>
        index === this.refId ||
        (info.identity !== undefined && wanted(info.identity.name)),
    )
    const visited = new Set<number>()
    for (const info of kept) {
      for (const handle of info.path) {
        visited.add(nodeId(handle))
      }
    }
    for (const handle of [...this.records.keys()]) {
      if (!visited.has(nodeId(handle))) {
        this.records.delete(handle)
      }
    }
    this.paths = kept
    this.refId = refInfo === undefined ? undefined : kept.indexOf(refInfo)
  }

  // Builds the window for a chosen set from the companion's anchor rows: the
  // reference walk through the window from the anchor the index names for the
  // multiple of the spacing at or before the window, and for every wanted path
  // visiting that anchor node, the path's own walk from its row through the
  // window, named without a chain walk. Returns the reason the caller has to
  // fall back to the sampled route instead, or undefined when the subgraph is
  // complete.
  async walkHaplotypesFromAnchor(
    reference: ReferencePath,
    len: number,
    spacing: number,
    wanted: (name: PathName) => boolean,
    context: number,
  ) {
    const windowStart = reference.position.seqOffset
    const windowEnd = windowStart + len
    const anchorOffset = Math.floor(windowStart / spacing) * spacing
    const margin = Math.min(spacing, ANCHOR_WALK_MARGIN)
    const bound = 4 * (spacing + len) + margin
    const stats: AnchorWalkStats = {
      spacing,
      anchorOffset,
      anchorNodeOffset: -1,
      anchorHandle: -1,
      referenceSteps: 0,
      rows: 0,
      walks: [],
      graphFetches: 0,
      scans: [],
      scanRows: 0,
      fallback: undefined,
      ms: { reference: 0, rows: 0, walks: 0, scan: 0, sampled: 0 },
    }
    this.stats.anchorWalk = stats
    let clock = performance.now()
    const lap = () => {
      const now = performance.now()
      const elapsed = now - clock
      clock = now
      return elapsed
    }
    this.clearPaths()
    this.records.clear()
    const read = this.recordReader(() => {
      stats.graphFetches += 1
    })
    const named = await this.db.haplotypeAnchor(reference.handle, anchorOffset)
    if (named === undefined) {
      throw new Error(
        `The haplotype index names no anchor for ${formatPathName(reference.name, reference.name.fragment)} at offset ${anchorOffset}; it was not built with anchors at ${spacing} bp for this graph`,
      )
    }
    stats.anchorNodeOffset = named.pathOffset
    const indexed = await this.prefetchReferenceRange(
      reference.handle,
      named.pathOffset,
      windowEnd + margin,
    )
    if (!indexed) {
      throw new Error(
        `Path ${formatPathName(reference.name, reference.name.fragment)} has not been indexed for random access`,
      )
    }
    const reach = await this.walkReference(
      read,
      indexed,
      named,
      windowStart,
      windowEnd,
      windowEnd + margin,
    )
    const { anchor, refOffsetOf, refHandles, windowSteps } = reach
    stats.anchorHandle = anchor.pos.node
    stats.referenceSteps = reach.steps
    this.walkedBp = len
    const refPath: number[] = []
    const refOffsets: number[] = []
    let refLen = 0
    for (const step of windowSteps) {
      await this.ensureNode(nodeId(step.pos.node))
      refPath.push(step.pos.node)
      refOffsets.push(step.pos.offset)
      refLen += this.record(step.pos.node).sequenceLen
    }
    const firstStep = windowSteps[0]
    if (firstStep === undefined) {
      throw new Error('The reference walk has no node in the window')
    }
    this.refPath = reference.name
    this.refHandle = reference.handle
    this.refInterval = [firstStep.refOffset, firstStep.refOffset + refLen]
    this.refId = 0
    this.paths.push({
      path: refPath,
      offsets: refOffsets,
      len: refLen,
      weight: undefined,
      identity: {
        pathHandle: reference.handle,
        name: reference.name,
        orientation: 'forward',
        hapStart: firstStep.refOffset,
        hapEnd: firstStep.refOffset + refLen,
      },
    })
    stats.ms.reference = lap()
    const rows = await this.db.haplotypeSamplesAtNode(anchor.pos.node)
    stats.rows = rows.length
    stats.ms.rows = lap()
    const ownRow = rows.find(
      row =>
        row.offset === anchor.pos.offset &&
        row.pathHandle === reference.handle &&
        row.pathOffset === anchor.offset,
    )
    if (ownRow === undefined) {
      throw new Error(
        `The haplotype index has no anchor row for ${formatPathName(reference.name, reference.name.fragment)} at offset ${anchor.offset} (node ${nodeId(anchor.pos.node)}); it was not built with anchors at ${spacing} bp for this graph`,
      )
    }
    const pathsByHandle = await this.db.pathsByHandle()
    const nameOf = (pathHandle: number) => {
      const path = pathsByHandle.get(pathHandle)
      if (!path) {
        throw new Error(`Path ${pathHandle} is missing from the database`)
      }
      return path.name
    }
    const handled = new Set<number>([reference.handle])
    const visitsByPath = new Map<number, HaplotypeSample[]>()
    for (const row of rows) {
      if (row !== ownRow && wanted(nameOf(row.pathHandle))) {
        const visits = visitsByPath.get(row.pathHandle)
        if (visits) {
          visits.push(row)
        } else {
          visitsByPath.set(row.pathHandle, [row])
        }
      }
    }
    // A path through a duplicated stretch visits the anchor node more than
    // once, and only one visit is followed by the window. GBWT rows sit in
    // the order of the sequence before them, so the visit nearest the
    // reference's own row is tried first, and the path fails only when no
    // visit reaches the window's end.
    let fallback: string | undefined
    for (const [pathHandle, visits] of visitsByPath) {
      if (fallback === undefined) {
        const nearest = (row: HaplotypeSample) =>
          Math.abs(row.offset - ownRow.offset)
        visits.sort((x, y) => nearest(x) - nearest(y))
        let reason: string | undefined
        for (const visit of visits) {
          if (!handled.has(pathHandle)) {
            reason = await this.walkAndKeep(
              read,
              visit,
              'anchor',
              nameOf(pathHandle),
              refOffsetOf,
              windowEnd,
              bound,
              context,
              handled,
              stats,
            )
          }
        }
        if (!handled.has(pathHandle)) {
          fallback = reason
        }
      }
    }
    stats.ms.walks = lap()
    const unwalked =
      fallback === undefined
        ? await this.samplesOfUnwalkedContigs(
            refPath,
            refOffsetOf,
            refHandles,
            wanted,
            handled,
            nameOf,
            stats,
          )
        : new Map<number, HaplotypeSample[]>()
    stats.ms.scan = lap()
    if (unwalked.size > 0) {
      await this.mapReferenceBefore(
        read,
        reference.handle,
        Math.max(0, named.pathOffset - 2 * spacing),
        named.pathOffset,
        refOffsetOf,
        refHandles,
      )
      for (const [pathHandle, samples] of unwalked) {
        if (fallback === undefined) {
          const name = nameOf(pathHandle)
          let entry: HaplotypeSample | undefined
          for (const sample of samples) {
            entry ??= await this.entryBefore(
              read,
              sample,
              refOffsetOf,
              refHandles,
              this.refInterval[0],
              bound,
            )
          }
          fallback =
            entry === undefined
              ? `no sample of ${formatPathName(name, name.fragment)} on the window's nodes runs with the reference`
              : await this.walkAndKeep(
                  read,
                  entry,
                  'sample',
                  name,
                  refOffsetOf,
                  windowEnd,
                  bound,
                  context,
                  handled,
                  stats,
                )
        }
      }
      stats.ms.sampled = lap()
    }
    stats.fallback = fallback
    return fallback
  }

  private async walkAndKeep(
    read: (handle: number) => Promise<GbzRecord>,
    row: HaplotypeSample,
    from: 'anchor' | 'sample',
    name: PathName,
    refOffsetOf: Map<number, number>,
    windowEnd: number,
    bound: number,
    context: number,
    handled: Set<number>,
    stats: AnchorWalkStats,
  ) {
    const walked = await this.walkFromRow(
      read,
      row,
      name,
      refOffsetOf,
      this.refInterval![0],
      windowEnd,
      bound,
      context,
    )
    stats.walks.push({
      pathHandle: row.pathHandle,
      from,
      steps: walked.steps,
      pieces: walked.infos.length,
      end: walked.end,
    })
    let reason: string | undefined
    if (walked.end === 'bound' || walked.end === 'cycle') {
      reason = `${formatPathName(name, row.pathOffset)} walked ${walked.steps} steps from its ${from} without reaching the window's end (${walked.end})`
    } else {
      handled.add(row.pathHandle)
      this.paths.push(...walked.infos)
    }
    return reason
  }

  // Adds the reference nodes of an earlier stretch to the map, so a walk
  // back from a sample can stop on the reference before the window even
  // when the contig rejoined it before the anchor.
  private async mapReferenceBefore(
    read: (handle: number) => Promise<GbzRecord>,
    pathHandle: number,
    fromOffset: number,
    toOffset: number,
    refOffsetOf: Map<number, number>,
    refHandles: Set<number>,
  ) {
    const indexed = await this.prefetchReferenceRange(
      pathHandle,
      fromOffset,
      toOffset,
    )
    let pos: Pos | undefined = indexed?.pos
    let offset = indexed?.pathOffset ?? toOffset
    while (pos !== undefined && pos.node !== ENDMARKER && offset < toOffset) {
      this.signal?.throwIfAborted()
      const record = await read(pos.node)
      const id = nodeId(pos.node)
      if (!refOffsetOf.has(id)) {
        refOffsetOf.set(id, offset)
        refHandles.add(pos.node)
      }
      offset += record.sequenceLen
      pos = record.gbwt().lf(pos.offset)
    }
  }

  // Whether a per-path sample's orientation of its path runs the reference's
  // way. A sample on a mapped reference node says so by its handle; from one
  // on another node the path is followed forward to the first mapped node.
  // Both orientations of a path are sampled, so the wrong one is simply
  // skipped in favour of a sample of the other.
  private async runsWithReference(
    read: (handle: number) => Promise<GbzRecord>,
    sample: HaplotypeSample,
    refOffsetOf: Map<number, number>,
    refHandles: Set<number>,
    bound: number,
  ) {
    let pos: Pos | undefined = { node: sample.node, offset: sample.offset }
    let walked = 0
    let verdict: boolean | undefined
    while (verdict === undefined) {
      this.signal?.throwIfAborted()
      if (pos === undefined || pos.node === ENDMARKER || walked > bound) {
        verdict = false
      } else if (refOffsetOf.has(nodeId(pos.node))) {
        verdict = refHandles.has(pos.node)
      } else {
        const record = await read(pos.node)
        walked += record.sequenceLen
        pos = record.gbwt().lf(pos.offset)
      }
    }
    return verdict
  }

  // Walks back from a per-path sample on one of the window's nodes, through
  // the bidirectional GBWT, to the first reference node before the window or
  // the contig's start, and returns that position as a row an anchored walk
  // can start from; undefined for a sample whose orientation runs against the
  // reference, since walking on from it would leave the window backwards. A
  // sample the bound is reached from lies in a private stretch longer than
  // the bound, so the walk starts at the sample itself: what came before it
  // shares nothing with the reference in reach.
  private async entryBefore(
    read: (handle: number) => Promise<GbzRecord>,
    sample: HaplotypeSample,
    refOffsetOf: Map<number, number>,
    refHandles: Set<number>,
    windowStart: number,
    bound: number,
  ): Promise<HaplotypeSample | undefined> {
    const sampleLen = (await read(sample.node)).sequenceLen
    const rowAt = async (
      pos: Pos,
      bpBack: number,
    ): Promise<HaplotypeSample> => {
      const len = (await read(pos.node)).sequenceLen
      return {
        node: pos.node,
        offset: pos.offset,
        pathHandle: sample.pathHandle,
        orientation: sample.orientation,
        pathOffset:
          sample.orientation === 'forward'
            ? sample.pathOffset - bpBack
            : sample.pathOffset + sampleLen + bpBack - len,
      }
    }
    let pos: Pos = { node: sample.node, offset: sample.offset }
    let bpBack = 0
    let entry: HaplotypeSample | undefined
    let done = !(await this.runsWithReference(
      read,
      sample,
      refOffsetOf,
      refHandles,
      bound,
    ))
    while (!done) {
      this.signal?.throwIfAborted()
      const refOffset = refOffsetOf.get(nodeId(pos.node))
      if (refOffset !== undefined && refOffset < windowStart) {
        entry = await rowAt(pos, bpBack)
        done = true
      } else if (bpBack > bound) {
        entry = { ...sample }
        done = true
      } else {
        const flipped = await read(flipNode(pos.node))
        const predecessor = flipped.gbwt().predecessorAt(pos.offset)
        if (predecessor === undefined) {
          entry = await rowAt(pos, bpBack)
          done = true
        } else {
          const record = await read(predecessor)
          const offset = record.gbwt().offsetTo(pos)
          if (offset === undefined) {
            throw new Error(
              `No offset in ${predecessor} leads to ${pos.node}:${pos.offset}`,
            )
          }
          pos = { node: predecessor, offset }
          bpBack += record.sequenceLen
        }
      }
    }
    return entry
  }

  // Walks the reference from an indexed position at or before the named
  // anchor to the end of the mapped stretch past the window, without adding
  // those nodes to the subgraph: what comes back is the anchor node's
  // position, every mapped node's reference offset and handle, and the
  // window's steps.
  private async walkReference(
    read: (handle: number) => Promise<GbzRecord>,
    indexed: IndexedPosition,
    named: HaplotypeAnchor,
    windowStart: number,
    windowEnd: number,
    mappedEnd: number,
  ) {
    const refOffsetOf = new Map<number, number>()
    const refHandles = new Set<number>()
    const windowSteps: { pos: Pos; refOffset: number }[] = []
    let anchor: { pos: Pos; offset: number } | undefined
    let pos: Pos | undefined = indexed.pos
    let offset = indexed.pathOffset
    let steps = 0
    while (pos !== undefined && pos.node !== ENDMARKER && offset < mappedEnd) {
      this.signal?.throwIfAborted()
      const record = await read(pos.node)
      const end = offset + record.sequenceLen
      if (anchor === undefined && offset === named.pathOffset) {
        if (pos.node !== named.node) {
          throw new Error(
            `The reference walk reaches node ${nodeId(pos.node)} at offset ${offset} where the haplotype index names node ${nodeId(named.node)} as the anchor`,
          )
        }
        anchor = { pos, offset }
      }
      if (anchor !== undefined) {
        steps += 1
        const id = nodeId(pos.node)
        if (!refOffsetOf.has(id)) {
          refOffsetOf.set(id, offset)
          refHandles.add(pos.node)
        }
        if (offset < windowEnd && end > windowStart) {
          windowSteps.push({ pos, refOffset: offset })
        }
      }
      offset = end
      pos = record.gbwt().lf(pos.offset)
    }
    if (anchor === undefined) {
      throw new Error(
        `The reference walk from offset ${indexed.pathOffset} never starts a node at the anchor offset ${named.pathOffset}`,
      )
    }
    return { anchor, refOffsetOf, refHandles, windowSteps, steps }
  }

  // One path's walk from its anchor row: forward with lf() until it lands on
  // a reference node inside the window, then every node until it lands on a
  // reference node at or past the window's end. A private stretch longer
  // than the context cuts the walk into pieces, as leaving the subgraph does
  // on the sampled route, and its nodes stay out of the cut; the pieces are
  // joined again by the alignment where they are monotone. Trailing private
  // steps are dropped, so a walk off the reference's end carries none.
  private async walkFromRow(
    read: (handle: number) => Promise<GbzRecord>,
    row: HaplotypeSample,
    name: PathName,
    refOffsetOf: Map<number, number>,
    windowStart: number,
    windowEnd: number,
    bound: number,
    context: number,
  ): Promise<{
    steps: number
    end: AnchorWalkEnd
    infos: PathInfo[]
  }> {
    const startLen = (await read(row.node)).sequenceLen
    const base =
      row.orientation === 'forward' ? row.pathOffset : row.pathOffset + startLen
    const pieces: WalkStep[][] = []
    let piece: WalkStep[] = []
    let pending: WalkStep[] = []
    let pendingBp = 0
    const visited = new Set<string>()
    let counter = 0
    let steps = 0
    let startBp: number | undefined
    let end: AnchorWalkEnd | undefined
    let pos: Pos | undefined = { node: row.node, offset: row.offset }
    while (end === undefined) {
      this.signal?.throwIfAborted()
      if (pos === undefined || pos.node === ENDMARKER) {
        end =
          startBp === undefined ? 'before the window' : 'ended in the window'
      } else if (counter > bound) {
        end = 'bound'
      } else if (visited.has(posKey(pos))) {
        end = 'cycle'
      } else {
        visited.add(posKey(pos))
        const refOffset = refOffsetOf.get(nodeId(pos.node))
        const inWindow = startBp !== undefined
        if (refOffset !== undefined && refOffset >= windowEnd) {
          end = inWindow ? 'through the window' : 'past the window'
        } else {
          if (
            !inWindow &&
            refOffset !== undefined &&
            refOffset >= windowStart
          ) {
            startBp = counter
          }
          const record = await read(pos.node)
          if (startBp !== undefined) {
            const step = { pos, at: counter, len: record.sequenceLen }
            if (refOffset === undefined) {
              pending.push(step)
              pendingBp += step.len
            } else {
              if (pendingBp > context) {
                pieces.push(piece)
                piece = []
              } else {
                piece.push(...pending)
              }
              pending = []
              pendingBp = 0
              piece.push(step)
            }
          }
          steps += 1
          counter += record.sequenceLen
          pos = record.gbwt().lf(pos.offset)
        }
      }
    }
    pieces.push(piece)
    const infos: PathInfo[] = []
    for (const steps of pieces) {
      const first = steps[0]
      const last = steps[steps.length - 1]
      if (first !== undefined && last !== undefined) {
        const path: number[] = []
        const offsets: number[] = []
        let len = 0
        for (const step of steps) {
          await this.ensureNode(nodeId(step.pos.node))
          path.push(step.pos.node)
          offsets.push(step.pos.offset)
          len += step.len
        }
        const from = first.at
        const to = last.at + last.len
        infos.push({
          path,
          offsets,
          len,
          weight: undefined,
          identity:
            row.orientation === 'forward'
              ? {
                  pathHandle: row.pathHandle,
                  name,
                  orientation: 'forward',
                  hapStart: base + from,
                  hapEnd: base + to,
                }
              : {
                  pathHandle: row.pathHandle,
                  name,
                  orientation: 'reverse',
                  hapStart: base - to,
                  hapEnd: base - from,
                },
        })
      }
    }
    return { steps, end, infos }
  }

  // A wanted contig that bypassed the anchor node, or starts inside the
  // window, has no row at the anchor. Its per-path samples on the window's
  // nodes are how the sampled route finds it, so those are scanned, and the
  // candidate samples of each wanted path no anchor row walked come back:
  // those on a reference node in the reference's own direction first, then
  // those on other nodes, whose direction a probe settles; a sample on the
  // flipped handle of a reference node runs against it and is left out.
  private async samplesOfUnwalkedContigs(
    refPath: number[],
    refOffsetOf: Map<number, number>,
    refHandles: Set<number>,
    wanted: (name: PathName) => boolean,
    handled: Set<number>,
    nameOf: (pathHandle: number) => PathName,
    stats: AnchorWalkStats,
  ) {
    const runs = handleRuns([...refPath].sort((a, b) => a - b))
    stats.scans = runs
    const unwalked = new Map<number, HaplotypeSample[]>()
    for (const [first, last] of runs) {
      const samples = await this.db.haplotypeSamplesInRange(first, last)
      stats.scanRows += samples.length
      for (const sample of samples) {
        const onReference = refOffsetOf.has(nodeId(sample.node))
        if (
          !handled.has(sample.pathHandle) &&
          (!onReference || refHandles.has(sample.node)) &&
          wanted(nameOf(sample.pathHandle))
        ) {
          const candidates = unwalked.get(sample.pathHandle) ?? []
          if (onReference) {
            candidates.unshift(sample)
          } else {
            candidates.push(sample)
          }
          unwalked.set(sample.pathHandle, candidates)
        }
      }
    }
    return unwalked
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
    appendGap(edits, pathLen - prefix - suffix, refLen - prefix - suffix)
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
    const refPrefix = this.refPrefix(ref)
    const alignGap = (
      pathFrom: number,
      pathTo: number,
      refFrom: number,
      refTo: number,
    ) => {
      if (pathFrom === pathTo) {
        appendEdit(edits, 'D', refPrefix[refTo]! - refPrefix[refFrom]!)
      } else if (refFrom === refTo) {
        appendEdit(edits, 'I', this.pathLen(path.slice(pathFrom, pathTo)))
      } else {
        this.align(
          path.slice(pathFrom, pathTo),
          ref.slice(refFrom, refTo),
          edits,
        )
      }
    }
    let matched = 0
    let pathOffset = 0
    let refOffset = 0
    for (const [nextPath, nextRef] of lcs) {
      alignGap(pathOffset, nextPath, refOffset, nextRef)
      const nodeLen = this.record(path[nextPath]!).sequenceLen
      appendEdit(edits, 'M', nodeLen)
      matched += nodeLen
      pathOffset = nextPath + 1
      refOffset = nextRef + 1
    }
    alignGap(pathOffset, path.length, refOffset, ref.length)
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
    const fragments: FragmentAlignment[] = []
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
      fragments.push({
        strand: alongReference ? '+' : '-',
        refStart: reference.start + leading,
        refEnd: reference.start + refTotal - trailing,
        edits: edits.slice(first, last),
        weight: info.weight,
        path: info.path,
        start: pathPosition(info, 0),
        identity:
          identity === undefined
            ? undefined
            : {
                pathHandle: identity.pathHandle,
                name: identity.name,
                hapStart: identity.name.fragment + identity.hapStart,
                hapEnd: identity.name.fragment + identity.hapEnd,
                walkForward: identity.orientation === 'forward',
              },
      })
    })
    return joinSiblings(fragments).map(fragment => {
      const { edits, identity, ...rest } = fragment
      const span: AlignmentSpan = { ...rest, cigar: cigarOf(edits) }
      return identity
        ? {
            ...span,
            resolved: true,
            name: identity.name,
            label: formatPathName(
              { ...identity.name, fragment: identity.hapStart },
              identity.hapEnd,
            ),
            pathHandle: identity.pathHandle,
            hapStart: identity.hapStart,
            hapEnd: identity.hapEnd,
          }
        : { ...span, resolved: false }
    })
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
      identity: PathIdentity | undefined,
      name: PathName,
      end: number,
      cigarString: string | undefined,
    ) => {
      const steps = haplotypeOrderedPath(info, identity)
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
          undefined,
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
                resolved,
                {
                  ...resolved.name,
                  fragment: resolved.name.fragment + resolved.hapStart,
                },
                resolved.name.fragment + resolved.hapEnd,
                cigarString,
              )
            : walk(
                info,
                undefined,
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
          undefined,
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
        jsonPath(
          info,
          resolved,
          name,
          cigar ? this.alignToRef(index) : undefined,
        ),
      )
      haplotype += 1
    })
    return { nodes, edges, paths }
  }
}

// A named walk lists its steps in the haplotype's own direction, as the W line
// spec and the start..end coordinates beside it require. extractPaths keeps
// whichever twin of a walk is canonical, which is a property of the handles
// and not of the haplotype, so the kept walk runs against the haplotype for
// about half of them; identification records which.
function haplotypeOrderedPath(
  info: PathInfo,
  identity: PathIdentity | undefined,
) {
  return identity?.orientation === 'reverse'
    ? info.path.map(handle => flipNode(handle)).reverse()
    : info.path
}

function jsonPath(
  info: PathInfo,
  identity: PathIdentity | undefined,
  name: string,
  cigar: string | undefined,
): SubgraphPath {
  return {
    name,
    ...(info.weight === undefined ? {} : { weight: info.weight }),
    ...(cigar === undefined ? {} : { cigar }),
    path: haplotypeOrderedPath(info, identity).map(handle => ({
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

function appendGap(edits: Edit[], pathMiddle: number, refMiddle: number) {
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
}

function cigarOf(edits: Edit[]) {
  return edits.map(([op, len]) => `${len}${op}`).join('')
}
