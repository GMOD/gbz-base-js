import {
  ENDMARKER,
  flipNode,
  isReverse,
  nodeId,
  pathEndsAreCanonical,
} from './gbwt/node.ts'

import type { GBZBase, GbzRecord, HaplotypeSample } from './db.ts'
import type { Orientation } from './gbwt/node.ts'
import type { Pos } from './gbwt/record.ts'
import type { PathName } from './pathName.ts'

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

// How far a walk goes outside the subgraph past the last piece it found. The
// farthest echo of a collapsed repeat measured on HPRC was 30 kb from the
// window.
export const CHAIN_BOUND = 32768

export type ChosenPieceSource =
  'reference' | 'sample' | 'interval' | 'chain' | 'approach' | 'twin'

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
  | 'merge'
  | 'landed'
  | 'bound'
  | 'endmarker'
  | 'far anchor'
  | 'cap'
  | 'no sample'

export interface KeepStats {
  spacing: number | undefined
  scans: [number, number][]
  scanRows: number
  seeds: number
  pieces: number
  sources: Record<ChosenPieceSource, number>
  walks: Record<string, number>
  twins: { tried: number; found: number; unresolved: number }
  graphFetches: number
  complete: boolean
  ms: {
    seeds: number
    intervals: number
    chains: number
    approach: number
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
// run of one path's positions whose nodes are all in the subgraph, found
// without walking the other haplotypes. extractPaths and identifyPaths find
// the same pieces by walking and naming every haplotype.
export async function findChosenPieces(input: ChosenPathsInput) {
  const { db, records, signal } = input
  const started = performance.now()
  let clock = started
  const lap = () => {
    const now = performance.now()
    const elapsed = now - clock
    clock = now
    return elapsed
  }
  const stats: KeepStats = {
    spacing: await db.haplotypeAnchorSpacing(),
    scans: [],
    scanRows: 0,
    seeds: 0,
    pieces: 0,
    sources: {
      reference: 0,
      sample: 0,
      interval: 0,
      chain: 0,
      approach: 0,
      twin: 0,
    },
    walks: {},
    twins: { tried: 0, found: 0, unresolved: 0 },
    graphFetches: 0,
    complete: true,
    ms: { seeds: 0, intervals: 0, chains: 0, approach: 0, twins: 0 },
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

  // Forward from a piece's end, and on through every piece the walk lands in,
  // until it meets a known position or runs `bound` bp outside the subgraph.
  const chainForward = async (id: number, source: ChosenPieceSource) => {
    let current = id
    for (;;) {
      if (forwardDone.has(current)) {
        return
      }
      forwardDone.add(current)
      const piece = pieces[current]!
      let cursor = lastCursor(piece)
      let walked = 0
      let end: KeepWalkEnd | undefined
      while (end === undefined) {
        signal?.throwIfAborted()
        const pos = await next(cursor.pos)
        if (!pos) {
          end = 'endmarker'
          break
        }
        const left = forwardLeft(
          piece.orientation,
          cursor.left,
          (await record(cursor.pos.node)).sequenceLen,
          (await record(pos.node)).sequenceLen,
        )
        if (records.has(pos.node)) {
          const known = pieceAt.get(pos)
          if (known === undefined) {
            current = await pieceThrough(
              { pos, left },
              piece.pathHandle,
              piece.orientation,
              source,
            )
            backwardDone.add(current)
            end = 'landed'
          } else {
            backwardDone.add(known)
            end = 'merge'
          }
        } else if (walked > CHAIN_BOUND) {
          end = 'bound'
        } else {
          walked += (await record(pos.node)).sequenceLen
          cursor = { pos, left }
        }
      }
      countWalk('chain', end)
      if (end !== 'landed') {
        return
      }
    }
  }
  const chainBackward = async (id: number, source: ChosenPieceSource) => {
    let current = id
    for (;;) {
      if (backwardDone.has(current)) {
        return
      }
      backwardDone.add(current)
      const piece = pieces[current]!
      let cursor = firstCursor(piece)
      let walked = 0
      let end: KeepWalkEnd | undefined
      while (end === undefined) {
        signal?.throwIfAborted()
        const pos = await previous(cursor.pos)
        if (!pos) {
          end = 'endmarker'
          break
        }
        const left = backwardLeft(
          piece.orientation,
          cursor.left,
          (await record(cursor.pos.node)).sequenceLen,
          (await record(pos.node)).sequenceLen,
        )
        if (records.has(pos.node)) {
          const known = pieceAt.get(pos)
          if (known === undefined) {
            current = await pieceThrough(
              { pos, left },
              piece.pathHandle,
              piece.orientation,
              source,
            )
            forwardDone.add(current)
            end = 'landed'
          } else {
            forwardDone.add(known)
            end = 'merge'
          }
        } else if (walked > CHAIN_BOUND) {
          end = 'bound'
        } else {
          walked += (await record(pos.node)).sequenceLen
          cursor = { pos, left }
        }
      }
      countWalk('chain', end)
      if (end !== 'landed') {
        return
      }
    }
  }

  // Seeds: every chosen sample on the subgraph's nodes. A sample inside a
  // canonical piece already found for its path adds nothing unless that
  // piece's twin is canonical too, in which case extractPaths keeps both.
  stats.scans = handleRuns([...records.keys()].sort((a, b) => a - b))
  for (const [first, last] of stats.scans) {
    for (const sample of await db.haplotypeSamplesInRange(first, last)) {
      stats.scanRows += 1
      if (
        records.has(sample.node) &&
        chosen(sample.pathHandle) &&
        pieceAt.get(sample) === undefined &&
        !(piecesOfPath.get(sample.pathHandle) ?? []).some(id => {
          const piece = pieces[id]!
          return (
            piece.canonical &&
            !twinIsCanonical(piece) &&
            piece.hapStart <= sample.pathOffset &&
            sample.pathOffset < piece.hapEnd
          )
        })
      ) {
        stats.seeds += 1
        await pieceThrough(
          {
            pos: { node: sample.node, offset: sample.offset },
            left: sample.pathOffset,
          },
          sample.pathHandle,
          sample.orientation,
          'sample',
        )
      }
    }
  }
  stats.ms.seeds = lap()

  // Interval walks: a chosen contig that passes the anchor before the window
  // and the anchor after it, in one orientation, is walked from one visit to
  // the other, and CHAIN_BOUND further on each side, so every piece of it in
  // that stretch is found.
  const walked = new Map<number, [number, number][]>()
  const spacing = stats.spacing
  const anchorBefore =
    spacing === undefined
      ? undefined
      : await db.haplotypeAnchor(
          input.referenceHandle,
          Math.floor(input.window.start / spacing) * spacing,
        )
  const anchorAfter =
    spacing === undefined
      ? undefined
      : await db.haplotypeAnchor(
          input.referenceHandle,
          Math.ceil(input.window.end / spacing + 0.5) * spacing,
        )
  const [rowsBefore, rowsAfter] = await Promise.all([
    anchorBefore ? db.haplotypeSamplesAtNode(anchorBefore.node) : [],
    anchorAfter ? db.haplotypeSamplesAtNode(anchorAfter.node) : [],
  ])
  if (
    anchorBefore &&
    !rowsBefore.some(
      row =>
        row.pathHandle === input.referenceHandle &&
        row.orientation === 'forward' &&
        row.pathOffset === anchorBefore.pathOffset,
    )
  ) {
    throw new Error(
      `The haplotype index has no anchor row for the reference path ${input.referenceHandle} at offset ${anchorBefore.pathOffset} (node ${nodeId(anchorBefore.node)}); it does not match this graph`,
    )
  }
  const farVisit = (row: HaplotypeSample, far: HaplotypeSample[]) => {
    const ahead = far
      .filter(
        f =>
          f.pathHandle === row.pathHandle &&
          f.orientation === row.orientation &&
          (row.orientation === 'forward'
            ? f.pathOffset > row.pathOffset
            : f.pathOffset < row.pathOffset),
      )
      .map(f => f.pathOffset)
    return ahead.length === 0
      ? undefined
      : row.orientation === 'forward'
        ? Math.min(...ahead)
        : Math.max(...ahead)
  }
  const intervalRows = rowsBefore.filter(
    row => chosen(row.pathHandle) && farVisit(row, rowsAfter) !== undefined,
  )
  if (anchorBefore && anchorAfter && intervalRows.length > 0) {
    await input.prefetchReferenceRange(
      input.referenceHandle,
      anchorBefore.pathOffset,
      anchorAfter.pathOffset + 1,
    )
  }
  const cap =
    spacing === undefined
      ? 0
      : 16 * spacing + 4 * (input.window.end - input.window.start)
  for (const row of intervalRows) {
    const orientation = row.orientation
    const stopAt = farVisit(row, rowsAfter)!
    let lo = Math.min(row.pathOffset, stopAt)
    let hi = Math.max(row.pathOffset, stopAt)
    let cursor: Cursor = {
      pos: { node: row.node, offset: row.offset },
      left: row.pathOffset,
    }
    let outsideBp = 0
    for (;;) {
      signal?.throwIfAborted()
      const pos = await previous(cursor.pos)
      if (!pos) {
        break
      }
      const left = backwardLeft(
        orientation,
        cursor.left,
        (await record(cursor.pos.node)).sequenceLen,
        (await record(pos.node)).sequenceLen,
      )
      if (records.has(pos.node)) {
        const piece =
          pieces[
            pieceAt.get(pos) ??
              (await pieceThrough(
                { pos, left },
                row.pathHandle,
                orientation,
                'interval',
              ))
          ]!
        cursor = firstCursor(piece)
        outsideBp = 0
      } else {
        outsideBp += (await record(pos.node)).sequenceLen
        if (outsideBp > CHAIN_BOUND) {
          break
        }
        cursor = { pos, left }
      }
      lo = Math.min(lo, cursor.left)
      hi = Math.max(hi, cursor.left)
    }
    let pos: Pos | undefined = { node: row.node, offset: row.offset }
    let left = row.pathOffset
    let passed = false
    let sinceLast = 0
    let total = 0
    let end: KeepWalkEnd = 'bound'
    while (pos) {
      signal?.throwIfAborted()
      if (
        !passed &&
        (orientation === 'forward' ? left >= stopAt : left <= stopAt)
      ) {
        passed = true
        sinceLast = 0
      }
      if (passed && sinceLast > CHAIN_BOUND) {
        break
      }
      if (total > cap) {
        end = 'cap'
        break
      }
      let len: number
      if (records.has(pos.node)) {
        const piece =
          pieces[
            pieceAt.get(pos) ??
              (await pieceThrough(
                { pos, left },
                row.pathHandle,
                orientation,
                'interval',
              ))
          ]!
        const last = lastCursor(piece)
        len = lengthIn(last.pos.node)
        total += piece.len - len
        pos = last.pos
        left = last.left
        sinceLast = 0
      } else {
        len = (await record(pos.node)).sequenceLen
        if (passed) {
          sinceLast += len
        }
      }
      total += len
      lo = Math.min(lo, left)
      hi = Math.max(hi, left + len)
      const successor: Pos | undefined = await next(pos)
      if (successor) {
        left = forwardLeft(
          orientation,
          left,
          len,
          (await record(successor.node)).sequenceLen,
        )
      }
      pos = successor
    }
    if (!pos && end === 'bound') {
      end = 'endmarker'
    }
    if (end === 'cap') {
      stats.complete = false
    }
    countWalk('interval', end)
    const ranges = walked.get(row.pathHandle)
    if (ranges) {
      ranges.push([lo, hi])
    } else {
      walked.set(row.pathHandle, [[lo, hi]])
    }
  }
  pieces.forEach((piece, id) => {
    if (
      id !== referenceId &&
      (walked.get(piece.pathHandle) ?? []).some(
        ([lo, hi]) => lo <= piece.hapStart && piece.hapEnd <= hi,
      )
    ) {
      forwardDone.add(id)
      backwardDone.add(id)
    }
  })
  stats.ms.intervals = lap()

  // Chains from the pieces no interval walk covered, one twin per piece.
  await Promise.all([
    input.prefetchReferenceRange(
      input.referenceHandle,
      Math.max(0, reference.hapStart - CHAIN_BOUND),
      reference.hapStart,
    ),
    input.prefetchReferenceRange(
      input.referenceHandle,
      reference.hapEnd,
      reference.hapEnd + CHAIN_BOUND,
    ),
  ])
  const chained = new Set<string>()
  const chainAll = async (source: ChosenPieceSource) => {
    const order = pieces
      .map((piece, id) => ({ piece, id }))
      .filter(({ id }) => id !== referenceId)
      .sort((a, b) => Number(b.piece.canonical) - Number(a.piece.canonical))
    for (const { piece, id } of order) {
      if (chained.has(pieceKey(piece))) {
        forwardDone.add(id)
        backwardDone.add(id)
      } else {
        chained.add(pieceKey(piece))
        await chainForward(id, source)
        await chainBackward(id, source)
      }
    }
  }
  await chainAll('chain')
  stats.ms.chains = lap()

  // Approach walks for chosen contigs seen at one anchor and not yet found:
  // from the reference's handle at the anchor before the window, or its
  // flipped handle at the anchor after, toward the window.
  const found = new Set(
    pieces.filter((_, id) => id !== referenceId).map(p => p.pathHandle),
  )
  const approaches: { row: HaplotypeSample; far: HaplotypeSample[] }[] = []
  if (anchorBefore) {
    for (const row of rowsBefore) {
      approaches.push({ row, far: rowsAfter })
    }
  }
  if (anchorAfter) {
    const [flippedAfter, flippedBefore] = await Promise.all([
      db.haplotypeSamplesAtNode(flipNode(anchorAfter.node)),
      anchorBefore
        ? db.haplotypeSamplesAtNode(flipNode(anchorBefore.node))
        : [],
    ])
    for (const row of flippedAfter) {
      approaches.push({ row, far: flippedBefore })
    }
  }
  const pending = approaches.filter(
    ({ row }) =>
      chosen(row.pathHandle) &&
      !found.has(row.pathHandle) &&
      !walked.has(row.pathHandle),
  )
  if (pending.length > 0 && anchorBefore && anchorAfter) {
    await input.prefetchReferenceRange(
      input.referenceHandle,
      anchorBefore.pathOffset,
      anchorAfter.pathOffset + 1,
    )
  }
  const approachBound =
    spacing === undefined
      ? 0
      : 2 * spacing + (input.window.end - input.window.start) + 2 * CHAIN_BOUND
  for (const { row, far } of pending) {
    if (found.has(row.pathHandle)) {
      continue
    }
    const stopAt = farVisit(row, far)
    let pos: Pos | undefined = { node: row.node, offset: row.offset }
    let left = row.pathOffset
    let total = 0
    let end: KeepWalkEnd | undefined
    while (end === undefined) {
      signal?.throwIfAborted()
      if (!pos) {
        end = 'endmarker'
      } else if (records.has(pos.node)) {
        const id =
          pieceAt.get(pos) ??
          (await pieceThrough(
            { pos, left },
            row.pathHandle,
            row.orientation,
            'approach',
          ))
        found.add(row.pathHandle)
        await chainForward(id, 'approach')
        await chainBackward(id, 'approach')
        end = 'landed'
      } else if (
        stopAt !== undefined &&
        total > 0 &&
        (row.orientation === 'forward' ? left >= stopAt : left <= stopAt)
      ) {
        end = 'far anchor'
      } else if (total > approachBound) {
        end = 'bound'
        stats.complete = false
      } else {
        const len = (await record(pos.node)).sequenceLen
        total += len
        const successor: Pos | undefined = await next(pos)
        if (successor) {
          left = forwardLeft(
            row.orientation,
            left,
            len,
            (await record(successor.node)).sequenceLen,
          )
        }
        pos = successor
      }
    }
    countWalk('approach', end)
  }
  stats.ms.approach = lap()

  // Canonical twins: a piece found only in the orientation extractPaths
  // does not keep, or in one of two orientations it keeps both of, is walked
  // on in that orientation while reading the other orientation's samples at
  // each node by coordinate. A matching sample gives a position of the other
  // orientation, which is walked forward into the subgraph.
  const byKey = new Map<string, number[]>()
  const index = (id: number) => {
    const key = pieceKey(pieces[id]!)
    const ids = byKey.get(key)
    if (ids) {
      ids.push(id)
    } else {
      byKey.set(key, [id])
    }
  }
  pieces.forEach((_, id) => {
    if (id !== referenceId) {
      index(id)
    }
  })
  let indexed = pieces.length
  const hasTwin = (piece: ChosenPiece) =>
    (byKey.get(pieceKey(piece)) ?? []).some(
      id => pieces[id]!.orientation !== piece.orientation,
    )
  const needsTwin = (piece: ChosenPiece) =>
    (!piece.canonical || twinIsCanonical(piece)) && !hasTwin(piece)
  const twinBound = 2 * interval
  for (let id = 0; id < indexed; id++) {
    const piece = pieces[id]!
    if (id === referenceId || !needsTwin(piece)) {
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
    let twin: number | undefined
    if (hit) {
      let walk: Cursor | undefined = {
        pos: { node: hit.node, offset: hit.offset },
        left: hit.pathOffset,
      }
      let toS = 0
      while (walk && twin === undefined && toS <= twinBound + piece.len) {
        signal?.throwIfAborted()
        if (records.has(walk.pos.node)) {
          const landed =
            pieceAt.get(walk.pos) ??
            (await pieceThrough(walk, piece.pathHandle, other, 'twin'))
          await chainForward(landed, 'twin')
          await chainBackward(landed, 'twin')
          for (; indexed < pieces.length; indexed++) {
            index(indexed)
          }
          if (hasTwin(piece)) {
            twin = landed
            break
          }
          walk = lastCursor(pieces[landed]!)
        }
        const len: number = (await record(walk.pos.node)).sequenceLen
        toS += len
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
    if (twin === undefined) {
      if (!piece.canonical) {
        stats.twins.unresolved += 1
        stats.complete = false
      }
    } else {
      stats.twins.found += 1
    }
  }
  stats.ms.twins = lap()

  // What extractPaths keeps of them: the canonical twin of each piece, both
  // when both are canonical, and a non-canonical twin only when its canonical
  // one was never reached.
  const emitted: ChosenPiece[] = []
  for (const ids of byKey.values()) {
    const group = ids.map(id => pieces[id]!)
    const canonical = group.filter(p => p.canonical)
    const kept = canonical.length > 0 ? canonical : group.slice(0, 1)
    const orientations = new Set<Orientation>()
    for (const piece of kept) {
      if (!orientations.has(piece.orientation)) {
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
