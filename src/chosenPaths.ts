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
} from './db.ts'
import type { Orientation } from './gbwt/node.ts'
import type { Pos } from './gbwt/record.ts'
import type { PathName } from './pathName.ts'

const SCAN_GAP = 4096

// Ranges merged where they overlap or lie within `gap` of each other.
export function mergeRanges(ranges: [number, number][], gap: number) {
  const merged: [number, number][] = []
  for (const [lo, hi] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1]
    if (last && lo <= last[1] + gap) {
      last[1] = Math.max(last[1], hi)
    } else {
      merged.push([lo, hi])
    }
  }
  return merged
}

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

// How far past the region its anchor visits allow a sample may lie. Walks cover
// CHAIN_BOUND past that region in each chosen path's coordinates, and half of
// it leaves room for an indel between two paths' coordinates.
const SAMPLE_BAND = CHAIN_BOUND / 2

// Above this many chosen paths at the anchors, extracting and identifying
// every walk took less time than walking the chosen ones, on HPRC chr22 windows
// with 42 haplotypes. Tests raise it to run the walks on large sets.
export const keepTuning = { mostChosenPaths: 32 }

export type ChosenPieceSource =
  'reference' | 'sample' | 'interval' | 'section' | 'stray' | 'chain' | 'twin'

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
  // The two anchors bracketing the window and up to two more out on each side.
  anchorsRead: number
  chosenPaths: number
  scans: [number, number][]
  scanRows: number
  // With HaplotypeStrays: the rows read around the window, those of chosen
  // paths walked, and the bases all walks took outside the subgraph.
  strays: { rows: number; walked: number; outsideBp: number } | undefined
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
  context: number
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

interface Walk {
  row: HaplotypeSample
  stopAt: number
  back: number
  kind: string
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
    anchorsRead: 0,
    chosenPaths: 0,
    scans: [],
    scanRows: 0,
    strays: undefined,
    seeds: 0,
    pieces: 0,
    sources: {
      reference: 0,
      sample: 0,
      interval: 0,
      section: 0,
      stray: 0,
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

  // Without HaplotypeStrays: walks planned from the anchor rows, checked
  // against the samples on the subgraph's nodes.
  const anchorRoute = async () => {
    // The anchors on both sides of the window and the next two out on each
    // side, and every visit to them. A chosen path that bypasses both near
    // anchor nodes is seen at a wider one, and a path seen at one anchor only
    // can pair a wider one.
    const spacing = stats.spacing
    if (spacing === undefined) {
      throw new Fallback('the haplotype index has no anchors')
    }
    // The anchor for a multiple k lies in the half spacing before k * spacing,
    // so the one for the multiple at or before the window's start lies before
    // it, and the first anchor after the window's end is that of the multiple
    // past the end, or of the next.
    const beforeMultiple = Math.floor(input.window.start / spacing)
    const multiple = Math.ceil(input.window.end / spacing)
    const anchorAt = (k: number) =>
      k >= 0
        ? db.haplotypeAnchor(input.referenceHandle, k * spacing)
        : Promise.resolve(undefined)
    const [befores, afters] = await Promise.all([
      Promise.all([0, 1, 2].map(i => anchorAt(beforeMultiple - i))),
      Promise.all([0, 1, 2, 3].map(i => anchorAt(multiple + i))),
    ])
    const anchorBefore = befores[0]
    const afterIndex = afters
      .slice(0, 2)
      .findIndex(
        anchor => anchor !== undefined && anchor.pathOffset >= input.window.end,
      )
    const anchorAfter = afters[afterIndex]
    if (!anchorBefore) {
      throw new Fallback('the haplotype index has no anchor before the window')
    }
    if (!anchorAfter) {
      throw new Fallback('the haplotype index has no anchor after the window')
    }
    stats.anchors = [anchorBefore.pathOffset, anchorAfter.pathOffset]
    const anchorsBefore = befores.filter(a => a !== undefined)
    const anchorsAfter = afters
      .slice(afterIndex, afterIndex + 3)
      .filter(a => a !== undefined)
    const rowsAt = new Map<HaplotypeAnchor, HaplotypeSample[]>()
    const anchors = [...anchorsBefore, ...anchorsAfter]
    const rows = await Promise.all(anchors.map(a => visitsAt(a.node)))
    anchors.forEach((anchor, i) => rowsAt.set(anchor, rows[i]!))
    stats.anchorsRead = anchors.length
    if (
      !rowsAt
        .get(anchorBefore)!
        .some(
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
    const rowsOf = (anchors: HaplotypeAnchor[], pathHandle: number) => {
      for (const anchor of anchors) {
        const rows = rowsAt
          .get(anchor)!
          .filter(row => row.pathHandle === pathHandle)
        if (rows.length > 0) {
          return { anchor, rows }
        }
      }
      return undefined
    }

    // Where a path can lie, from its visits to the nearest anchor on each
    // side, and a walk for each visit when the path is chosen. A path that
    // passes both anchors is walked from its visit to the one before the
    // window to its visit to the one after it. A path that passes one anchor
    // on the flipped handle carries an inversion covering that anchor and
    // traverses the reference's stretch between the anchors backward from
    // there, so its window pass lies past the far anchor or before the near
    // one, and the walk covers that stretch too. A path seen at one anchor
    // only ends between the anchors or skips the other one, and is walked
    // from its visit through the stretch to where the other anchor would be;
    // a walk that runs on past that point without the contig ending is
    // trusted only once the next anchors out pair the visit. A path with a
    // visit more than CHAIN_BOUND outside the stretches its pairs cover passes
    // the anchors from two copies of the region, and a walk from one copy does
    // not reach a pass of the other over the window's nodes.
    const span = new Map<number, [number, number]>()
    const walks: Walk[] = []
    const walkedPaths = new Set<number>()
    const plan = async (pathHandle: number) => {
      const before = rowsOf(anchorsBefore, pathHandle)
      const after = rowsOf(anchorsAfter, pathHandle)
      if (!before && !after) {
        return undefined
      }
      const nearRows = before?.rows ?? []
      const farRows = after?.rows ?? []
      const loci: [number, number][] = []
      const pairedVisits = new Set<number>()
      const nearAnchor = before?.anchor ?? anchorBefore
      const farAnchor = after?.anchor ?? anchorAfter
      const stretch = farAnchor.pathOffset - nearAnchor.pathOffset
      const isChosen = chosen(pathHandle)
      let paired = false
      for (const row of nearRows) {
        const sign = row.orientation === 'forward' ? 1 : -1
        const stop = farRows
          .filter(
            f =>
              f.orientation === row.orientation &&
              (f.pathOffset - row.pathOffset) * sign > 0,
          )
          .sort((a, b) => (a.pathOffset - b.pathOffset) * sign)[0]
        if (!stop) {
          continue
        }
        const nearAlong = row.node === nearAnchor.node
        const farAlong = stop.node === farAnchor.node
        let stopAt = stop.pathOffset
        let back = 0
        if (nearAlong && !farAlong) {
          stopAt += sign * ((await record(stop.node)).sequenceLen + stretch)
        } else if (!nearAlong && farAlong) {
          back = stretch
        }
        const from = row.pathOffset - sign * back
        loci.push([Math.min(from, stopAt), Math.max(from, stopAt)])
        pairedVisits.add(row.pathOffset)
        pairedVisits.add(stop.pathOffset)
        paired = true
        if (isChosen) {
          walks.push({
            row,
            stopAt,
            back,
            kind: nearAlong === farAlong ? 'interval' : 'inversion',
          })
          walkedPaths.add(pathHandle)
        }
      }
      const extraVisits = new Map<number, HaplotypeSample>()
      for (const row of [...nearRows, ...farRows]) {
        if (!paired) {
          loci.push([row.pathOffset - stretch, row.pathOffset + stretch])
        } else if (!pairedVisits.has(row.pathOffset)) {
          loci.push([row.pathOffset, row.pathOffset])
          extraVisits.set(row.pathOffset, row)
        }
      }
      const merged = mergeRanges(loci, CHAIN_BOUND)
      if (merged.length > 1) {
        throw new Fallback(
          `path ${pathHandle} visits the anchors from ${merged.length} copies of the region, at ${merged.map(([lo, hi]) => `${lo}-${hi}`).join(', ')}`,
        )
      }
      span.set(pathHandle, merged[0]!)
      // A visit no pair used, within CHAIN_BOUND of the stretch the pairs
      // cover, as a tandem copy of an anchor node gives, is walked
      // CHAIN_BOUND to each side.
      if (isChosen) {
        for (const row of extraVisits.values()) {
          walks.push({ row, stopAt: row.pathOffset, back: 0, kind: 'interval' })
        }
      }
      if (!paired) {
        // lf from the near anchor's own handle, or from the far anchor's
        // flipped one, heads toward the window.
        for (const row of [...nearRows, ...farRows]) {
          if (
            isChosen &&
            (row.node === nearAnchor.node ||
              row.node === flipNode(farAnchor.node))
          ) {
            const sign = row.orientation === 'forward' ? 1 : -1
            walks.push({
              row,
              stopAt: row.pathOffset + sign * stretch,
              back: 0,
              kind: 'one-sided',
            })
            walkedPaths.add(pathHandle)
          }
        }
      }
      return paired ? 'paired' : 'one-sided'
    }
    const pathsAtAnchors = new Set(
      [...rowsAt.values()].flat().map(row => row.pathHandle),
    )
    const chosenAtAnchors = [...pathsAtAnchors].filter(chosen)
    stats.chosenPaths = chosenAtAnchors.length
    if (chosenAtAnchors.length > keepTuning.mostChosenPaths) {
      throw new Fallback(
        `${chosenAtAnchors.length} chosen paths pass the anchors, more than ${keepTuning.mostChosenPaths}`,
      )
    }
    for (const pathHandle of pathsAtAnchors) {
      await plan(pathHandle)
    }

    // Every sample on the subgraph's nodes must lie where its path can:
    // within SAMPLE_BAND of the region its anchor visits allow, or on a path
    // with no visit to any anchor read that is short enough to start and end
    // between the outermost ones. A sample elsewhere marks a segmental
    // duplication or a collapsed paralog, where a chosen path can pass the
    // window's nodes without a sample outside every walk. A chosen path with
    // no visit is walked whole from its start. A chosen path with no visit
    // and no sample here stays out of reach.
    const seeds: HaplotypeSample[] = []
    const samples: HaplotypeSample[] = []
    stats.scans = handleRuns([...records.keys()].sort((a, b) => a - b))
    for (const [first, last] of stats.scans) {
      for (const sample of await db.haplotypeSamplesInRange(first, last)) {
        stats.scanRows += 1
        if (records.has(sample.node)) {
          samples.push(sample)
          if (chosen(sample.pathHandle)) {
            seeds.push(sample)
          }
        }
      }
    }
    if (
      chosenAtAnchors.length === 0 &&
      seeds.length === 0 &&
      [...pathsByHandle.values()].some(path => input.keep(path.name))
    ) {
      throw new Fallback(
        "no chosen path passes the anchors or has a sample on the window's nodes",
      )
    }
    const unplaced = new Set(
      samples
        .map(s => s.pathHandle)
        .filter(pathHandle => !span.has(pathHandle)),
    )
    const outerStretch =
      anchorsAfter[anchorsAfter.length - 1]!.pathOffset -
      anchorsBefore[anchorsBefore.length - 1]!.pathOffset
    // A contig split into fragments stores each fragment as a path, and a
    // fragment that lies between the anchors has no row, and no sample on the
    // window's nodes unless one of its sparse samples lands there. Its name
    // gives its offset in the contig, so a chosen fragment whose contig range
    // meets the region its placed siblings allow is walked whole too.
    const contigOf = (name: PathName) =>
      `${name.sample}#${name.haplotype}#${name.contig}`
    const siblingRegion = new Map<string, [number, number]>()
    for (const [pathHandle, [lo, hi]] of span) {
      const name = pathsByHandle.get(pathHandle)?.name
      if (name && chosen(pathHandle)) {
        const key = contigOf(name)
        const from = name.fragment + lo - CHAIN_BOUND
        const to = name.fragment + hi + CHAIN_BOUND
        const region = siblingRegion.get(key)
        siblingRegion.set(
          key,
          region
            ? [Math.min(region[0], from), Math.max(region[1], to)]
            : [from, to],
        )
      }
    }
    const fragments: number[] = []
    for (const [pathHandle, path] of pathsByHandle) {
      const region = siblingRegion.get(contigOf(path.name))
      if (
        region &&
        !span.has(pathHandle) &&
        !unplaced.has(pathHandle) &&
        input.keep(path.name)
      ) {
        const length = (await db.haplotypeLength(pathHandle)) ?? 0
        if (
          path.name.fragment < region[1] &&
          path.name.fragment + length > region[0]
        ) {
          fragments.push(pathHandle)
        }
      }
    }
    for (const pathHandle of [...unplaced, ...fragments]) {
      const length =
        (await db.haplotypeLength(pathHandle)) ?? Number.POSITIVE_INFINITY
      if (length > outerStretch + 2 * CHAIN_BOUND) {
        throw new Fallback(
          unplaced.has(pathHandle)
            ? `path ${pathHandle} of ${length} bp has a sample on the window's nodes and no visit to the anchors`
            : `chosen fragment ${pathHandle} of ${length} bp lies beside its contig's visits to the anchors without a visit of its own`,
        )
      }
      if (chosen(pathHandle)) {
        const start = (await db.getPath(pathHandle))?.fwStart
        if (!start) {
          throw new Error(`Path ${pathHandle} is missing from the database`)
        }
        walks.push({
          row: {
            node: start.node,
            offset: start.offset,
            pathHandle,
            orientation: 'forward',
            pathOffset: 0,
          },
          stopAt: length,
          back: 0,
          kind: 'whole',
        })
      }
    }
    for (const pathHandle of span.keys()) {
      if (chosen(pathHandle) && !walkedPaths.has(pathHandle)) {
        throw new Fallback(
          `chosen path ${pathHandle} has no walk from its visits to the anchors`,
        )
      }
    }
    for (const sample of samples) {
      const s = span.get(sample.pathHandle)
      if (
        s &&
        (sample.pathOffset < s[0] - SAMPLE_BAND ||
          sample.pathOffset > s[1] + SAMPLE_BAND)
      ) {
        throw new Fallback(
          `path ${sample.pathHandle} has a sample at ${sample.pathOffset} on the window's nodes far from its anchor visits at ${s[0]}-${s[1]}`,
        )
      }
    }
    stats.ms.scan = lap()

    // Interval walks. A walk jumps over the pieces it lands in and ends once it
    // is CHAIN_BOUND past both its stop and the last piece, then goes back from
    // the near anchor CHAIN_BOUND past both the visit and the first piece, or
    // through the stretch an inversion puts before the near anchor. So a walk
    // covers every offset the sample check allows its path.
    const walkedRanges = new Map<number, [number, number][]>()
    await input.prefetchReferenceRange(
      input.referenceHandle,
      Math.max(0, anchorBefore.pathOffset - CHAIN_BOUND),
      anchorAfter.pathOffset + CHAIN_BOUND + 1,
    )
    const cap = 8 * spacing + 2 * (input.window.end - input.window.start)
    for (const { row, stopAt, back, kind } of walks) {
      const orientation = row.orientation
      const toward = (from: number, to: number) =>
        orientation === 'forward' ? to - from : from - to
      let lo = row.pathOffset
      let hi = row.pathOffset
      let pos: Pos | undefined = { node: row.node, offset: row.offset }
      let left = row.pathOffset
      let beyond = false
      let sinceLast = 0
      let outsideBp = 0
      let end: KeepWalkEnd = 'past the far anchor'
      while (pos) {
        signal?.throwIfAborted()
        if (!beyond && toward(left, stopAt) <= -CHAIN_BOUND) {
          beyond = true
        }
        if (beyond && sinceLast > CHAIN_BOUND) {
          break
        }
        let len: number
        if (records.has(pos.node)) {
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
      countWalk(kind, end)
      if (end === 'cap') {
        throw new Fallback(
          `the walk of path ${row.pathHandle} between the anchors reached its cap of ${cap} bp`,
        )
      }
      if (kind === 'one-sided' && end !== 'endmarker') {
        throw new Fallback(
          `chosen path ${row.pathHandle} runs on past the stretch from its visit to one anchor without a visit to the other`,
        )
      }
      let reach = CHAIN_BOUND
      let cursor: Cursor = {
        pos: { node: row.node, offset: row.offset },
        left: row.pathOffset,
      }
      let behind = 0
      let must = back
      while (reach > 0 || must > 0) {
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
          must -= piece.len
        } else {
          const len = (await record(earlier.node)).sequenceLen
          behind += len
          if (behind > reach && must <= 0) {
            break
          }
          must -= len
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

    // Chains from the pieces no walk covered.
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
  }

  // With HaplotypeStrays: every section of a chosen path between its visits
  // to adjacent anchors near the reference piece is walked CHAIN_BOUND past
  // both ends, and every stray row of a chosen path whose loci meet the piece
  // is walked, and the index lists every visit to the subgraph those walks do
  // not reach. A sample of a chosen path in the subgraph outside every walk
  // would contradict that, and falls back.
  const strayRoute = async (strayContext: number) => {
    if (input.context > strayContext) {
      throw new Fallback(
        `the context of ${input.context} bp exceeds the ${strayContext} bp the haplotype index's stray rows cover`,
      )
    }
    const spacing = stats.spacing
    if (spacing === undefined) {
      throw new Fallback('the haplotype index has no anchors')
    }
    const lo = Math.max(0, reference.hapStart - strayContext)
    const hi = reference.hapEnd + strayContext
    const firstMultiple = Math.max(
      0,
      Math.floor((lo - CHAIN_BOUND) / spacing) - 1,
    )
    const lastMultiple = Math.ceil((hi + CHAIN_BOUND) / spacing) + 1
    const read = await Promise.all(
      Array.from(
        { length: lastMultiple - firstMultiple + 1 },
        (_, i) => firstMultiple + i,
      ).map(async k => {
        const anchor = await db.haplotypeAnchor(
          input.referenceHandle,
          k * spacing,
        )
        return anchor && { k, anchor, rows: await visitsAt(anchor.node) }
      }),
    )
    const anchors = read.filter(a => a !== undefined)
    const own = anchors[0]
    if (!own) {
      throw new Fallback('the haplotype index has no anchors on this path')
    }
    if (
      !own.rows.some(
        row =>
          row.pathHandle === input.referenceHandle &&
          row.orientation === 'forward' &&
          row.pathOffset === own.anchor.pathOffset,
      )
    ) {
      throw new Error(
        `The haplotype index has no anchor row for the reference path ${input.referenceHandle} at offset ${own.anchor.pathOffset} (node ${nodeId(own.anchor.node)}); it does not match this graph`,
      )
    }
    const offsetOf = new Map(anchors.map(a => [a.k, a.anchor.pathOffset]))
    const anchorOffset = (k: number) => offsetOf.get(k)!
    const before = anchors.filter(
      a => a.anchor.pathOffset <= input.window.start,
    )
    const after = anchors.filter(a => a.anchor.pathOffset >= input.window.end)
    stats.anchors = [
      (before[before.length - 1] ?? own).anchor.pathOffset,
      (after[0] ?? anchors[anchors.length - 1]!).anchor.pathOffset,
    ]
    stats.anchorsRead = anchors.length
    const visits = new Map<number, { k: number; row: HaplotypeSample }[]>()
    const atAnchors = new Set<number>()
    for (const { k, rows } of anchors) {
      for (const row of rows) {
        atAnchors.add(row.pathHandle)
        if (row.orientation === 'forward' && chosen(row.pathHandle)) {
          visits.set(row.pathHandle, [
            ...(visits.get(row.pathHandle) ?? []),
            { k, row },
          ])
        }
      }
    }
    stats.chosenPaths = [...atAnchors].filter(chosen).length
    if (stats.chosenPaths > keepTuning.mostChosenPaths) {
      throw new Fallback(
        `${stats.chosenPaths} chosen paths pass the anchors, more than ${keepTuning.mostChosenPaths}`,
      )
    }
    const found = await db.haplotypeStraysInRange(input.referenceHandle, lo, hi)
    const strays = found.filter(row => chosen(row.pathHandle))
    stats.strays = { rows: found.length, walked: 0, outsideBp: 0 }
    await input.prefetchReferenceRange(
      input.referenceHandle,
      Math.max(0, own.anchor.pathOffset - CHAIN_BOUND),
      anchors[anchors.length - 1]!.anchor.pathOffset + CHAIN_BOUND + 1,
    )
    stats.ms.scan = lap()

    // A cap on each walk's bases outside the subgraph, as on the anchor route.
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
        ([a, b]) => a <= from && to <= b,
      )
    const markWalked = (pathHandle: number, from: number, to: number) => {
      walkedRanges.set(pathHandle, [
        ...(walkedRanges.get(pathHandle) ?? []),
        [from, to],
      ])
    }
    // Forward along a path from a position until past `until`, jumping over
    // the pieces it lands in; returns the offset it reached.
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
    // Backward from a position until before `until`; returns the offset reached.
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

    // A section whose reference span meets [lo, hi] is walked whole. One that
    // ends within CHAIN_BOUND of it is walked CHAIN_BOUND to each side of the
    // visit at that end, the only visits of it the index leaves out.
    const around = async (pathHandle: number, visit: HaplotypeSample) => {
      const at = visit.pathOffset
      if (covered(pathHandle, at - CHAIN_BOUND, at + CHAIN_BOUND)) {
        return
      }
      const pos = { node: visit.node, offset: visit.offset }
      walkBp = 0
      const reachedEnd = await walkForward(
        pathHandle,
        pos,
        at,
        at + CHAIN_BOUND,
        'section',
      )
      const reachedStart = await walkBackward(
        pathHandle,
        pos,
        at,
        at - CHAIN_BOUND,
      )
      markWalked(pathHandle, reachedStart, reachedEnd)
      countWalk('visit', 'bound')
    }
    for (const [pathHandle, list] of visits) {
      list.sort((a, b) => a.row.pathOffset - b.row.pathOffset)
      for (let i = 0; i + 1 < list.length; i++) {
        const from = list[i]!
        const to = list[i + 1]!
        if (Math.abs(from.k - to.k) !== 1) {
          continue
        }
        const [low, high] =
          anchorOffset(from.k) <= anchorOffset(to.k) ? [from, to] : [to, from]
        if (anchorOffset(high.k) < lo) {
          if (lo - anchorOffset(high.k) <= CHAIN_BOUND) {
            await around(pathHandle, high.row)
          }
          continue
        }
        if (anchorOffset(low.k) > hi) {
          if (anchorOffset(low.k) - hi <= CHAIN_BOUND) {
            await around(pathHandle, low.row)
          }
          continue
        }
        const start = from.row.pathOffset
        const stop = to.row.pathOffset + CHAIN_BOUND
        if (covered(pathHandle, start - CHAIN_BOUND, stop)) {
          continue
        }
        const pos = { node: from.row.node, offset: from.row.offset }
        walkBp = 0
        const reachedEnd = await walkForward(
          pathHandle,
          pos,
          start,
          stop,
          'section',
        )
        walkBp = 0
        const reachedStart = covered(pathHandle, start - CHAIN_BOUND, start)
          ? start
          : await walkBackward(pathHandle, pos, start, start - CHAIN_BOUND)
        markWalked(pathHandle, reachedStart, reachedEnd)
        countWalk('section', 'past the far anchor')
      }
    }
    for (const row of strays) {
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
      markWalked(row.pathHandle, row.pathStart, reachedEnd)
      counted.walked += 1
    }
    stats.ms.intervals = lap()

    stats.scans = handleRuns([...records.keys()].sort((a, b) => a - b))
    for (const [first, last] of stats.scans) {
      for (const sample of await db.haplotypeSamplesInRange(first, last)) {
        stats.scanRows += 1
        if (
          records.has(sample.node) &&
          sample.pathHandle !== input.referenceHandle &&
          chosen(sample.pathHandle) &&
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
      }
    }
    stats.ms.seeds = lap()
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
    const strayContext = db.haplotypeStrayContext()
    if (strayContext === undefined) {
      await anchorRoute()
    } else {
      await strayRoute(strayContext)
    }
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
