import {
  ENDMARKER,
  flipNode,
  isReverse,
  nodeId,
  pathEndsAreCanonical,
} from './gbwt/node.ts'

import type {
  GBZBase,
  GbzRecord,
  HaplotypeAnchor,
  HaplotypeSample,
  HaplotypeStrayOptions,
} from './db.ts'
import type { Orientation } from './gbwt/node.ts'
import type { Pos } from './gbwt/record.ts'
import type { PathName } from './pathName.ts'
import type { SnarlFill, SnarlOutput } from './subgraph.ts'

const SCAN_GAP = 4096

// Runs of sorted handles close enough to read the haplotype index samples on
// them with one scan each.
export function handleRuns(sortedHandles: number[]) {
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

// How far a chain from a twin piece goes outside the subgraph before it stops.
export const CHAIN_BOUND = 32768

// Above this many chosen paths at the anchors, extracting and identifying
// every walk took less time than walking the chosen ones, on HPRC chr22 windows
// with 42 haplotypes. Tests raise it to run the walks on large sets.
export const keepTuning = { mostChosenPaths: 32 }

export type ChosenPieceSource =
  'reference' | 'section' | 'stray' | 'chain' | 'twin'

export interface ChosenPiece {
  pathHandle: number
  orientation: Orientation
  handles: number[]
  offsets: number[]
  len: number
  hapStart: number
  hapEnd: number
  canonical: boolean
  source: ChosenPieceSource
}

export type KeepWalkEnd =
  'merge' | 'landed' | 'bound' | 'endmarker' | 'past the far anchor'

export interface KeepStats {
  spacing: number | undefined
  // The anchors before and after the window.
  anchors: [number, number] | undefined
  // The anchors within the walks' bound of the bins the window touches, and
  // one beyond on each side.
  anchorsRead: number
  chosenPaths: number
  scans: [number, number][]
  scanRows: number
  // The bins the window touches, the stray rows read in them, those of chosen
  // paths walked, and the bases all walks took outside the subgraph.
  strays:
    | { bins: number; rows: number; walked: number; outsideBp: number }
    | undefined
  pieces: number
  sources: Record<ChosenPieceSource, number>
  walks: Record<string, number>
  twins: { tried: number; found: number }
  graphFetches: number
  // Why the query extracted and identified every walk instead, when it did.
  fallback: string | undefined
  ms: {
    scan: number
    walks: number
    check: number
    twins: number
  }
}

export interface ChosenPathsInput {
  db: GBZBase
  records: Map<number, GbzRecord>
  referenceHandle: number
  referencePos: Pos
  referenceLeft: number
  window: { start: number; end: number }
  context: number
  // The snarls the subgraph filled and the nodes those fills added.
  snarls: { mode: SnarlOutput; fills: SnarlFill[]; inserted: Set<number> }
  keep: (name: PathName) => boolean
  signal: AbortSignal | undefined
  prefetchReferenceRange: (
    pathHandle: number,
    fromOffset: number,
    toOffset: number,
  ) => Promise<unknown>
}

interface Cursor {
  pos: Pos
  left: number
}

class PositionIndex {
  private byNode = new Map<number, Map<number, number>>()

  get(pos: Pos) {
    return this.byNode.get(pos.node)?.get(pos.offset)
  }

  set(pos: Pos, id: number) {
    let offsets = this.byNode.get(pos.node)
    if (!offsets) {
      offsets = new Map()
      this.byNode.set(pos.node, offsets)
    }
    offsets.set(pos.offset, id)
  }
}

class Fallback extends Error {}

function forwardLeft(
  orientation: Orientation,
  left: number,
  currentLen: number,
  nextLen: number,
) {
  return orientation === 'forward' ? left + currentLen : left - nextLen
}

function backwardLeft(
  orientation: Orientation,
  left: number,
  currentLen: number,
  previousLen: number,
) {
  return orientation === 'forward' ? left - previousLen : left + currentLen
}

function twinIsCanonical(piece: ChosenPiece) {
  return pathEndsAreCanonical(
    flipNode(piece.handles[piece.handles.length - 1]!),
    flipNode(piece.handles[0]!),
  )
}

function pieceKey(piece: ChosenPiece) {
  return `${piece.pathHandle}:${piece.hapStart}:${piece.hapEnd}`
}

// The pieces a chosen set of haplotypes leaves in a subgraph: every maximal
// run of one path's positions whose nodes all lie in the subgraph, the pieces
// extractPaths and identifyPaths find by walking and naming every haplotype.
// When the haplotype index cannot show that the walks below pass every such
// piece, the result carries a fallback reason and no pieces, and the caller
// identifies every walk.
export async function findChosenPieces(input: ChosenPathsInput) {
  const { db, records, signal } = input
  let clock = performance.now()
  const lap = () => {
    const now = performance.now()
    const elapsed = now - clock
    clock = now
    return elapsed
  }
  const stats: KeepStats = {
    spacing: await db.haplotypeAnchorSpacing(),
    anchors: undefined,
    anchorsRead: 0,
    chosenPaths: 0,
    scans: [],
    scanRows: 0,
    strays: undefined,
    pieces: 0,
    sources: {
      reference: 0,
      section: 0,
      stray: 0,
      chain: 0,
      twin: 0,
    },
    walks: {},
    twins: { tried: 0, found: 0 },
    graphFetches: 0,
    fallback: undefined,
    ms: { scan: 0, walks: 0, check: 0, twins: 0 },
  }
  const countWalk = (kind: string, end: KeepWalkEnd) => {
    const key = `${kind}: ${end}`
    stats.walks[key] = (stats.walks[key] ?? 0) + 1
  }
  const interval = (await db.haplotypeSampleInterval()) ?? 4096
  const outside = new Map<number, GbzRecord>()
  const record = async (handle: number) => {
    const inside = records.get(handle) ?? outside.get(handle)
    if (inside) {
      return inside
    }
    const fetched = await db.getRecord(handle)
    stats.graphFetches += 1
    if (!fetched) {
      throw new Error(`Node record ${handle} is missing from the database`)
    }
    outside.set(handle, fetched)
    return fetched
  }
  const lengthIn = (handle: number) => records.get(handle)!.sequenceLen
  const pathsByHandle = await db.pathsByHandle()
  const chosen = (pathHandle: number) => {
    const path = pathsByHandle.get(pathHandle)
    return path !== undefined && input.keep(path.name)
  }

  const pieces: ChosenPiece[] = []
  const pieceAt = new PositionIndex()
  const piecesOfPath = new Map<number, number[]>()
  const forwardDone = new Set<number>()
  const backwardDone = new Set<number>()

  const next = async (pos: Pos): Promise<Pos | undefined> => {
    const successor = (await record(pos.node)).gbwt().lf(pos.offset)
    return successor === undefined || successor.node === ENDMARKER
      ? undefined
      : successor
  }
  const previous = async (
    pos: Pos,
    within?: Map<number, GbzRecord>,
  ): Promise<Pos | undefined> => {
    const predecessor = (await record(flipNode(pos.node)))
      .gbwt()
      .predecessorAt(pos.offset)
    if (
      predecessor === undefined ||
      (within !== undefined && !within.has(predecessor))
    ) {
      return undefined
    }
    const offset = (await record(predecessor)).gbwt().offsetTo(pos)
    if (offset === undefined) {
      throw new Error(
        `No offset in ${predecessor} leads to ${pos.node}:${pos.offset}`,
      )
    }
    return { node: predecessor, offset }
  }

  const addPiece = (
    pathHandle: number,
    orientation: Orientation,
    cursors: Cursor[],
    source: ChosenPieceSource,
  ) => {
    const handles = cursors.map(c => c.pos.node)
    const offsets = cursors.map(c => c.pos.offset)
    let len = 0
    for (const handle of handles) {
      len += lengthIn(handle)
    }
    const hapStart =
      orientation === 'forward'
        ? cursors[0]!.left
        : cursors[cursors.length - 1]!.left
    const id = pieces.length
    pieces.push({
      pathHandle,
      orientation,
      handles,
      offsets,
      len,
      hapStart,
      hapEnd: hapStart + len,
      canonical: pathEndsAreCanonical(handles[0], handles[handles.length - 1]),
      source,
    })
    for (const cursor of cursors) {
      pieceAt.set(cursor.pos, id)
    }
    const ofPath = piecesOfPath.get(pathHandle)
    if (ofPath) {
      ofPath.push(id)
    } else {
      piecesOfPath.set(pathHandle, [id])
    }
    return id
  }

  // The piece through a position in the subgraph, in that position's
  // orientation of its path.
  const pieceThrough = async (
    seed: Cursor,
    pathHandle: number,
    orientation: Orientation,
    source: ChosenPieceSource,
  ) => {
    const before: Cursor[] = []
    let cursor = seed
    for (;;) {
      signal?.throwIfAborted()
      const pos = await previous(cursor.pos, records)
      if (!pos) {
        break
      }
      cursor = {
        pos,
        left: backwardLeft(
          orientation,
          cursor.left,
          lengthIn(cursor.pos.node),
          lengthIn(pos.node),
        ),
      }
      before.push(cursor)
    }
    before.reverse()
    const after: Cursor[] = [seed]
    cursor = seed
    for (;;) {
      signal?.throwIfAborted()
      const pos = await next(cursor.pos)
      if (!pos || !records.has(pos.node)) {
        break
      }
      cursor = {
        pos,
        left: forwardLeft(
          orientation,
          cursor.left,
          lengthIn(cursor.pos.node),
          lengthIn(pos.node),
        ),
      }
      after.push(cursor)
    }
    return addPiece(pathHandle, orientation, [...before, ...after], source)
  }
  const pieceAtOrThrough = async (
    cursor: Cursor,
    pathHandle: number,
    orientation: Orientation,
    source: ChosenPieceSource,
  ) =>
    pieces[
      pieceAt.get(cursor.pos) ??
        (await pieceThrough(cursor, pathHandle, orientation, source))
    ]!

  const lastCursor = (piece: ChosenPiece): Cursor => {
    const node = piece.handles[piece.handles.length - 1]!
    return {
      pos: { node, offset: piece.offsets[piece.offsets.length - 1]! },
      left:
        piece.orientation === 'forward'
          ? piece.hapEnd - lengthIn(node)
          : piece.hapStart,
    }
  }
  const firstCursor = (piece: ChosenPiece): Cursor => {
    const node = piece.handles[0]!
    return {
      pos: { node, offset: piece.offsets[0]! },
      left:
        piece.orientation === 'forward'
          ? piece.hapStart
          : piece.hapEnd - lengthIn(node),
    }
  }

  const referenceId = await pieceThrough(
    { pos: input.referencePos, left: input.referenceLeft },
    input.referenceHandle,
    'forward',
    'reference',
  )
  const reference = pieces[referenceId]!
  const result = () => {
    if (stats.fallback !== undefined) {
      return { reference, pieces: [], stats }
    }
    // What extractPaths keeps: the canonical twin of each piece, and both twins
    // when both are canonical.
    const byKey = new Map<string, ChosenPiece[]>()
    pieces.forEach((piece, id) => {
      if (id !== referenceId) {
        byKey.set(pieceKey(piece), [
          ...(byKey.get(pieceKey(piece)) ?? []),
          piece,
        ])
      }
    })
    const emitted: ChosenPiece[] = []
    for (const group of byKey.values()) {
      const orientations = new Set<Orientation>()
      for (const piece of group) {
        if (piece.canonical && !orientations.has(piece.orientation)) {
          orientations.add(piece.orientation)
          emitted.push(piece)
          stats.sources[piece.source] += 1
        }
      }
    }
    stats.sources.reference = 1
    stats.pieces = emitted.length
    return { reference, pieces: emitted, stats }
  }

  const visitsAt = (node: number) => {
    const handle = node - (node % 2)
    return db.haplotypeSamplesInRange(handle, handle + 1)
  }

  // A chain from a piece, forward or backward, through every piece it lands
  // in, until it meets a known position or runs CHAIN_BOUND bp outside the
  // subgraph.
  const chain = async (id: number, forward: boolean) => {
    const done = forward ? forwardDone : backwardDone
    const other = forward ? backwardDone : forwardDone
    let current = id
    for (;;) {
      if (done.has(current)) {
        return
      }
      done.add(current)
      const piece = pieces[current]!
      let cursor = forward ? lastCursor(piece) : firstCursor(piece)
      let bp = 0
      let end: KeepWalkEnd | undefined
      while (end === undefined) {
        signal?.throwIfAborted()
        const pos = forward
          ? await next(cursor.pos)
          : await previous(cursor.pos)
        if (!pos) {
          end = 'endmarker'
          break
        }
        const currentLen = (await record(cursor.pos.node)).sequenceLen
        const len = (await record(pos.node)).sequenceLen
        const left = forward
          ? forwardLeft(piece.orientation, cursor.left, currentLen, len)
          : backwardLeft(piece.orientation, cursor.left, currentLen, len)
        if (records.has(pos.node)) {
          const known = pieceAt.get(pos)
          if (known === undefined) {
            current = await pieceThrough(
              { pos, left },
              piece.pathHandle,
              piece.orientation,
              'chain',
            )
            other.add(current)
            end = 'landed'
          } else {
            other.add(known)
            end = 'merge'
          }
        } else if (bp > CHAIN_BOUND) {
          end = 'bound'
        } else {
          bp += len
          cursor = { pos, left }
        }
      }
      countWalk('chain', end)
      if (end !== 'landed') {
        return
      }
    }
  }

  // With HaplotypeStrays and HaplotypeBinNodes. The haplotype index lists the
  // nodes of each bin of the reference path, and for each bin the stretches of
  // each path whose visits to those nodes the section walks below can miss.
  // The subgraph is checked against the bins the window touches, so every
  // visit of a chosen path to it lies on a section walk or in a stray row,
  // except inside a filled snarl, where the piece through a boundary node runs
  // on into the snarl, and a path that stays inside the snarl has a row.
  const strayRoute = async (strays: HaplotypeStrayOptions) => {
    if (input.context > strays.context) {
      throw new Fallback(
        `the context of ${input.context} bp exceeds the ${strays.context} bp the haplotype index's stray rows cover`,
      )
    }
    const spacing = stats.spacing
    if (spacing === undefined) {
      throw new Fallback('the haplotype index has no anchors')
    }
    const { bin, bound } = strays
    const { fills, inserted } = input.snarls
    if (input.snarls.mode === 'overlapping' && fills.length > 0) {
      throw new Fallback(
        "the haplotype index's stray rows cover contained snarls only",
      )
    }
    for (const fill of fills) {
      if (
        fill.inserted > 0 &&
        (strays.snarlNodes === undefined || fill.nodes > strays.snarlNodes)
      ) {
        throw new Fallback(
          strays.snarlNodes === undefined
            ? "the haplotype index's stray rows leave snarls out"
            : `a snarl of ${fill.nodes} nodes exceeds the ${strays.snarlNodes} the haplotype index's stray rows cover`,
        )
      }
    }
    const firstBin = Math.floor(input.window.start / bin)
    const lastBin = Math.floor((input.window.end - 1) / bin)
    const lo = firstBin * bin
    const hi = (lastBin + 1) * bin
    const listed = await db.haplotypeBinNodes(
      input.referenceHandle,
      firstBin,
      lastBin,
    )
    for (const handle of records.keys()) {
      const id = nodeId(handle)
      if (!isReverse(handle) && !listed(id) && !inserted.has(id)) {
        throw new Fallback(
          `the haplotype index lists node ${id} of the subgraph in no bin that the window touches`,
        )
      }
    }

    // Every anchor within `bound` of the bins, and one beyond on each side.
    const anchorOf = new Map<number, HaplotypeAnchor>()
    const readAnchor = async (k: number) => {
      const anchor = await db.haplotypeAnchor(
        input.referenceHandle,
        k * spacing,
      )
      if (anchor) {
        anchorOf.set(k, anchor)
      }
      return anchor
    }
    let lowest = Math.max(0, Math.floor((lo - bound) / spacing) - 1)
    let highest = Math.ceil((hi + bound) / spacing) + 1
    await Promise.all(
      Array.from({ length: highest - lowest + 1 }, (_, i) =>
        readAnchor(lowest + i),
      ),
    )
    while (
      lowest > 0 &&
      (anchorOf.get(lowest)?.pathOffset ?? Number.POSITIVE_INFINITY) >
        lo - bound
    ) {
      lowest -= 1
      await readAnchor(lowest)
    }
    while (
      anchorOf.has(highest) &&
      anchorOf.get(highest)!.pathOffset < hi + bound
    ) {
      highest += 1
      await readAnchor(highest)
    }
    const multiples = [...anchorOf.keys()].sort((x, y) => x - y)
    const own = anchorOf.get(multiples[0] ?? -1)
    if (!own) {
      throw new Fallback('the haplotype index has no anchors on this path')
    }
    const anchorOffset = (k: number) => anchorOf.get(k)!.pathOffset
    // A node that is the anchor of two multiples ends no section.
    const multiplesOf = new Map<number, number[]>()
    for (const k of multiples) {
      const id = nodeId(anchorOf.get(k)!.node)
      multiplesOf.set(id, [...(multiplesOf.get(id) ?? []), k])
    }
    const anchorNodes = [...multiplesOf.keys()]
    const anchorRows = await Promise.all(
      anchorNodes.map(id => visitsAt(2 * id)),
    )
    if (
      !anchorRows[anchorNodes.indexOf(nodeId(own.node))]!.some(
        row =>
          row.pathHandle === input.referenceHandle &&
          row.orientation === 'forward' &&
          row.pathOffset === own.pathOffset,
      )
    ) {
      throw new Error(
        `The haplotype index has no anchor row for the reference path ${input.referenceHandle} at offset ${own.pathOffset} (node ${nodeId(own.node)}); it does not match this graph`,
      )
    }
    const before = multiples.filter(k => anchorOffset(k) <= input.window.start)
    const after = multiples.filter(k => anchorOffset(k) >= input.window.end)
    stats.anchors = [
      anchorOffset(before[before.length - 1] ?? multiples[0]!),
      anchorOffset(after[0] ?? multiples[multiples.length - 1]!),
    ]
    stats.anchorsRead = multiples.length
    const visits = new Map<
      number,
      { k: number | undefined; row: HaplotypeSample }[]
    >()
    const atAnchors = new Set<number>()
    anchorNodes.forEach((id, i) => {
      const ks = multiplesOf.get(id)!
      const k = ks.length === 1 ? ks[0] : undefined
      for (const row of anchorRows[i]!) {
        atAnchors.add(row.pathHandle)
        if (row.orientation === 'forward' && chosen(row.pathHandle)) {
          visits.set(row.pathHandle, [
            ...(visits.get(row.pathHandle) ?? []),
            { k, row },
          ])
        }
      }
    })
    stats.chosenPaths = [...atAnchors].filter(chosen).length
    if (stats.chosenPaths > keepTuning.mostChosenPaths) {
      throw new Fallback(
        `${stats.chosenPaths} chosen paths pass the anchors, more than ${keepTuning.mostChosenPaths}`,
      )
    }

    // A section between visits to adjacent anchors whose span meets the bins
    // is walked whole, `bound` past both visits. One whose span ends up to
    // `bound` outside the bins is walked `bound` to each side of the visit at
    // that end. These are the walks the stray rows count on.
    interface Plan {
      pathHandle: number
      from: HaplotypeSample
      to: HaplotypeSample | undefined
    }
    const plans: Plan[] = []
    let prefetchLo = Number.POSITIVE_INFINITY
    let prefetchHi = 0
    for (const [pathHandle, list] of visits) {
      list.sort((x, y) => x.row.pathOffset - y.row.pathOffset)
      for (let i = 0; i + 1 < list.length; i++) {
        const from = list[i]!
        const to = list[i + 1]!
        if (
          from.k === undefined ||
          to.k === undefined ||
          Math.abs(from.k - to.k) !== 1
        ) {
          continue
        }
        const [low, high] =
          anchorOffset(from.k) <= anchorOffset(to.k) ? [from, to] : [to, from]
        const a = anchorOffset(low.k!)
        const b = anchorOffset(high.k!)
        if (a < hi && b >= lo) {
          plans.push({ pathHandle, from: from.row, to: to.row })
          prefetchLo = Math.min(prefetchLo, a - bound)
          prefetchHi = Math.max(prefetchHi, b + bound)
        } else if (a >= hi && a - hi <= bound) {
          plans.push({ pathHandle, from: low.row, to: undefined })
          prefetchLo = Math.min(prefetchLo, a - bound)
          prefetchHi = Math.max(prefetchHi, a + bound)
        } else if (b < lo && lo - b <= bound) {
          plans.push({ pathHandle, from: high.row, to: undefined })
          prefetchLo = Math.min(prefetchLo, b - bound)
          prefetchHi = Math.max(prefetchHi, b + bound)
        }
      }
    }
    const filled = new Set(fills.map(fill => `${fill.low}:${fill.high}`))
    const found = await db.haplotypeStraysInBins(
      input.referenceHandle,
      firstBin,
      lastBin,
    )
    const rows = found
      .filter(
        row =>
          chosen(row.pathHandle) &&
          (row.snarl === undefined ||
            filled.has(`${row.snarl[0]}:${row.snarl[1]}`)),
      )
      .sort((x, y) => x.pathHandle - y.pathHandle || x.pathStart - y.pathStart)
    stats.strays = {
      bins: lastBin - firstBin + 1,
      rows: found.length,
      walked: 0,
      outsideBp: 0,
    }
    if (prefetchHi > 0) {
      await input.prefetchReferenceRange(
        input.referenceHandle,
        Math.max(0, prefetchLo),
        prefetchHi + 1,
      )
    }
    stats.ms.scan = lap()

    // A cap on each walk's bases outside the subgraph.
    const cap = 8 * spacing + 2 * (input.window.end - input.window.start)
    const counted = stats.strays
    let walkBp = 0
    const outside = (len: number) => {
      counted.outsideBp += len
      walkBp += len
      if (walkBp > cap) {
        throw new Fallback(
          `a walk of a chosen path near the window went past its cap of ${cap} bp`,
        )
      }
    }
    const walkedRanges = new Map<number, [number, number][]>()
    const covered = (pathHandle: number, from: number, to: number) =>
      (walkedRanges.get(pathHandle) ?? []).some(
        ([x, y]) => x <= from && to <= y,
      )
    const markWalked = (pathHandle: number, from: number, to: number) => {
      walkedRanges.set(pathHandle, [
        ...(walkedRanges.get(pathHandle) ?? []),
        [from, to],
      ])
    }
    // Forward along a path from a position through every node that starts at
    // or before `until`, jumping over the pieces it lands in; returns the
    // offset it reached.
    const walkForward = async (
      pathHandle: number,
      start: Pos,
      startLeft: number,
      until: number,
      source: ChosenPieceSource,
    ) => {
      let pos: Pos | undefined = start
      let left = startLeft
      let reached = left
      while (pos && left <= until) {
        signal?.throwIfAborted()
        let len: number
        if (records.has(pos.node)) {
          const piece = await pieceAtOrThrough(
            { pos, left },
            pathHandle,
            'forward',
            source,
          )
          const last = lastCursor(piece)
          pos = last.pos
          left = last.left
          len = lengthIn(pos.node)
          reached = Math.max(reached, piece.hapEnd)
        } else {
          len = (await record(pos.node)).sequenceLen
          outside(len)
          reached = Math.max(reached, left + len)
        }
        pos = await next(pos)
        left += len
      }
      return reached
    }
    // Backward from a position through every node that ends after `until`;
    // returns the offset reached.
    const walkBackward = async (
      pathHandle: number,
      start: Pos,
      startLeft: number,
      until: number,
    ) => {
      let cursor: Cursor = { pos: start, left: startLeft }
      let reached = startLeft
      while (cursor.left > until) {
        signal?.throwIfAborted()
        const earlier = await previous(cursor.pos)
        if (!earlier) {
          break
        }
        const len = (await record(earlier.node)).sequenceLen
        const earlierLeft = cursor.left - len
        if (records.has(earlier.node)) {
          const piece = await pieceAtOrThrough(
            { pos: earlier, left: earlierLeft },
            pathHandle,
            'forward',
            'section',
          )
          cursor = firstCursor(piece)
          reached = Math.min(reached, piece.hapStart)
        } else {
          outside(len)
          cursor = { pos: earlier, left: earlierLeft }
          reached = Math.min(reached, earlierLeft)
        }
      }
      return reached
    }

    for (const { pathHandle, from, to } of plans) {
      const start = from.pathOffset
      const stop = (to ?? from).pathOffset + bound
      if (covered(pathHandle, start - bound, stop)) {
        continue
      }
      const pos = { node: from.node, offset: from.offset }
      walkBp = 0
      const reachedEnd = await walkForward(
        pathHandle,
        pos,
        start,
        stop,
        'section',
      )
      walkBp = 0
      const reachedStart = await walkBackward(
        pathHandle,
        pos,
        start,
        start - bound,
      )
      markWalked(
        pathHandle,
        Math.min(reachedStart, start - bound),
        Math.max(reachedEnd, stop),
      )
      countWalk(to ? 'section' : 'visit', to ? 'past the far anchor' : 'bound')
    }
    for (const row of rows) {
      if (covered(row.pathHandle, row.pathStart, row.pathEnd)) {
        continue
      }
      walkBp = 0
      const reachedEnd = await walkForward(
        row.pathHandle,
        { node: row.node, offset: row.offset },
        row.pathStart,
        row.pathEnd,
        'stray',
      )
      markWalked(
        row.pathHandle,
        row.pathStart,
        Math.max(reachedEnd, row.pathEnd),
      )
      counted.walked += 1
    }
    stats.ms.walks = lap()

    // A sample of a chosen path on the subgraph's nodes outside every piece
    // would contradict the haplotype index's rows. A sample of the reverse
    // orientation gives a position of the piece's twin.
    const reversed: HaplotypeSample[] = []
    stats.scans = handleRuns([...records.keys()].sort((x, y) => x - y))
    for (const [first, last] of stats.scans) {
      for (const sample of await db.haplotypeSamplesInRange(first, last)) {
        stats.scanRows += 1
        if (
          records.has(sample.node) &&
          sample.pathHandle !== input.referenceHandle &&
          chosen(sample.pathHandle)
        ) {
          if (
            !(piecesOfPath.get(sample.pathHandle) ?? []).some(id => {
              const piece = pieces[id]!
              return (
                piece.hapStart <= sample.pathOffset &&
                sample.pathOffset < piece.hapEnd
              )
            })
          ) {
            throw new Fallback(
              `chosen path ${sample.pathHandle} has a sample at ${sample.pathOffset} on the window's nodes that no walk reached`,
            )
          }
          if (sample.orientation === 'reverse') {
            reversed.push(sample)
          }
        }
      }
    }
    for (const sample of reversed) {
      await pieceAtOrThrough(
        {
          pos: { node: sample.node, offset: sample.offset },
          left: sample.pathOffset,
        },
        sample.pathHandle,
        'reverse',
        'twin',
      )
    }
    stats.ms.check = lap()
  }

  const canonicalTwins = async () => {
    // Canonical twins: a piece found only in the orientation extractPaths
    // drops, or in one of two orientations it keeps, is walked on in that
    // orientation while the samples of the other orientation at each node are
    // read by coordinate. A matching sample gives a position of the other
    // orientation, which is walked forward into the subgraph.
    const orientationsOf = new Map<string, Set<Orientation>>()
    const note = (piece: ChosenPiece) => {
      const key = pieceKey(piece)
      const seen = orientationsOf.get(key)
      if (seen) {
        seen.add(piece.orientation)
      } else {
        orientationsOf.set(key, new Set([piece.orientation]))
      }
    }
    let noted = 0
    const noteNew = () => {
      for (; noted < pieces.length; noted++) {
        if (noted !== referenceId) {
          note(pieces[noted]!)
        }
      }
    }
    noteNew()
    const hasTwin = (piece: ChosenPiece) =>
      (orientationsOf.get(pieceKey(piece))?.size ?? 0) > 1
    const twinBound = 2 * interval
    for (let id = 0; id < pieces.length; id++) {
      const piece = pieces[id]!
      if (
        id === referenceId ||
        hasTwin(piece) ||
        (piece.canonical && !twinIsCanonical(piece))
      ) {
        continue
      }
      stats.twins.tried += 1
      const other: Orientation =
        piece.orientation === 'forward' ? 'reverse' : 'forward'
      let cursor = lastCursor(piece)
      let walkedBp = 0
      let hit: HaplotypeSample | undefined
      while (!hit && walkedBp <= twinBound) {
        signal?.throwIfAborted()
        const pos = await next(cursor.pos)
        if (!pos) {
          break
        }
        const len = (await record(pos.node)).sequenceLen
        const left = forwardLeft(
          piece.orientation,
          cursor.left,
          (await record(cursor.pos.node)).sequenceLen,
          len,
        )
        const flipped = flipNode(pos.node)
        hit = (await db.haplotypeSamplesInRange(flipped, flipped)).find(
          s =>
            s.pathHandle === piece.pathHandle &&
            s.orientation === other &&
            s.pathOffset === left,
        )
        walkedBp += len
        cursor = { pos, left }
      }
      let walk: Cursor | undefined = hit && {
        pos: { node: hit.node, offset: hit.offset },
        left: hit.pathOffset,
      }
      let toPiece = 0
      while (walk && !hasTwin(piece) && toPiece <= twinBound + piece.len) {
        signal?.throwIfAborted()
        if (records.has(walk.pos.node)) {
          const landed = await pieceAtOrThrough(
            walk,
            piece.pathHandle,
            other,
            'twin',
          )
          const landedId = pieces.indexOf(landed)
          await chain(landedId, true)
          await chain(landedId, false)
          noteNew()
          walk = lastCursor(landed)
        }
        if (!hasTwin(piece)) {
          const len: number = (await record(walk.pos.node)).sequenceLen
          toPiece += len
          const pos = await next(walk.pos)
          walk = pos
            ? {
                pos,
                left: forwardLeft(
                  other,
                  walk.left,
                  len,
                  (await record(pos.node)).sequenceLen,
                ),
              }
            : undefined
        }
      }
      noteNew()
      if (!hasTwin(piece)) {
        throw new Fallback(
          `piece ${pieceKey(piece)} was found in one orientation where extractPaths keeps the other`,
        )
      }
      stats.twins.found += 1
    }
    stats.ms.twins = lap()
  }

  try {
    const strays = await db.haplotypeStrayOptions()
    if (strays === undefined) {
      throw new Fallback(
        'the haplotype index has no stray rows; gbz-haplotype-index 0.2.0 writes them',
      )
    }
    await strayRoute(strays)
    await canonicalTwins()
  } catch (error) {
    if (!(error instanceof Fallback)) {
      throw error
    }
    stats.fallback = error.message
  }
  return result()
}

// extractPaths's order: walks starting on forward handles first, then by
// handle and offset.
export function extractionOrder(a: ChosenPiece, b: ChosenPiece) {
  const ah = a.handles[0]!
  const bh = b.handles[0]!
  return (
    Number(isReverse(ah)) - Number(isReverse(bh)) ||
    ah - bh ||
    a.offsets[0]! - b.offsets[0]!
  )
}
