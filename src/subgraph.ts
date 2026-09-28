import { extractionOrder, findChosenPieces, handleRuns } from './chosenPaths.ts'
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
import { pairAlignments, pairCigar } from './pairAlignment.ts'
import { formatPathName } from './pathName.ts'

import type { ChosenPiece, KeepStats } from './chosenPaths.ts'
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

// A step, and either end of an edge, is a GBWT handle: 2 * nodeId for the
// forward orientation and 2 * nodeId + 1 for the reverse, which is how the
// GBWT itself numbers them. nodeId and isReverse read the two halves back.
export interface CompactPath {
  name: string
  weight: number | undefined
  cigar: string | undefined
  steps: Int32Array
}

export interface CompactSubgraph {
  // Ascending, one entry per node; nodeSequences runs parallel to it.
  nodeIds: Int32Array
  nodeSequences: string[]
  // Handle pairs laid end to end: edges[2i] -> edges[2i + 1].
  edges: Int32Array
  paths: CompactPath[]
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

export interface HaplotypeRef {
  sample: string
  haplotype: number
}

export interface PairAlignmentOptions {
  target: HaplotypeRef
  query?: HaplotypeRef
  maxGap?: number
  bases?: boolean
}

export interface PairAlignment {
  query: PathName
  queryStart: number
  queryEnd: number
  strand: '+' | '-'
  target: PathName
  targetStart: number
  targetEnd: number
  cigar: string
  matches: number
  columns: number
  sharedBases: number
}

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

// Which step of a walk matches which step of the reference, as two parallel
// arrays rather than a list of pairs: there is one entry per step of every
// walk being aligned, and a window at HPRC scale has millions of them.
interface Matches {
  pathAt: Int32Array
  refAt: Int32Array
  count: number
}

function asMatches(pairs: [number, number][]): Matches {
  const pathAt = new Int32Array(pairs.length)
  const refAt = new Int32Array(pairs.length)
  pairs.forEach(([a, b], i) => {
    pathAt[i] = a
    refAt[i] = b
  })
  return { pathAt, refAt, count: pairs.length }
}

// The first entry above `bound` of an ascending list, or undefined. Called
// once per step of every walk being aligned, which is where `Array.find` hurt:
// it allocated a closure over the bound each time, and scanned from the front
// of a reference node's occurrence list, which a repeat locus makes long.
function firstAbove(ascending: number[], bound: number) {
  let lo = 0
  let hi = ascending.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ascending[mid]! > bound) {
      hi = mid
    } else {
      lo = mid + 1
    }
  }
  return ascending[lo]
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
  // Indices into the subgraph's paths, in walk order, and the bases of each
  // that the CIGAR aligns when the piece is aligned alone.
  pieces: number[]
  soloAligned: number[]
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

function flipPath(path: number[]) {
  return path.map(handle => flipNode(handle)).reverse()
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
    pieces: [...first.pieces, ...second.pieces],
    soloAligned: [...first.soloAligned, ...second.soloAligned],
    identity: {
      pathHandle: a.identity!.pathHandle,
      name: a.identity!.name,
      hapStart: a.identity!.hapStart,
      hapEnd: b.identity!.hapEnd,
      walkForward,
    },
  }
}

// Pieces of one path in haplotype order, joined where they are colinear on
// the reference, and otherwise aligned again as one walk. A piece aligned over
// less than half its length joins only between two that are.
function joinSiblings(
  fragments: FragmentAlignment[],
  mostlyAligned: (fragment: FragmentAlignment) => boolean,
  alignJointly: (parts: FragmentAlignment[]) => FragmentAlignment | undefined,
) {
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
    let between: number[] = []
    for (const index of siblings.slice(1)) {
      const next = fragments[index]!
      const gap = between.length === 0 ? joinable(current, next) : undefined
      if (gap) {
        current = joinPair(current, next, gap)
        consumed.add(index)
        continue
      }
      if (!mostlyAligned(next)) {
        between.push(index)
        continue
      }
      const joint = mostlyAligned(current)
        ? alignJointly([current, ...between.map(i => fragments[i]!), next])
        : undefined
      if (joint) {
        current = joint
        for (const i of [...between, index]) {
          consumed.add(i)
        }
      } else {
        joined.set(head, current)
        head = index
        current = next
      }
      between = []
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
  keep: KeepStats | undefined
}

const PREFETCH_RUN_GAP = 32768

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
    keep: undefined,
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
    // One flat pair for the whole subgraph, indexed by rowStart[node] + offset,
    // rather than an Int32Array per node. walk() reads a successor on every one
    // of a window's steps — 9.9M of them at MHC class II — and through an array
    // of forty thousand small buffers each of those is a pointer chase into
    // scattered memory. The per-node arrays die before the walking starts.
    const rowStart = new Int32Array(count + 1)
    const seqLen = new Int32Array(count)
    const rows: { nodes: Int32Array; offsets: Int32Array }[] = []
    for (let i = 0; i < count; i++) {
      const record = this.record(handles[i]!)
      const row = record.gbwt().decompressArrays()
      seqLen[i] = record.sequenceLen
      rows.push(row)
      rowStart[i + 1] = rowStart[i]! + row.nodes.length
    }
    const positions = rowStart[count]!
    const nextIndex = new Int32Array(positions)
    const nextOffset = new Int32Array(positions)
    const hasPredecessor = new Uint8Array(positions)
    for (let i = 0; i < count; i++) {
      const row = rows[i]!
      nextIndex.set(row.nodes, rowStart[i])
      nextOffset.set(row.offsets, rowStart[i])
    }
    rows.length = 0
    for (let k = 0; k < positions; k++) {
      const j = indexOf.get(nextIndex[k]!)
      if (j === undefined) {
        nextIndex[k] = -1
      } else {
        nextIndex[k] = j
        hasPredecessor[rowStart[j]! + nextOffset[k]!] = 1
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
        const at = rowStart[cur]! + off
        const next = nextIndex[at]!
        if (next < 0) {
          break
        }
        off = nextOffset[at]!
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
        const from = rowStart[i]!
        const degree = rowStart[i + 1]! - from
        for (let offset = 0; offset < degree; offset++) {
          if (hasPredecessor[from + offset] === 0) {
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
        const from = rowStart[i]!
        const degree = rowStart[i + 1]! - from
        let startCount = 0
        for (let offset = 0; offset < degree; offset++) {
          if (hasPredecessor[from + offset] === 0) {
            startCount += 1
          }
        }
        const allTwins = !refMayStartReversed && startCount === twinsExpected[i]
        for (let offset = 0; offset < degree; offset++) {
          if (hasPredecessor[from + offset] === 0) {
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

  // The walks extractPaths and identifyPaths would give this subgraph for the
  // haplotypes `keep` accepts, found from the haplotype index without walking
  // the others. Returns false, leaving no walks, when the haplotype index
  // cannot show that the walks it found are all of them; the caller then
  // extracts and identifies every walk, and stats.keep.fallback says why.
  async extractChosenPaths(
    reference: ReferencePath,
    len: number,
    keep: (name: PathName) => boolean,
    context: number,
  ) {
    this.clearPaths()
    const start = reference.position.seqOffset
    const found = await findChosenPieces({
      db: this.db,
      records: this.records,
      referenceHandle: reference.handle,
      referencePos: {
        node: reference.position.handle,
        offset: reference.position.gbwtOffset,
      },
      referenceLeft: start - reference.position.nodeOffset,
      window: { start, end: start + len },
      context,
      keep,
      signal: this.signal,
      prefetchReferenceRange: (pathHandle, fromOffset, toOffset) =>
        this.prefetchReferenceRange(pathHandle, fromOffset, toOffset),
    })
    this.stats.keep = found.stats
    if (found.stats.fallback !== undefined) {
      return false
    }
    const pathsByHandle = await this.db.pathsByHandle()
    const infoOf = (piece: ChosenPiece): PathInfo => ({
      path: piece.handles,
      offsets: piece.offsets,
      len: piece.len,
      weight: undefined,
      identity: {
        pathHandle: piece.pathHandle,
        name:
          piece === found.reference
            ? reference.name
            : pathsByHandle.get(piece.pathHandle)!.name,
        orientation: piece.orientation,
        hapStart: piece.hapStart,
        hapEnd: piece.hapEnd,
      },
    })
    const ordered = [found.reference, ...found.pieces].sort(extractionOrder)
    this.paths = ordered.map(infoOf)
    this.refId = ordered.indexOf(found.reference)
    this.refPath = reference.name
    this.refHandle = reference.handle
    this.refInterval = [found.reference.hapStart, found.reference.hapEnd]
    return true
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

  private orderedMatches(path: number[], ref: number[]): Matches | undefined {
    const index = this.refIndex(ref)
    const pathAt = new Int32Array(path.length)
    const refAt = new Int32Array(path.length)
    let count = 0
    let last = -1
    for (let i = 0; i < path.length; i++) {
      const occurrences = index.get(path[i]!)
      if (occurrences) {
        const j = firstAbove(occurrences, last)
        if (j === undefined) {
          return undefined
        }
        pathAt[count] = i
        refAt[count] = j
        count += 1
        last = j
      }
    }
    return { pathAt, refAt, count }
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
      asMatches(
        weightedLcs(path, ref, handle => this.record(handle).sequenceLen)[0],
      )
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
    for (let m = 0; m < lcs.count; m++) {
      const nextPath = lcs.pathAt[m]!
      const nextRef = lcs.refAt[m]!
      // Adjacent matches are the overwhelming majority of a walk's steps, and
      // for those alignGap has nothing to append; only the gaps are worth a
      // call.
      if (pathOffset !== nextPath || refOffset !== nextRef) {
        alignGap(pathOffset, nextPath, refOffset, nextRef)
      }
      const nodeLen = this.record(path[nextPath]!).sequenceLen
      appendEdit(edits, 'M', nodeLen)
      matched += nodeLen
      pathOffset = nextPath + 1
      refOffset = nextRef + 1
    }
    alignGap(pathOffset, path.length, refOffset, ref.length)
    return { edits, matched, matches: lcs }
  }

  private alignment(pathIndex: number) {
    const info = this.paths[pathIndex]
    if (this.refId === undefined || pathIndex === this.refId || !info) {
      return undefined
    }
    const ref = this.paths[this.refId]!.path
    let result: { edits: Edit[]; matched: number; flipped: boolean }
    if (pathIsCanonical(ref)) {
      // A walk against a canonical reference has nothing to gain from being
      // flipped, so neither bound is worth the pass over its steps that
      // measuring one costs.
      result = { ...this.editsAgainst(info.path, ref), flipped: false }
    } else {
      const flippedPath = flipPath(info.path)
      const forwardBound = this.sharedWeight(info.path, ref)
      const flippedBound = this.sharedWeight(flippedPath, ref)
      if (flippedBound === 0) {
        result = { ...this.editsAgainst(info.path, ref), flipped: false }
      } else if (forwardBound === 0) {
        result = { ...this.editsAgainst(flippedPath, ref), flipped: true }
      } else {
        const forward = this.editsAgainst(info.path, ref)
        const flipped = this.editsAgainst(flippedPath, ref)
        result =
          flipped.matched > forward.matched
            ? { ...flipped, flipped: true }
            : { ...forward, flipped: false }
      }
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
    const fragment = (
      edits: Edit[],
      strand: '+' | '-',
      pieces: number[],
      soloAligned: number[],
    ): FragmentAlignment => {
      const trimmed = trimEnds(edits)
      const first = this.paths[pieces[0]!]!
      const last = this.paths[pieces[pieces.length - 1]!]!
      const identity = first.identity
      const walkForward = identity?.orientation === 'forward'
      const [low, high] = walkForward ? [first, last] : [last, first]
      return {
        strand,
        refStart: reference.start + trimmed.leading,
        refEnd: reference.start + refTotal - trimmed.trailing,
        edits: trimmed.edits,
        weight: first.weight,
        path: pieces.flatMap(index => this.paths[index]!.path),
        start: pathPosition(first, 0),
        pieces,
        soloAligned,
        identity:
          identity === undefined
            ? undefined
            : {
                pathHandle: identity.pathHandle,
                name: identity.name,
                hapStart: identity.name.fragment + low.identity!.hapStart,
                hapEnd: identity.name.fragment + high.identity!.hapEnd,
                walkForward,
              },
      }
    }
    // A walk that leaves the subgraph and comes back is two pieces here, and a
    // piece whose tail touches reference nodes past where the next piece
    // aligns cannot be joined after the fact. Aligned as one walk, with the
    // bases outside the subgraph as an insertion between the pieces, they read
    // as the detour they are. Each end of the join must be aligned over at
    // least half its length alone, which keeps out a pass hundreds of kb away
    // that the context reached through a rare edge, and must keep at least half
    // its aligned bases jointly, which keeps out the second pass of a collapsed
    // paralog. Pieces between the ends, often most of the detour, join with
    // them whatever their alignment.
    const aligned = (f: FragmentAlignment) =>
      f.soloAligned.reduce((sum, bases) => sum + bases, 0)
    const length = (f: FragmentAlignment) =>
      f.pieces.reduce((sum, index) => sum + this.paths[index]!.len, 0)
    const mostlyAligned = (f: FragmentAlignment) => 2 * aligned(f) >= length(f)
    const alignJointly = (parts: FragmentAlignment[]) => {
      const first = parts[0]!
      const last = parts[parts.length - 1]!
      const walkForward = first.identity!.walkForward
      if (
        parts.some(
          (part, k) =>
            part.strand !== first.strand ||
            part.identity!.walkForward !== walkForward ||
            (k > 0 && part.identity!.hapStart < parts[k - 1]!.identity!.hapEnd),
        )
      ) {
        return undefined
      }
      const inWalkOrder = walkForward ? parts : [...parts].reverse()
      const pieces = inWalkOrder.flatMap(part => part.pieces)
      const soloAligned = inWalkOrder.flatMap(part => part.soloAligned)
      const flipped = (first.strand === '+') !== walkForward
      const infos = pieces.map(index => this.paths[index]!)
      const gaps = infos.slice(1).map((info, k) => {
        const before = infos[k]!.identity!
        return walkForward
          ? info.identity!.hapStart - before.hapEnd
          : before.hapStart - info.identity!.hapEnd
      })
      const alignedInfos = flipped ? [...infos].reverse() : infos
      const alignedGaps = flipped ? [...gaps].reverse() : gaps
      const steps = alignedInfos.flatMap(info =>
        flipped ? flipPath(info.path) : info.path,
      )
      const { edits } = this.editsAgainst(steps, ref)
      const keptInOrder = alignedIn(
        edits,
        alignedInfos.map(info => info.len),
      )
      const kept = new Map(
        (flipped ? [...pieces].reverse() : pieces).map((index, k) => [
          index,
          keptInOrder[k]!,
        ]),
      )
      const keeps = (part: FragmentAlignment) =>
        2 * part.pieces.reduce((sum, index) => sum + kept.get(index)!, 0) >=
        aligned(part)
      if (!keeps(first) || !keeps(last)) {
        return undefined
      }
      const insertions: [number, number][] = []
      let walked = 0
      alignedInfos.slice(0, -1).forEach((info, k) => {
        walked += info.len
        insertions.push([walked, alignedGaps[k]!])
      })
      return fragment(
        spliceInsertions(edits, insertions),
        first.strand,
        pieces,
        soloAligned,
      )
    }
    const fragments: FragmentAlignment[] = []
    this.paths.forEach((info, index) => {
      if (index === this.refId) {
        return
      }
      const { edits, flipped } = this.alignment(index)!
      const identity = info.identity
      const alongReference = identity
        ? (identity.orientation === 'forward') !== flipped
        : !flipped
      fragments.push(
        fragment(
          edits,
          alongReference ? '+' : '-',
          [index],
          alignedIn(edits, [info.len]),
        ),
      )
    })
    return joinSiblings(fragments, mostlyAligned, alignJointly).map(joined => {
      const { edits, identity, pieces, soloAligned, ...rest } = joined
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

  // One haplotype's walks aligned to another's, on both haplotypes' own
  // coordinates, with the bases between two shared nodes compared unless bases
  // is false. The reference path is a named walk like any other, on either
  // side. With no query, every other named walk in the window is one.
  pairAlignments(opts: PairAlignmentOptions): PairAlignment[] {
    const { target, query, ...pairOptions } = opts
    const walks = this.paths.flatMap(info => {
      const { identity } = info
      return identity
        ? [
            {
              name: identity.name,
              start: identity.name.fragment + identity.hapStart,
              steps: haplotypeOrderedPath(info, identity),
            },
          ]
        : []
    })
    const names = (haplotype: HaplotypeRef) => (name: PathName) =>
      name.sample === haplotype.sample && name.haplotype === haplotype.haplotype
    const isTarget = names(target)
    const isQuery = query ? names(query) : (name: PathName) => !isTarget(name)
    const sequenceOf = (id: number) =>
      this.record(encodeNode(id, 'forward')).sequence
    return walks
      .filter(walk => isTarget(walk.name))
      .flatMap(targetWalk =>
        walks
          .filter(walk => isQuery(walk.name))
          .flatMap(queryWalk =>
            pairAlignments(
              queryWalk.steps,
              targetWalk.steps,
              sequenceOf,
              pairOptions,
            ).map(chain => ({
              query: queryWalk.name,
              queryStart: queryWalk.start + chain.queryStart,
              queryEnd: queryWalk.start + chain.queryEnd,
              strand: chain.strand,
              target: targetWalk.name,
              targetStart: targetWalk.start + chain.targetStart,
              targetEnd: targetWalk.start + chain.targetEnd,
              cigar: pairCigar(chain.edits),
              matches: chain.edits.reduce(
                (sum, [op, len]) => sum + (op === '=' ? len : 0),
                0,
              ),
              columns: chain.edits.reduce((sum, [, len]) => sum + len, 0),
              sharedBases: chain.sharedBases,
            })),
          ),
      )
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

  // The reference walk first under the interval it covers, then one entry per
  // haplotype in extraction order. Both outputs read this so a name, a weight
  // or a CIGAR cannot mean one thing in the upstream JSON and another in the
  // compact form.
  private outputPaths(opts: SubgraphOutputOptions) {
    const cigar = opts.cigar ?? false
    const entries: {
      info: PathInfo
      identity: PathIdentity | undefined
      name: string
      cigar: string | undefined
    }[] = []
    const contig = this.refPath?.contig ?? 'unknown'
    if (this.refId !== undefined && this.refPath && this.refInterval) {
      const start = {
        ...this.refPath,
        fragment: this.refPath.fragment + this.refInterval[0],
      }
      entries.push({
        info: this.paths[this.refId]!,
        identity: undefined,
        name: formatPathName(
          start,
          this.refPath.fragment + this.refInterval[1],
        ),
        cigar: undefined,
      })
    }
    let haplotype = 1
    this.paths.forEach((info, index) => {
      if (index === this.refId) {
        return
      }
      const identity = opts.names === 'resolved' ? info.identity : undefined
      entries.push({
        info,
        identity,
        name: identity
          ? formatPathName(
              {
                ...identity.name,
                fragment: identity.name.fragment + identity.hapStart,
              },
              identity.name.fragment + identity.hapEnd,
            )
          : formatPathName(
              { sample: 'unknown', contig, haplotype, fragment: 0 },
              info.len,
            ),
        cigar: cigar ? this.alignToRef(index) : undefined,
      })
      haplotype += 1
    })
    return entries
  }

  private *outputEdges() {
    for (const handle of this.sortedHandles()) {
      for (const successor of this.record(handle).successors()) {
        if (this.hasHandle(successor) && edgeIsCanonical(handle, successor)) {
          yield [handle, successor] as const
        }
      }
    }
  }

  toSubgraphJson(opts: SubgraphOutputOptions = {}): SubgraphJson {
    const nodes = this.sortedHandles()
      .filter(handle => !isReverse(handle))
      .map(handle => ({
        id: String(nodeId(handle)),
        sequence: this.record(handle).sequence,
      }))
    const edges: SubgraphJson['edges'] = []
    for (const [from, to] of this.outputEdges()) {
      edges.push({
        from: String(nodeId(from)),
        from_is_reverse: isReverse(from),
        to: String(nodeId(to)),
        to_is_reverse: isReverse(to),
      })
    }
    const paths = this.outputPaths(opts).map(entry =>
      jsonPath(entry.info, entry.identity, entry.name, entry.cigar),
    )
    return { nodes, edges, paths }
  }

  // The same subgraph as typed arrays of GBWT handles. toSubgraphJson spends
  // an object and a stringified id on every step of every walk, which a
  // 200 kb human window has about 350,000 of; this hands back the numbers the
  // extraction already holds, so it survives a structured clone into a worker
  // for about the cost of the memcpy rather than of rebuilding the objects.
  // Measured on HPRC chr20 CHM13#0#chr20 30.0-30.2 Mb, 5,943 nodes and 178
  // haplotypes: 295 ms to clone the upstream shape against 1.9 ms for this one.
  //
  // Packing the other two fields the way bam-js packs NUMERIC_SEQ and
  // NUMERIC_CIGAR was measured on the same window and rejected, because what
  // pays there is a long per-record field and both of these are short. Node
  // sequences average 34 bp: base-6 bytes plus offsets are 2.86x smaller but
  // cost more to build than to hand over the cached strings (1.07 ms against
  // 0.95 ms all in), and a consumer drawing the graph wants the strings for
  // every node anyway. CIGARs average 323 chars over 17,555 total ops: packing
  // them into one Int32Array per path is 1.7 ms against 2.4 ms to join the
  // strings, but then clones SLOWER (0.20 ms against 0.09 ms) because 178 small
  // typed arrays cost more than 178 strings. Steps are the only field here long
  // enough to be worth it. The CIGAR phase is 103 ms of edit computation and
  // 2 ms of string building, so neither field is where that time goes.
  toCompactSubgraph(opts: SubgraphOutputOptions = {}): CompactSubgraph {
    const forward = this.sortedHandles().filter(handle => !isReverse(handle))
    const nodeIds = new Int32Array(forward.length)
    const nodeSequences: string[] = []
    forward.forEach((handle, i) => {
      nodeIds[i] = nodeId(handle)
      nodeSequences.push(this.record(handle).sequence)
    })
    const edgeHandles: number[] = []
    for (const [from, to] of this.outputEdges()) {
      edgeHandles.push(from, to)
    }
    return {
      nodeIds,
      nodeSequences,
      edges: Int32Array.from(edgeHandles),
      paths: this.outputPaths(opts).map(entry => ({
        name: entry.name,
        weight: entry.info.weight,
        cigar: entry.cigar,
        steps: Int32Array.from(
          haplotypeOrderedPath(entry.info, entry.identity),
        ),
      })),
    }
  }
}

// The buffers a CompactSubgraph owns outright, for the transfer list of a
// postMessage that hands it to another thread. Transferring detaches them, so
// the sending side must not read the subgraph afterwards.
export function compactSubgraphTransferables(subgraph: CompactSubgraph) {
  return [
    subgraph.nodeIds.buffer,
    subgraph.edges.buffer,
    ...subgraph.paths.map(path => path.steps.buffer),
  ]
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

// A record starts and ends at an aligned base: the deletions in a run of
// insertions and deletions at either end move its reference start or end, and
// the insertions stay. An alignment with no aligned base keeps its insertion at
// the reference start.
function trimEnds(edits: Edit[]) {
  let first = 0
  while (first < edits.length && edits[first]![0] !== 'M') {
    first += 1
  }
  if (first === edits.length) {
    const inserted = edits.filter(([op]) => op === 'I')
    const trailing = edits
      .filter(([op]) => op === 'D')
      .reduce((sum, [, len]) => sum + len, 0)
    return {
      edits: inserted.map(([op, len]): Edit => [op, len]),
      leading: 0,
      trailing,
    }
  }
  let last = edits.length
  while (edits[last - 1]![0] !== 'M') {
    last -= 1
  }
  const ends = (run: Edit[]) => ({
    inserted: run.reduce((sum, [op, len]) => sum + (op === 'I' ? len : 0), 0),
    deleted: run.reduce((sum, [op, len]) => sum + (op === 'D' ? len : 0), 0),
  })
  const head = ends(edits.slice(0, first))
  const tail = ends(edits.slice(last))
  const trimmed: Edit[] = []
  appendEdit(trimmed, 'I', head.inserted)
  for (const [op, len] of edits.slice(first, last)) {
    appendEdit(trimmed, op, len)
  }
  appendEdit(trimmed, 'I', tail.inserted)
  return { edits: trimmed, leading: head.deleted, trailing: tail.deleted }
}

// The bases the CIGAR aligns within each of consecutive stretches of the walk.
function alignedIn(edits: Edit[], lengths: number[]) {
  const aligned = lengths.map(() => 0)
  const last = lengths.length - 1
  let piece = 0
  let pieceEnd = lengths[0]!
  let walked = 0
  for (const [op, len] of edits) {
    if (op === 'D') {
      continue
    }
    let rest = len
    while (rest > 0) {
      while (piece < last && walked >= pieceEnd) {
        piece += 1
        pieceEnd += lengths[piece]!
      }
      const step = piece < last ? Math.min(rest, pieceEnd - walked) : rest
      if (op === 'M') {
        aligned[piece]! += step
      }
      walked += step
      rest -= step
    }
  }
  return aligned
}

// Insertions at walk offsets, after any deletions that end at the same offset.
function spliceInsertions(edits: Edit[], insertions: [number, number][]) {
  const spliced: Edit[] = []
  let walked = 0
  let next = 0
  for (const [op, len] of edits) {
    if (op === 'D') {
      appendEdit(spliced, op, len)
      continue
    }
    let from = walked
    while (next < insertions.length && insertions[next]![0] < walked + len) {
      const [at, inserted] = insertions[next]!
      appendEdit(spliced, op, at - from)
      appendEdit(spliced, 'I', inserted)
      from = at
      next += 1
    }
    appendEdit(spliced, op, walked + len - from)
    walked += len
  }
  for (; next < insertions.length; next++) {
    appendEdit(spliced, 'I', insertions[next]![1])
  }
  return spliced
}

function cigarOf(edits: Edit[]) {
  return edits.map(([op, len]) => `${len}${op}`).join('')
}
