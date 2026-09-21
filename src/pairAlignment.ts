import { isReverse, nodeId } from './gbwt/node.ts'
import { reverseComplement } from './gbwt/sequence.ts'

export type PairOp = '=' | 'X' | 'I' | 'D'
export type PairEdit = [PairOp, number]

export interface PairChain {
  queryStart: number
  queryEnd: number
  targetStart: number
  targetEnd: number
  strand: '+' | '-'
  edits: PairEdit[]
  // bases on nodes both walks visit; the other `=` came from comparing bases
  sharedBases: number
}

export interface PairOptions {
  maxGap?: number
  minMatch?: number
}

// An exact match: query [qs, qe) against target [ts, te), the target read
// backwards when flipped.
interface Run {
  qs: number
  qe: number
  ts: number
  te: number
  flipped: boolean
}

const DEFAULT_MIN_MATCH = 100
const MAX_ALIGNED_CELLS = 4_000_000
const CHAIN_LOOKBACK = 5000
const KMER = 15
const MAX_KMER_OCCURRENCES = 64

// vg's scoring, the model the reference CIGARs in subgraph.ts are scored by
const MATCH = 1
const MISMATCH = -4
const GAP_OPEN = -6
const GAP_EXTEND = -1
const UNREACHABLE = -(2 ** 30)

const DIAGONAL = 0
const INSERTION = 1
const DELETION = 2

function appendEdit(edits: PairEdit[], op: PairOp, len: number) {
  const last = edits.at(-1)
  if (len > 0) {
    if (last?.[0] === op) {
      last[1] += len
    } else {
      edits.push([op, len])
    }
  }
}

function best(diagonal: number, insertion: number, deletion: number) {
  return diagonal >= deletion && diagonal >= insertion
    ? DIAGONAL
    : deletion >= insertion
      ? DELETION
      : INSERTION
}

// The highest-scoring global alignment of a on b under affine gaps. Each cell
// of `trace` packs, two bits apiece, the state each of the three states came
// from. A tie goes to the diagonal, then to the deletion, so two stretches
// with nothing in common read as an insertion followed by a deletion.
function affineAlignment(a: string, b: string, edits: PairEdit[]) {
  const la = a.length
  const lb = b.length
  const width = lb + 1
  const trace = new Uint8Array((la + 1) * width)
  let diagonal = new Int32Array(width).fill(UNREACHABLE)
  let insertion = new Int32Array(width).fill(UNREACHABLE)
  let deletion = new Int32Array(width).fill(UNREACHABLE)
  diagonal[0] = 0
  for (let j = 1; j <= lb; j++) {
    deletion[j] = GAP_OPEN + (j - 1) * GAP_EXTEND
    trace[j] = (j === 1 ? DIAGONAL : DELETION) << 4
  }
  for (let i = 1; i <= la; i++) {
    const nextDiagonal = new Int32Array(width).fill(UNREACHABLE)
    const nextInsertion = new Int32Array(width).fill(UNREACHABLE)
    const nextDeletion = new Int32Array(width).fill(UNREACHABLE)
    nextInsertion[0] = GAP_OPEN + (i - 1) * GAP_EXTEND
    trace[i * width] = (i === 1 ? DIAGONAL : INSERTION) << 2
    const ai = a.charCodeAt(i - 1)
    for (let j = 1; j <= lb; j++) {
      const fromDiagonal = best(
        diagonal[j - 1]!,
        insertion[j - 1]!,
        deletion[j - 1]!,
      )
      nextDiagonal[j] =
        Math.max(diagonal[j - 1]!, insertion[j - 1]!, deletion[j - 1]!) +
        (ai === b.charCodeAt(j - 1) ? MATCH : MISMATCH)
      const fromInsertion = best(
        diagonal[j]! + GAP_OPEN,
        insertion[j]! + GAP_EXTEND,
        deletion[j]! + GAP_OPEN,
      )
      nextInsertion[j] = Math.max(
        diagonal[j]! + GAP_OPEN,
        insertion[j]! + GAP_EXTEND,
        deletion[j]! + GAP_OPEN,
      )
      const fromDeletion = best(
        nextDiagonal[j - 1]! + GAP_OPEN,
        nextInsertion[j - 1]! + GAP_OPEN,
        nextDeletion[j - 1]! + GAP_EXTEND,
      )
      nextDeletion[j] = Math.max(
        nextDiagonal[j - 1]! + GAP_OPEN,
        nextInsertion[j - 1]! + GAP_OPEN,
        nextDeletion[j - 1]! + GAP_EXTEND,
      )
      trace[i * width + j] =
        fromDiagonal | (fromInsertion << 2) | (fromDeletion << 4)
    }
    diagonal = nextDiagonal
    insertion = nextInsertion
    deletion = nextDeletion
  }
  const ops: PairOp[] = []
  let i = la
  let j = lb
  let state = best(diagonal[lb]!, insertion[lb]!, deletion[lb]!)
  while (i > 0 || j > 0) {
    const from = (trace[i * width + j]! >> (2 * state)) & 3
    if (state === DIAGONAL) {
      ops.push(a[i - 1] === b[j - 1] ? '=' : 'X')
      i -= 1
      j -= 1
    } else if (state === INSERTION) {
      ops.push('I')
      i -= 1
    } else {
      ops.push('D')
      j -= 1
    }
    state = from
  }
  for (const op of ops.reverse()) {
    appendEdit(edits, op, 1)
  }
}

// What a chain of walk steps pays to go from one run to the next over dq
// private query bases and dt target ones. Those runs lie outside both walks'
// repeats, so each has one place to go and the cost only has to let a chain
// hold through a structural variant of any size: vg's charge for a short
// indel, growing with the logarithm past it.
function stepJumpCost(dq: number, dt: number) {
  const indel = Math.abs(dq - dt)
  const indelCost =
    indel === 0
      ? 0
      : Math.min(
          -GAP_OPEN - (indel - 1) * GAP_EXTEND,
          -GAP_OPEN + 10 * Math.log2(indel),
        )
  return indelCost + (Math.min(dq, dt) > 0 ? -MISMATCH : 0)
}

// What a chain of k-mer matches pays, which is minimap2's gap cost. Inside a
// tandem array every copy offers a match, and the term that grows with the
// indel is what keeps a chain in one register instead of hopping between
// copies for a slightly longer match.
function kmerJumpCost(dq: number, dt: number) {
  const indel = Math.abs(dq - dt)
  return indel === 0 ? 0 : 0.01 * KMER * indel + 0.5 * Math.log2(indel)
}

type JumpCost = (dq: number, dt: number) => number

interface Link {
  run: Run
  trim: number
}

function overlaps(intervals: [number, number][], start: number, end: number) {
  return intervals.some(([s, e]) => start < e && s < end)
}

// The best-scoring collinear chain of runs, then the best over the runs that
// overlap no accepted run on either sequence, and so on: a second copy of a
// repeat finds its target taken and an inversion finds its target free. A run
// that overlaps its predecessor is trimmed from the front, which an exact
// match allows at any base.
function chainRuns(
  runs: Run[],
  maxGap: number,
  minMatch: number,
  jumpCost: JumpCost,
) {
  const chains: Link[][] = []
  const queryTaken: [number, number][] = []
  const targetTaken: [number, number][] = []
  let pool = [...runs].sort((a, b) => a.qs - b.qs || a.ts - b.ts)
  while (pool.length > 0) {
    const score = pool.map(run => run.qe - run.qs)
    const back = new Int32Array(pool.length).fill(-1)
    const trims = new Int32Array(pool.length)
    for (let j = 0; j < pool.length; j++) {
      const b = pool[j]!
      const len = b.qe - b.qs
      for (let i = j - 1; i >= Math.max(0, j - CHAIN_LOOKBACK); i--) {
        const a = pool[i]!
        const advances =
          a.flipped === b.flipped &&
          a.qs < b.qs &&
          (b.flipped ? b.te < a.te : a.ts < b.ts)
        if (advances) {
          const trim = Math.max(
            0,
            a.qe - b.qs,
            b.flipped ? b.te - a.ts : a.te - b.ts,
          )
          const dq = b.qs + trim - a.qe
          const dt = b.flipped ? a.ts - (b.te - trim) : b.ts + trim - a.te
          if (trim < len && dq <= maxGap && dt <= maxGap) {
            const candidate = score[i]! + len - trim - jumpCost(dq, dt)
            if (candidate > score[j]!) {
              score[j] = candidate
              back[j] = i
              trims[j] = trim
            }
          }
        }
      }
    }
    let end = 0
    for (let j = 1; j < pool.length; j++) {
      if (score[j]! > score[end]!) {
        end = j
      }
    }
    const chain: Link[] = []
    for (let j = end; j >= 0; j = back[j]!) {
      chain.push({ run: pool[j]!, trim: trims[j]! })
    }
    chain.reverse()
    const matched = chain.reduce(
      (sum, { run, trim }) => sum + run.qe - run.qs - trim,
      0,
    )
    if (matched < minMatch) {
      break
    }
    chains.push(chain)
    for (const { run, trim } of chain) {
      queryTaken.push([run.qs + trim, run.qe])
      targetTaken.push(
        run.flipped ? [run.ts, run.te - trim] : [run.ts + trim, run.te],
      )
    }
    pool = pool.filter(
      run =>
        !overlaps(queryTaken, run.qs, run.qe) &&
        !overlaps(targetTaken, run.ts, run.te),
    )
  }
  return chains
}

// Exact matches of KMER bases or more between a and b, as runs along a
// diagonal. A k-mer the target holds many times over seeds nothing.
function forwardKmerRuns(a: string, b: string) {
  const index = new Map<string, number[]>()
  for (let p = 0; p + KMER <= b.length; p++) {
    const kmer = b.slice(p, p + KMER)
    const seen = index.get(kmer)
    if (seen) {
      seen.push(p)
    } else {
      index.set(kmer, [p])
    }
  }
  const runs: Run[] = []
  const open = new Map<number, Run>()
  for (let i = 0; i + KMER <= a.length; i++) {
    const hits = index.get(a.slice(i, i + KMER))
    if (hits && hits.length <= MAX_KMER_OCCURRENCES) {
      for (const p of hits) {
        const diagonal = p - i
        const run = open.get(diagonal)
        if (run && i <= run.qe) {
          run.qe = i + KMER
          run.te = p + KMER
        } else {
          const started = {
            qs: i,
            qe: i + KMER,
            ts: p,
            te: p + KMER,
            flipped: false,
          }
          open.set(diagonal, started)
          runs.push(started)
        }
      }
    }
  }
  return runs
}

function kmerRuns(a: string, b: string) {
  return [
    ...forwardKmerRuns(a, b),
    ...forwardKmerRuns(a, reverseComplement(b)).map(run => ({
      ...run,
      ts: b.length - run.te,
      te: b.length - run.ts,
      flipped: true,
    })),
  ]
}

// The edits of one chain: each run is a run of `=`, and what lies between two
// runs goes to `between`. Edits read along the query; the caller reverses a
// flipped chain's so they read along the target.
function chainEdits(
  chain: Link[],
  a: string,
  b: string,
  edits: PairEdit[],
  between: (
    a: string,
    b: string,
    edits: PairEdit[],
    queryFrom: number,
    targetFrom: number,
  ) => void,
) {
  let previous: Run | undefined
  for (const { run, trim } of chain) {
    const qs = run.qs + trim
    if (previous) {
      const targetFrom = run.flipped ? run.te - trim : previous.te
      const targetTo = run.flipped ? previous.ts : run.ts + trim
      const target = b.slice(targetFrom, targetTo)
      between(
        a.slice(previous.qe, qs),
        run.flipped ? reverseComplement(target) : target,
        edits,
        previous.qe,
        targetFrom,
      )
    }
    appendEdit(edits, '=', run.qe - qs)
    previous = run
  }
}

function alignSmall(a: string, b: string, edits: PairEdit[]) {
  if (a.length * b.length <= MAX_ALIGNED_CELLS) {
    affineAlignment(a, b, edits)
  } else {
    appendEdit(edits, 'I', a.length)
    appendEdit(edits, 'D', b.length)
  }
}

// A chain as a record in the coordinates of the two strings it was made on
function recordOf(chain: Link[], a: string, b: string): PairChain {
  const edits: PairEdit[] = []
  chainEdits(chain, a, b, edits, alignSmall)
  const first = chain[0]!
  const last = chain.at(-1)!
  const { flipped } = first.run
  return {
    queryStart: first.run.qs + first.trim,
    queryEnd: last.run.qe,
    targetStart: flipped ? last.run.ts : first.run.ts + first.trim,
    targetEnd: flipped ? first.run.te - first.trim : last.run.te,
    strand: flipped ? '-' : '+',
    edits: flipped ? edits.reverse() : edits,
    sharedBases: 0,
  }
}

// The private bases between two shared nodes. A pair too large for the exact
// alignment is seeded on shared k-mers in both orientations and chained the
// way the walks are, which aligns two long copies of one sequence the graph
// left apart. The best forward chain becomes edits. A flipped chain is an
// inversion, which no CIGAR holds, so it comes back as a record of its own in
// the coordinates of a and b. What no chain reaches is an insertion and a
// deletion, which claims no homology.
function alignPrivate(
  a: string,
  b: string,
  edits: PairEdit[],
  minMatch: number,
): PairChain[] {
  let inversions: PairChain[] = []
  if (a.length * b.length <= MAX_ALIGNED_CELLS) {
    affineAlignment(a, b, edits)
  } else {
    const chains = chainRuns(
      kmerRuns(a, b),
      Infinity,
      Math.max(minMatch, KMER),
      kmerJumpCost,
    )
    const forward = chains.find(chain => !chain[0]!.run.flipped)
    inversions = chains
      .filter(chain => chain[0]!.run.flipped)
      .map(chain => recordOf(chain, a, b))
    if (forward) {
      const first = forward[0]!.run
      const last = forward.at(-1)!.run
      alignSmall(a.slice(0, first.qs), b.slice(0, first.ts), edits)
      chainEdits(forward, a, b, edits, alignSmall)
      alignSmall(a.slice(last.qe), b.slice(last.te), edits)
    } else {
      appendEdit(edits, 'I', a.length)
      appendEdit(edits, 'D', b.length)
    }
  }
  return inversions
}

function walkSequence(walk: number[], sequenceOf: (id: number) => string) {
  return walk
    .map(handle => {
      const sequence = sequenceOf(nodeId(handle))
      return isReverse(handle) ? reverseComplement(sequence) : sequence
    })
    .join('')
}

function walkOffsets(walk: number[], sequenceOf: (id: number) => string) {
  const offsets = [0]
  for (const handle of walk) {
    offsets.push(offsets.at(-1)! + sequenceOf(nodeId(handle)).length)
  }
  return offsets
}

// The steps between a walk's first and last visit to any node it visits more
// than once. Copies of a repeat folded onto one node say nothing about which
// copy of one haplotype pairs with which copy of the other, and a graph can
// pair them out of register, so there the bases decide.
function repeatSteps(walk: number[]) {
  const first = new Map<number, number>()
  const last = new Map<number, number>()
  walk.forEach((handle, i) => {
    const id = nodeId(handle)
    if (first.has(id)) {
      last.set(id, i)
    } else {
      first.set(id, i)
    }
  })
  const change = new Int32Array(walk.length + 1)
  for (const [id, end] of last) {
    change[first.get(id)!]! += 1
    change[end + 1]! -= 1
  }
  const inside = new Uint8Array(walk.length)
  let depth = 0
  for (let i = 0; i < walk.length; i++) {
    depth += change[i]!
    inside[i] = depth > 0 ? 1 : 0
  }
  return inside
}

// Every stretch of steps the two walks take through the same nodes, in the
// same order or the opposite one, outside both walks' repeats.
function sharedRuns(
  query: number[],
  target: number[],
  queryOffsets: number[],
  targetOffsets: number[],
) {
  const queryRepeat = repeatSteps(query)
  const targetRepeat = repeatSteps(target)
  const visits = new Map<number, number[]>()
  target.forEach((handle, rank) => {
    if (!targetRepeat[rank]) {
      visits.set(nodeId(handle), [rank])
    }
  })
  const width = 2 * target.length
  const key = (i: number, rank: number, flipped: boolean) =>
    i * width + 2 * rank + (flipped ? 1 : 0)
  const seeds = new Set<number>()
  query.forEach((handle, i) => {
    for (const rank of queryRepeat[i]
      ? []
      : (visits.get(nodeId(handle)) ?? [])) {
      seeds.add(key(i, rank, isReverse(handle) !== isReverse(target[rank]!)))
    }
  })
  const runs: Run[] = []
  query.forEach((handle, i) => {
    for (const rank of queryRepeat[i]
      ? []
      : (visits.get(nodeId(handle)) ?? [])) {
      const flipped = isReverse(handle) !== isReverse(target[rank]!)
      const step = flipped ? -1 : 1
      if (!seeds.has(key(i - 1, rank - step, flipped))) {
        let j = i
        let r = rank
        while (
          j < query.length &&
          r >= 0 &&
          r < target.length &&
          seeds.has(key(j, r, flipped))
        ) {
          j += 1
          r += step
        }
        const lastRank = r - step
        runs.push({
          qs: queryOffsets[i]!,
          qe: queryOffsets[j]!,
          ts: targetOffsets[Math.min(rank, lastRank)]!,
          te: targetOffsets[Math.max(rank, lastRank) + 1]!,
          flipped,
        })
      }
    }
  })
  return runs
}

// A query walk's alignments to a target walk. A stretch of nodes both walks
// visit is a run of `=`, a record is the best collinear chain of those
// stretches, and what lies between two of them is aligned base by base under
// vg's scoring, an inversion there coming back as a record of its own. A chain
// pays for the gap it spans, so by default nothing bounds how far it reaches
// but the window; maxGap caps that to bound the work. A record matching under
// minMatch bases is dropped. Coordinates count from each walk's first base; a
// `-` record's edits read along the target, the way minimap2 writes a
// reverse-strand row.
export function pairAlignments(
  query: number[],
  target: number[],
  sequenceOf: (id: number) => string,
  opts: PairOptions = {},
): PairChain[] {
  const a = walkSequence(query, sequenceOf)
  const b = walkSequence(target, sequenceOf)
  const runs = sharedRuns(
    query,
    target,
    walkOffsets(query, sequenceOf),
    walkOffsets(target, sequenceOf),
  )
  const minMatch = opts.minMatch ?? DEFAULT_MIN_MATCH
  const records: PairChain[] = []
  for (const chain of chainRuns(
    runs,
    opts.maxGap ?? Infinity,
    minMatch,
    stepJumpCost,
  )) {
    const edits: PairEdit[] = []
    const first = chain[0]!
    const last = chain.at(-1)!
    const { flipped } = first.run
    chainEdits(chain, a, b, edits, (qa, tb, into, queryFrom, targetFrom) => {
      for (const inversion of alignPrivate(qa, tb, into, minMatch)) {
        const targetTo = targetFrom + tb.length
        records.push({
          ...inversion,
          queryStart: queryFrom + inversion.queryStart,
          queryEnd: queryFrom + inversion.queryEnd,
          targetStart: flipped
            ? targetTo - inversion.targetEnd
            : targetFrom + inversion.targetStart,
          targetEnd: flipped
            ? targetTo - inversion.targetStart
            : targetFrom + inversion.targetEnd,
          strand: flipped ? '+' : '-',
          edits: flipped ? inversion.edits.reverse() : inversion.edits,
        })
      }
    })
    records.push({
      queryStart: first.run.qs + first.trim,
      queryEnd: last.run.qe,
      targetStart: flipped ? last.run.ts : first.run.ts + first.trim,
      targetEnd: flipped ? first.run.te - first.trim : last.run.te,
      strand: flipped ? '-' : '+',
      edits: flipped ? edits.reverse() : edits,
      sharedBases: chain.reduce(
        (sum, { run, trim }) => sum + run.qe - run.qs - trim,
        0,
      ),
    })
  }
  return records.sort((x, y) => x.queryStart - y.queryStart)
}

export function pairCigar(edits: PairEdit[]) {
  return edits.map(([op, len]) => `${len}${op}`).join('')
}
