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
}

export interface PairOptions {
  maxGap?: number
}

interface Occurrence {
  rank: number
  reverse: boolean
}

const DEFAULT_MAX_GAP = 10000
const MAX_ALIGNED_CELLS = 4_000_000

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

// The private bases between two shared nodes. A pair of stretches too large to
// align is written as an insertion and a deletion, which claims no base of one
// matches any base of the other.
function alignPrivate(a: string, b: string, edits: PairEdit[]) {
  if (a.length * b.length <= MAX_ALIGNED_CELLS) {
    affineAlignment(a, b, edits)
  } else {
    appendEdit(edits, 'I', a.length)
    appendEdit(edits, 'D', b.length)
  }
}

function walkSequence(walk: number[], sequenceOf: (id: number) => string) {
  return walk
    .map(handle => {
      const sequence = sequenceOf(nodeId(handle))
      return isReverse(handle) ? reverseComplement(sequence) : sequence
    })
    .join('')
}

// A query walk's alignments to a target walk, read off the nodes both visit:
// a shared node is a run of `=`, and what lies between two shared nodes is
// aligned base by base under vg's scoring. A chain is a run of shared nodes whose target ranks
// move one way, up when the query crosses them in the target's orientation
// and down when flipped, skipping at most maxGap private bases on either walk.
// Coordinates count from each walk's first base; a `-` chain's edits read
// along the target, the way minimap2 writes a reverse-strand row.
export function pairAlignments(
  query: number[],
  target: number[],
  sequenceOf: (id: number) => string,
  opts: PairOptions = {},
): PairChain[] {
  const maxGap = opts.maxGap ?? DEFAULT_MAX_GAP
  const querySequence = walkSequence(query, sequenceOf)
  const targetSequence = walkSequence(target, sequenceOf)
  const targetOffsets: number[] = []
  const occurrences = new Map<number, Occurrence[]>()
  let offset = 0
  target.forEach((handle, rank) => {
    const id = nodeId(handle)
    targetOffsets.push(offset)
    offset += sequenceOf(id).length
    const seen = occurrences.get(id)
    const occurrence = { rank, reverse: isReverse(handle) }
    if (seen) {
      seen.push(occurrence)
    } else {
      occurrences.set(id, [occurrence])
    }
  })

  const chains: PairChain[] = []
  let open:
    | {
        flipped: boolean
        queryStart: number
        queryEnd: number
        targetFixed: number
        targetMoving: number
        last: number
        edits: PairEdit[]
      }
    | undefined
  const close = () => {
    if (open) {
      const { flipped, targetFixed, targetMoving, edits } = open
      chains.push({
        queryStart: open.queryStart,
        queryEnd: open.queryEnd,
        targetStart: flipped ? targetMoving : targetFixed,
        targetEnd: flipped ? targetFixed : targetMoving,
        strand: flipped ? '-' : '+',
        edits: flipped ? edits.reverse() : edits,
      })
      open = undefined
    }
  }

  let q = 0
  for (const handle of query) {
    const id = nodeId(handle)
    const len = sequenceOf(id).length
    const candidates = occurrences.get(id)
    if (candidates) {
      const reverse = isReverse(handle)
      let chosen: number | undefined
      if (open) {
        const { flipped, last } = open
        for (const c of candidates) {
          const ahead = flipped ? c.rank < last : c.rank > last
          const nearer =
            chosen === undefined ||
            (flipped ? c.rank > chosen : c.rank < chosen)
          if ((c.reverse !== reverse) === flipped && ahead && nearer) {
            chosen = c.rank
          }
        }
        if (chosen !== undefined) {
          const t = targetOffsets[chosen]!
          const queryGap = q - open.queryEnd
          const targetGap = flipped
            ? open.targetMoving - (t + len)
            : t - open.targetMoving
          if (queryGap <= maxGap && targetGap <= maxGap) {
            const a = querySequence.slice(open.queryEnd, q)
            const b = flipped
              ? reverseComplement(
                  targetSequence.slice(t + len, open.targetMoving),
                )
              : targetSequence.slice(open.targetMoving, t)
            alignPrivate(a, b, open.edits)
            appendEdit(open.edits, '=', len)
            open.last = chosen
            open.queryEnd = q + len
            open.targetMoving = flipped ? t : t + len
          } else {
            chosen = undefined
          }
        }
      }
      if (chosen === undefined) {
        close()
        const first = candidates[0]!
        const flipped = first.reverse !== reverse
        const t = targetOffsets[first.rank]!
        open = {
          flipped,
          queryStart: q,
          queryEnd: q + len,
          targetFixed: flipped ? t + len : t,
          targetMoving: flipped ? t : t + len,
          last: first.rank,
          edits: [['=', len]],
        }
      }
    }
    q += len
  }
  close()
  return chains
}

export function pairCigar(edits: PairEdit[]) {
  return edits.map(([op, len]) => `${len}${op}`).join('')
}
