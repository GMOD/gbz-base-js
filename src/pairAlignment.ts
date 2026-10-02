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
  query: number[]
  target: number[]
  sequenceOf: (id: number) => string
  maxGap?: number | undefined
  minMatch?: number | undefined
  bases?: boolean | undefined
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
// each level's gaps lie strictly inside the last, so this only bounds the work
const MAX_FILL_DEPTH = 8

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

type Interval = [number, number]

// The stretch of a run from offset `from` to `to` along it
function sliceRun(run: Run, from: number, to: number): Run {
  return {
    qs: run.qs + from,
    qe: run.qs + to,
    ts: run.flipped ? run.te - to : run.ts + from,
    te: run.flipped ? run.te - from : run.ts + to,
    flipped: run.flipped,
  }
}

// What is left of a run once taken bases are cut out of it, as the pieces a
// k-mer long or more. An exact match divides at any base, so a flank that runs
// one base into an inversion by chance costs the inversion one base, not all
// of it.
function untakenPieces(run: Run, query: Interval[], target: Interval[]) {
  const len = run.qe - run.qs
  const blocked: Interval[] = []
  for (const [s, e] of query) {
    const lo = Math.max(0, s - run.qs)
    const hi = Math.min(len, e - run.qs)
    if (lo < hi) {
      blocked.push([lo, hi])
    }
  }
  for (const [s, e] of target) {
    const lo = Math.max(0, run.flipped ? run.te - e : s - run.ts)
    const hi = Math.min(len, run.flipped ? run.te - s : e - run.ts)
    if (lo < hi) {
      blocked.push([lo, hi])
    }
  }
  if (blocked.length === 0) {
    return [run]
  }
  blocked.sort((x, y) => x[0] - y[0])
  const pieces: Run[] = []
  let from = 0
  for (const [lo, hi] of blocked) {
    if (lo - from >= KMER) {
      pieces.push(sliceRun(run, from, lo))
    }
    from = Math.max(from, hi)
  }
  if (len - from >= KMER) {
    pieces.push(sliceRun(run, from, len))
  }
  return pieces
}

// The best-scoring collinear chain of runs matching minMatch bases or more,
// then the best over the runs that overlap no accepted run on either sequence,
// and so on: a second copy of a repeat finds its target taken and an inversion
// finds its target free. A run that overlaps its predecessor is trimmed from
// the front, which an exact match allows at any base.
function chainRuns(
  runs: Run[],
  maxGap: number,
  minMatch: number,
  jumpCost: JumpCost,
  maxChains = Infinity,
) {
  const chains: Link[][] = []
  const basesTaken = { query: [] as Interval[], target: [] as Interval[] }
  const spanTaken = {
    forward: { query: [] as Interval[], target: [] as Interval[] },
    flipped: { query: [] as Interval[], target: [] as Interval[] },
  }
  let pool = [...runs].sort((a, b) => a.qs - b.qs || a.ts - b.ts)
  while (pool.length > 0 && chains.length < maxChains) {
    const score = pool.map(run => run.qe - run.qs)
    const back = new Int32Array(pool.length).fill(-1)
    const trims = new Int32Array(pool.length)
    for (let j = 0; j < pool.length; j++) {
      const b = pool[j]!
      const len = b.qe - b.qs
      for (let i = j - 1; i >= Math.max(0, j - CHAIN_LOOKBACK); i--) {
        if (score[i]! + len <= score[j]!) {
          continue
        }
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
    const matched = new Int32Array(pool.length)
    let end = -1
    for (let j = 0; j < pool.length; j++) {
      const run = pool[j]!
      matched[j] = (matched[back[j]!] ?? 0) + run.qe - run.qs - trims[j]!
      if (matched[j]! >= minMatch && (end < 0 || score[j]! > score[end]!)) {
        end = j
      }
    }
    if (end < 0) {
      break
    }
    const chain: Link[] = []
    for (let j = end; j >= 0; j = back[j]!) {
      chain.push({ run: pool[j]!, trim: trims[j]! })
    }
    chain.reverse()
    chains.push(chain)
    // A record's CIGAR accounts for every base between its ends in its own
    // orientation, so a later chain of that orientation may not nest in its
    // gaps: taking only the runs let one re-claim an earlier record's bases on
    // a paralog. An inversion is what a forward CIGAR cannot account for, so
    // across orientations only the bases themselves are taken.
    const first = chain[0]!
    const last = chain.at(-1)!
    const { flipped } = first.run
    const spans = flipped ? spanTaken.flipped : spanTaken.forward
    spans.query.push([first.run.qs + first.trim, last.run.qe])
    spans.target.push(
      flipped
        ? [last.run.ts, first.run.te - first.trim]
        : [first.run.ts + first.trim, last.run.te],
    )
    for (const { run, trim } of chain) {
      basesTaken.query.push([run.qs + trim, run.qe])
      basesTaken.target.push(
        run.flipped ? [run.ts, run.te - trim] : [run.ts + trim, run.te],
      )
    }
    pool = pool
      .flatMap(run => {
        const same = run.flipped ? spanTaken.flipped : spanTaken.forward
        return untakenPieces(
          run,
          [...basesTaken.query, ...same.query],
          [...basesTaken.target, ...same.target],
        )
      })
      .sort((x, y) => x.qs - y.qs || x.ts - y.ts)
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

type GapFill = (
  a: string,
  b: string,
  edits: PairEdit[],
  queryFrom: number,
  targetFrom: number,
) => void

// The edits of one chain: each run is a run of `=`, and what lies between two
// runs goes to `between`. Edits read along the query; the caller reverses a
// flipped chain's so they read along the target.
function chainEdits(
  chain: Link[],
  a: string,
  b: string,
  edits: PairEdit[],
  between: GapFill,
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

// An insertion and a deletion, which claims no homology
function unaligned(a: string, b: string, edits: PairEdit[]) {
  appendEdit(edits, 'I', a.length)
  appendEdit(edits, 'D', b.length)
}

function alignExact(a: string, b: string, edits: PairEdit[]) {
  if (a.length * b.length <= MAX_ALIGNED_CELLS) {
    affineAlignment(a, b, edits)
  } else {
    unaligned(a, b, edits)
  }
}

// The private bases between two runs of one chain, whose orientation the chain
// has already fixed. Past the cell budget they are seeded on forward k-mers and
// chained again, recursing into the gaps that chain leaves. It finds no
// inversions, since the stretch has an orientation already.
function fillGap(a: string, b: string, edits: PairEdit[], depth = 0) {
  const [chain] =
    a.length * b.length > MAX_ALIGNED_CELLS && depth < MAX_FILL_DEPTH
      ? chainRuns(forwardKmerRuns(a, b), Infinity, KMER, kmerJumpCost, 1)
      : []
  if (!chain) {
    alignExact(a, b, edits)
    return
  }
  const deeper = (qa: string, tb: string, into: PairEdit[]) => {
    fillGap(qa, tb, into, depth + 1)
  }
  const first = chain[0]!.run
  const last = chain.at(-1)!.run
  deeper(a.slice(0, first.qs), b.slice(0, first.ts), edits)
  chainEdits(chain, a, b, edits, deeper)
  deeper(a.slice(last.qe), b.slice(last.te), edits)
}

function fill(a: string, b: string, edits: PairEdit[]) {
  fillGap(a, b, edits)
}

// A chain as a record in the coordinates of the two strings it was made on
function recordOf(chain: Link[], a: string, b: string): PairChain {
  const edits: PairEdit[] = []
  chainEdits(chain, a, b, edits, fill)
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
      // The forward record holds no inversion, so an inversion's bases stay
      // unaligned in it. A gap that hides one is not seeded again: at a tandem
      // array that finds only a neighbouring copy, matched forward over bases
      // the inversion's own record already claims.
      const forwardFill: GapFill = (qa, tb, into, queryFrom, targetFrom) => {
        const hidesInversion = inversions.some(
          inversion =>
            (queryFrom < inversion.queryEnd &&
              inversion.queryStart < queryFrom + qa.length) ||
            (targetFrom < inversion.targetEnd &&
              inversion.targetStart < targetFrom + tb.length),
        )
        if (hidesInversion) {
          alignExact(qa, tb, into)
        } else {
          fillGap(qa, tb, into)
        }
      }
      const first = forward[0]!.run
      const last = forward.at(-1)!.run
      forwardFill(a.slice(0, first.qs), b.slice(0, first.ts), edits, 0, 0)
      chainEdits(forward, a, b, edits, forwardFill)
      forwardFill(a.slice(last.qe), b.slice(last.te), edits, last.qe, last.te)
    } else {
      unaligned(a, b, edits)
    }
  }
  return inversions
}

interface Claimed extends PairChain {
  // query stretches on nodes both walks visit
  shared: Interval[]
}

type Side = 'query' | 'target'

// Each edit of a record with the query and target position it sits at. A `-`
// record's edits read along the target, so its query runs down from queryEnd.
function forEachEdit(
  r: PairChain,
  visit: (op: PairOp, len: number, query: number, target: number) => void,
) {
  const flipped = r.strand === '-'
  let qi = 0
  let ti = 0
  for (const [op, len] of r.edits) {
    visit(
      op,
      len,
      flipped ? r.queryEnd - 1 - qi : r.queryStart + qi,
      r.targetStart + ti,
    )
    if (op !== 'D') {
      qi += len
    }
    if (op !== 'I') {
      ti += len
    }
  }
}

// A record's score under vg's model over [lo, hi) on one side: a column counts
// where its base on that side does, and a gap where it opens on that side.
function scoreOver(r: PairChain, side: Side, lo: number, hi: number) {
  const step = side === 'query' && r.strand === '-' ? -1 : 1
  let score = 0
  forEachEdit(r, (op, len, query, target) => {
    const from = side === 'query' ? query : target
    const inside = (k: number) => {
      const at = from + step * k
      return at >= lo && at < hi
    }
    if (op === '=' || op === 'X') {
      for (let k = 0; k < len; k++) {
        if (inside(k)) {
          score += op === '=' ? MATCH : MISMATCH
        }
      }
    } else if ((op === 'I') === (side === 'query')) {
      for (let k = 0; k < len; k++) {
        if (inside(k)) {
          score += k === 0 ? GAP_OPEN : GAP_EXTEND
        }
      }
    } else if (inside(0)) {
      score += GAP_OPEN + (len - 1) * GAP_EXTEND
    }
  })
  return score
}

function spanOf(r: PairChain, side: Side): Interval {
  return side === 'query'
    ? [r.queryStart, r.queryEnd]
    : [r.targetStart, r.targetEnd]
}

// A record's edits with the aligned columns `lost` marks turned into an
// insertion and a deletion, and its ends trimmed to the columns it keeps.
function withoutColumns(r: Claimed, lost: Uint8Array): Claimed | undefined {
  const flipped = r.strand === '-'
  const edits: PairEdit[] = []
  let pendingQuery = 0
  let pendingTarget = 0
  let column = 0
  let sharedLost = 0
  const sharedMask = new Uint8Array(r.queryEnd - r.queryStart)
  for (const [s, e] of r.shared) {
    sharedMask.fill(1, s - r.queryStart, e - r.queryStart)
  }
  const inShared = (at: number) => sharedMask[at - r.queryStart] === 1
  const flush = () => {
    appendEdit(edits, 'I', pendingQuery)
    appendEdit(edits, 'D', pendingTarget)
    pendingQuery = 0
    pendingTarget = 0
  }
  forEachEdit(r, (op, len, query) => {
    if (op === 'I') {
      pendingQuery += len
    } else if (op === 'D') {
      pendingTarget += len
    } else {
      for (let k = 0; k < len; k++) {
        if (lost[column + k]) {
          pendingQuery += 1
          pendingTarget += 1
          if (inShared(flipped ? query - k : query + k)) {
            sharedLost += 1
          }
        } else {
          if (pendingQuery > 0 || pendingTarget > 0) {
            flush()
          }
          appendEdit(edits, op, 1)
        }
      }
      column += len
    }
  })
  flush()
  const lead = { I: 0, D: 0 }
  while (edits[0]?.[0] === 'I' || edits[0]?.[0] === 'D') {
    const [op, len] = edits.shift()!
    lead[op as 'I' | 'D'] += len
  }
  const tail = { I: 0, D: 0 }
  while (edits.at(-1)?.[0] === 'I' || edits.at(-1)?.[0] === 'D') {
    const [op, len] = edits.pop()!
    tail[op as 'I' | 'D'] += len
  }
  return edits.length === 0
    ? undefined
    : {
        ...r,
        queryStart: r.queryStart + (flipped ? tail.I : lead.I),
        queryEnd: r.queryEnd - (flipped ? lead.I : tail.I),
        targetStart: r.targetStart + lead.D,
        targetEnd: r.targetEnd - tail.D,
        edits,
        sharedBases: r.sharedBases - sharedLost,
      }
}

// A base aligns in one record at most. Where two records align the same bases
// on either walk, the one scoring higher over the stretch their spans share
// keeps them, and the other gives them up as an insertion and a deletion. In a
// tandem array whose copies run both ways, one query copy aligns forward to one
// target copy and inverted to another, and both are homology; the scoring
// decides which one the pair's picture shows. A tie goes to the record with
// more bases on shared nodes: alignPrivate finds an inversion a walk takes
// through shared nodes again, base for base, in the gap of the forward record
// spanning it.
function claimOnce(
  records: Claimed[],
  queryLength: number,
  targetLength: number,
  minMatch: number,
) {
  const claims = {
    query: new Uint8Array(queryLength),
    target: new Uint8Array(targetLength),
  }
  const columnsOf = records.map(r => {
    const columns: [number, number][] = []
    forEachEdit(r, (op, len, query, target) => {
      if (op === '=' || op === 'X') {
        for (let k = 0; k < len; k++) {
          columns.push([r.strand === '-' ? query - k : query + k, target + k])
        }
      }
    })
    for (const [query, target] of columns) {
      claims.query[query] = Math.min(255, claims.query[query]! + 1)
      claims.target[target] = Math.min(255, claims.target[target]! + 1)
    }
    return columns
  })
  const holders = {
    query: new Map<number, number[]>(),
    target: new Map<number, number[]>(),
  }
  columnsOf.forEach((columns, i) => {
    for (const [query, target] of columns) {
      for (const [side, at] of [
        ['query', query],
        ['target', target],
      ] as const) {
        if (claims[side][at]! > 1) {
          const held = holders[side].get(at)
          if (!held) {
            holders[side].set(at, [i])
          } else if (held.at(-1) !== i) {
            held.push(i)
          }
        }
      }
    }
  })
  const beaten = new Map<string, boolean>()
  const losesTo = (i: number, j: number, side: Side) => {
    const key = `${side}:${i}:${j}`
    let loses = beaten.get(key)
    if (loses === undefined) {
      const [si, ei] = spanOf(records[i]!, side)
      const [sj, ej] = spanOf(records[j]!, side)
      const lo = Math.max(si, sj)
      const hi = Math.min(ei, ej)
      const [mine, theirs] = [records[i]!, records[j]!]
      const margins = [
        scoreOver(theirs, side, lo, hi) - scoreOver(mine, side, lo, hi),
        theirs.sharedBases - mine.sharedBases,
        i - j,
      ]
      loses = margins.find(margin => margin !== 0)! > 0
      beaten.set(key, loses)
    }
    return loses
  }
  return records.flatMap((r, i) => {
    const columns = columnsOf[i]!
    const lost = new Uint8Array(columns.length)
    columns.forEach(([query, target], c) => {
      for (const [side, at] of [
        ['query', query],
        ['target', target],
      ] as const) {
        if (
          !lost[c] &&
          holders[side].get(at)?.some(j => j !== i && losesTo(i, j, side))
        ) {
          lost[c] = 1
        }
      }
    })
    if (!lost.includes(1)) {
      return [r]
    }
    const kept = withoutColumns(r, lost)
    const matched =
      kept?.edits.reduce((sum, [op, len]) => sum + (op === '=' ? len : 0), 0) ??
      0
    return kept && matched >= minMatch ? [kept] : []
  })
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
      const previous = rank - step
      const continues =
        i > 0 &&
        previous >= 0 &&
        previous < target.length &&
        seeds.has(key(i - 1, previous, flipped))
      if (!continues) {
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
// vg's scoring, an inversion there coming back as a record of its own. With
// bases false it is an insertion and a deletion instead. A chain pays for the
// gap it spans, so by default nothing bounds how far it reaches but the window;
// maxGap caps that to bound the work. A record matching under minMatch bases is
// dropped. Coordinates count from each walk's first base; a `-` record's edits
// read along the target, the way minimap2 writes a reverse-strand row.
export function pairAlignments(opts: PairOptions): PairChain[] {
  const { query, target, sequenceOf } = opts
  const a = walkSequence(query, sequenceOf)
  const b = walkSequence(target, sequenceOf)
  const runs = sharedRuns(
    query,
    target,
    walkOffsets(query, sequenceOf),
    walkOffsets(target, sequenceOf),
  )
  const minMatch = opts.minMatch ?? DEFAULT_MIN_MATCH
  const bases = opts.bases ?? true
  const records: Claimed[] = []
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
    const alignBetween: GapFill = (qa, tb, into, queryFrom, targetFrom) => {
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
          shared: [],
        })
      }
    }
    chainEdits(chain, a, b, edits, bases ? alignBetween : unaligned)
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
      shared: chain.map(({ run, trim }) => [run.qs + trim, run.qe]),
    })
  }
  return claimOnce(records, a.length, b.length, minMatch)
    .map(({ shared: _, ...record }) => record)
    .sort((x, y) => x.queryStart - y.queryStart)
}

export function pairCigar(edits: PairEdit[]) {
  return edits.map(([op, len]) => `${len}${op}`).join('')
}
