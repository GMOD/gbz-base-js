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
// farthest echo of a collapsed repeat that a walk reached on HPRC chr22 lay 30
// kb from the window.
export const CHAIN_BOUND = 32768

// Above this many chosen paths at the anchors, extracting and identifying
// every walk took less time than walking the chosen ones, on HPRC chr22 windows
// with 42 haplotypes. Tests raise it to run the walks on large sets.
export const keepTuning = { mostChosenPaths: 32 }

export type ChosenPieceSource =
  'reference' | 'sample' | 'interval' | 'chain' | 'twin'

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
  'merge' | 'landed' | 'bound' | 'endmarker' | 'past the far anchor' | 'cap'

export interface KeepStats {
  spacing: number | undefined
  anchors: [number, number] | undefined
  chosenPaths: number
  scans: [number, number][]
  scanRows: number
  seeds: number
  pieces: number
  sources: Record<ChosenPieceSource, number>
  walks: Record<string, number>
  twins: { tried: number; found: number }
  graphFetches: number
  // Why the query extracted and identified every walk instead, when it did.
  fallback: string | undefined
  ms: {
    scan: number
    intervals: number
    seeds: number
    chains: number
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
// Each chosen path is walked from its visit to the anchor before the window to
// its visit to the anchor after it. When the haplotype index shows a path with
// a sample on the subgraph's nodes far outside the stretch between its two
// anchor visits, which a segmental duplication or a collapsed paralog does,
// a pass of a chosen path can lie outside every such stretch; the result then
// carries a fallback reason and no pieces, and the caller identifies every
// walk.
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
    chosenPaths: 0,
    scans: [],
    scanRows: 0,
    seeds: 0,
    pieces: 0,
    sources: {
      reference: 0,
      sample: 0,
      interval: 0,
      chain: 0,
      twin: 0,
    },
    walks: {},
    twins: { tried: 0, found: 0 },
    graphFetches: 0,
    fallback: undefined,
    ms: { scan: 0, intervals: 0, seeds: 0, chains: 0, twins: 0 },
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

  try {
    // The anchors on both sides of the window, and every visit to them.
    const spacing = stats.spacing
    if (spacing === undefined) {
      throw new Fallback('the haplotype index has no anchors')
    }
    // The anchor for a multiple k lies in the half spacing before k * spacing,
    // so the one for the multiple at or before the window's start lies before
    // it, and the first anchor after the window's end is that of the multiple
    // past the end, or of the next.
    const multiple = Math.ceil(input.window.end / spacing)
    const [anchorBefore, ...candidates] = await Promise.all([
      db.haplotypeAnchor(
        input.referenceHandle,
        Math.floor(input.window.start / spacing) * spacing,
      ),
      db.haplotypeAnchor(input.referenceHandle, multiple * spacing),
      db.haplotypeAnchor(input.referenceHandle, (multiple + 1) * spacing),
    ])
    const anchorAfter = candidates.find(
      anchor => anchor !== undefined && anchor.pathOffset >= input.window.end,
    )
    if (!anchorBefore) {
      throw new Fallback('the haplotype index has no anchor before the window')
    }
    if (!anchorAfter) {
      throw new Fallback('the haplotype index has no anchor after the window')
    }
    stats.anchors = [anchorBefore.pathOffset, anchorAfter.pathOffset]
    const visitsAt = (node: number) => {
      const handle = node - (node % 2)
      return db.haplotypeSamplesInRange(handle, handle + 1)
    }
    const [near, far] = await Promise.all([
      visitsAt(anchorBefore.node),
      visitsAt(anchorAfter.node),
    ])
    if (
      !near.some(
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
    const span = new Map<number, [number, number]>()
    for (const row of [...near, ...far]) {
      const s = span.get(row.pathHandle)
      span.set(
        row.pathHandle,
        s
          ? [Math.min(s[0], row.pathOffset), Math.max(s[1], row.pathOffset)]
          : [row.pathOffset, row.pathOffset],
      )
    }
    // A walk for every visit of a chosen path to the anchor before the window
    // that the path follows to a visit to the anchor after it.
    const walks: { row: HaplotypeSample; stopAt: number }[] = []
    const walkedPaths = new Set<number>()
    const chosenAtAnchors = new Set(
      [...span.keys()].filter(pathHandle => chosen(pathHandle)),
    )
    stats.chosenPaths = chosenAtAnchors.size
    if (chosenAtAnchors.size > keepTuning.mostChosenPaths) {
      throw new Fallback(
        `${chosenAtAnchors.size} chosen paths pass the anchors, more than ${keepTuning.mostChosenPaths}`,
      )
    }
    for (const row of near) {
      if (chosenAtAnchors.has(row.pathHandle)) {
        const ahead = far
          .filter(
            f =>
              f.pathHandle === row.pathHandle &&
              (row.orientation === 'forward'
                ? f.pathOffset > row.pathOffset
                : f.pathOffset < row.pathOffset),
          )
          .map(f => f.pathOffset)
        if (ahead.length > 0) {
          walks.push({
            row,
            stopAt:
              row.orientation === 'forward'
                ? Math.min(...ahead)
                : Math.max(...ahead),
          })
          walkedPaths.add(row.pathHandle)
        }
      }
    }
    for (const pathHandle of chosenAtAnchors) {
      if (!walkedPaths.has(pathHandle)) {
        throw new Fallback(
          `chosen path ${pathHandle} has no walk from the anchor before the window to the anchor after it`,
        )
      }
    }

    // Every sample on the subgraph's nodes must lie within CHAIN_BOUND of the
    // stretch between its path's anchor visits.
    const seeds: HaplotypeSample[] = []
    stats.scans = handleRuns([...records.keys()].sort((a, b) => a - b))
    for (const [first, last] of stats.scans) {
      for (const sample of await db.haplotypeSamplesInRange(first, last)) {
        stats.scanRows += 1
        if (records.has(sample.node)) {
          const s = span.get(sample.pathHandle)
          if (
            !s ||
            sample.pathOffset < s[0] - CHAIN_BOUND ||
            sample.pathOffset > s[1] + CHAIN_BOUND
          ) {
            throw new Fallback(
              `path ${sample.pathHandle} has a sample on the window's nodes ${s ? 'far from its anchor visits' : 'and no visit to the anchors'}`,
            )
          }
          if (chosen(sample.pathHandle)) {
            seeds.push(sample)
          }
        }
      }
    }
    stats.ms.scan = lap()

    // Interval walks. A walk jumps over the pieces it lands in and ends
    // CHAIN_BOUND past the last piece or the far anchor, whichever is later,
    // then goes back from the near anchor as far as CHAIN_BOUND before the
    // first piece.
    const walkedRanges = new Map<number, [number, number][]>()
    await input.prefetchReferenceRange(
      input.referenceHandle,
      anchorBefore.pathOffset,
      anchorAfter.pathOffset + 1,
    )
    const cap = 8 * spacing + 2 * (input.window.end - input.window.start)
    for (const { row, stopAt } of walks) {
      const orientation = row.orientation
      const toward = (from: number, to: number) =>
        orientation === 'forward' ? to - from : from - to
      let lo = row.pathOffset
      let hi = row.pathOffset
      let firstLanding: number | undefined
      let pos: Pos | undefined = { node: row.node, offset: row.offset }
      let left = row.pathOffset
      let passed = false
      let sinceLast = 0
      let outsideBp = 0
      let end: KeepWalkEnd = 'past the far anchor'
      while (pos) {
        signal?.throwIfAborted()
        if (!passed && toward(left, stopAt) <= 0) {
          passed = true
        }
        if (passed && sinceLast > CHAIN_BOUND) {
          break
        }
        let len: number
        if (records.has(pos.node)) {
          firstLanding ??= left
          const piece = await pieceAtOrThrough(
            { pos, left },
            row.pathHandle,
            orientation,
            'interval',
          )
          const last = lastCursor(piece)
          pos = last.pos
          left = last.left
          len = lengthIn(last.pos.node)
          lo = Math.min(lo, piece.hapStart)
          hi = Math.max(hi, piece.hapEnd)
          sinceLast = 0
        } else {
          len = (await record(pos.node)).sequenceLen
          sinceLast += len
          outsideBp += len
          if (outsideBp > cap) {
            end = 'cap'
            break
          }
          lo = Math.min(lo, left)
          hi = Math.max(hi, left + len)
        }
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
      if (!pos && end !== 'cap') {
        end = 'endmarker'
      }
      countWalk('interval', end)
      if (end === 'cap') {
        throw new Fallback(
          `the walk of path ${row.pathHandle} between the anchors reached its cap of ${cap} bp`,
        )
      }
      let reach =
        firstLanding === undefined
          ? 0
          : CHAIN_BOUND - toward(row.pathOffset, firstLanding)
      let cursor: Cursor = {
        pos: { node: row.node, offset: row.offset },
        left: row.pathOffset,
      }
      let behind = 0
      while (reach > 0) {
        signal?.throwIfAborted()
        const earlier = await previous(cursor.pos)
        if (!earlier) {
          break
        }
        const earlierLeft = backwardLeft(
          orientation,
          cursor.left,
          (await record(cursor.pos.node)).sequenceLen,
          (await record(earlier.node)).sequenceLen,
        )
        if (records.has(earlier.node)) {
          const piece = await pieceAtOrThrough(
            { pos: earlier, left: earlierLeft },
            row.pathHandle,
            orientation,
            'interval',
          )
          cursor = firstCursor(piece)
          lo = Math.min(lo, piece.hapStart)
          hi = Math.max(hi, piece.hapEnd)
          reach = CHAIN_BOUND
          behind = 0
        } else {
          const len = (await record(earlier.node)).sequenceLen
          behind += len
          if (behind > reach) {
            break
          }
          cursor = { pos: earlier, left: earlierLeft }
          lo = Math.min(lo, earlierLeft)
          hi = Math.max(hi, earlierLeft + len)
        }
      }
      const ranges = walkedRanges.get(row.pathHandle)
      if (ranges) {
        ranges.push([lo, hi])
      } else {
        walkedRanges.set(row.pathHandle, [[lo, hi]])
      }
    }
    const walked = (piece: ChosenPiece) =>
      (walkedRanges.get(piece.pathHandle) ?? []).some(
        ([lo, hi]) => lo <= piece.hapStart && piece.hapEnd <= hi,
      )
    stats.ms.intervals = lap()

    // Seeds the walks did not reach: a sample inside a canonical piece already
    // found for its path adds nothing unless that piece's twin is canonical too.
    for (const sample of seeds) {
      if (
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
    stats.ms.seeds = lap()

    // Chains from the pieces no walk covered, forward and backward, through
    // every piece a chain lands in, until it meets a known position or runs
    // CHAIN_BOUND bp outside the subgraph.
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
    const unwalked = pieces
      .map((piece, id) => ({ piece, id }))
      .filter(({ piece, id }) => id !== referenceId && !walked(piece))
      .sort((a, b) => Number(b.piece.canonical) - Number(a.piece.canonical))
    for (const { piece, id } of unwalked) {
      if (!chained.has(pieceKey(piece))) {
        chained.add(pieceKey(piece))
        await chain(id, true)
        await chain(id, false)
      }
    }
    stats.ms.chains = lap()

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
