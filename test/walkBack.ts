import { flipNode } from '../src/gbwt/node.ts'

import type { GBZBase } from '../src/db.ts'
import type { Pos } from '../src/gbwt/record.ts'
import type { HaplotypeAlignment } from '../src/subgraph.ts'

// An independent check of a resolved record: walking back through the
// bidirectional GBWT from the record's first position must reach the path's
// recorded start after exactly the bp the record's own coordinate claims.
export async function walkBack(db: GBZBase, pos: Pos) {
  let current = pos
  let bpBefore = 0
  for (;;) {
    const flipped = await db.getRecord(flipNode(current.node))
    const predecessor = flipped?.gbwt().predecessorAt(current.offset)
    if (predecessor === undefined) {
      return { start: current, bpBefore }
    }
    const record = await db.getRecord(predecessor)
    const offset = record?.gbwt().offsetTo(current)
    if (!record || offset === undefined) {
      throw new Error(
        `No offset in ${predecessor} leads to ${current.node}:${current.offset}`,
      )
    }
    current = { node: predecessor, offset }
    bpBefore += record.sequenceLen
  }
}

// The same check against the companion instead of the path's start: walking
// back from the record's first position must meet a per-path sample row of
// the record's own path, and the bp walked plus that row's coordinate must be
// the coordinate the record claims. Cheap enough for a hosted graph, where
// the path's start can be a hundred megabases away.
export async function walkBackToSample(
  db: GBZBase,
  pos: Pos,
  pathHandle: number,
) {
  let current = pos
  let bpBefore = 0
  for (;;) {
    const sample = await db.haplotypeSampleAt(current.node, current.offset)
    if (sample) {
      if (sample.pathHandle !== pathHandle) {
        throw new Error(
          `The sample at ${current.node}:${current.offset} belongs to path ${sample.pathHandle}, not ${pathHandle}`,
        )
      }
      return { sample, bpBefore }
    }
    const flipped = await db.getRecord(flipNode(current.node))
    const predecessor = flipped?.gbwt().predecessorAt(current.offset)
    if (predecessor === undefined) {
      throw new Error(
        `Reached the start of path ${pathHandle} after ${bpBefore} bp without meeting a sample`,
      )
    }
    const record = await db.getRecord(predecessor)
    const offset = record?.gbwt().offsetTo(current)
    if (!record || offset === undefined) {
      throw new Error(
        `No offset in ${predecessor} leads to ${current.node}:${current.offset}`,
      )
    }
    current = { node: predecessor, offset }
    bpBefore += record.sequenceLen
  }
}

export async function checkResolvedRecordAgainstSamples(
  db: GBZBase,
  alignment: HaplotypeAlignment,
) {
  if (!alignment.resolved) {
    throw new Error('the record is not resolved')
  }
  const gbzPath = await db.getPath(alignment.pathHandle)
  if (!gbzPath) {
    throw new Error(`path ${alignment.pathHandle} is missing`)
  }
  const { sample, bpBefore } = await walkBackToSample(
    db,
    alignment.start,
    alignment.pathHandle,
  )
  const length = await db.haplotypeLength(alignment.pathHandle)
  if (length === undefined) {
    throw new Error(`path ${alignment.pathHandle} has no length`)
  }
  const local = {
    start: alignment.hapStart - gbzPath.name.fragment,
    end: alignment.hapEnd - gbzPath.name.fragment,
  }
  const consumed = cigarConsumption(alignment.cigar)
  return {
    sampleOrientation: sample.orientation,
    bpBefore: sample.pathOffset + bpBefore,
    claimedBefore: alignment.strand === '+' ? local.start : length - local.end,
    hapLen: local.end - local.start,
    consumed,
    refLen: alignment.refEnd - alignment.refStart,
  }
}

export function cigarConsumption(cigar: string) {
  let query = 0
  let reference = 0
  for (const [, len, op] of cigar.matchAll(/(\d+)([MID])/g)) {
    if (op !== 'D') {
      query += Number(len)
    }
    if (op !== 'I') {
      reference += Number(len)
    }
  }
  return { query, reference }
}

export async function checkResolvedRecord(
  db: GBZBase,
  alignment: HaplotypeAlignment,
) {
  if (!alignment.resolved) {
    throw new Error('the record is not resolved')
  }
  const gbzPath = await db.getPath(alignment.pathHandle)
  if (!gbzPath) {
    throw new Error(`path ${alignment.pathHandle} is missing`)
  }
  const { start, bpBefore } = await walkBack(db, alignment.start)
  const expectedStart =
    alignment.strand === '+' ? gbzPath.fwStart : gbzPath.revStart
  const length = await db.haplotypeLength(alignment.pathHandle)
  if (length === undefined) {
    throw new Error(`path ${alignment.pathHandle} has no length`)
  }
  const local = {
    start: alignment.hapStart - gbzPath.name.fragment,
    end: alignment.hapEnd - gbzPath.name.fragment,
  }
  const consumed = cigarConsumption(alignment.cigar)
  return {
    start,
    expectedStart,
    bpBefore,
    claimedBefore: alignment.strand === '+' ? local.start : length - local.end,
    hapLen: local.end - local.start,
    consumed,
    refLen: alignment.refEnd - alignment.refStart,
  }
}
