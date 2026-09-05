interface Point {
  weight: number
  a: number
  b: number
  matches: number
}

function prefixSums(sequence: number[], weight: (x: number) => number) {
  const sums = [0]
  for (let i = 0; i < sequence.length; i++) {
    sums.push((sums[i] as number) + weight(sequence[i] as number))
  }
  return sums
}

class MinHeap {
  private items: number[] = []

  push(value: number) {
    const items = this.items
    items.push(value)
    let i = items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if ((items[parent] as number) <= value) {
        break
      }
      items[i] = items[parent] as number
      i = parent
    }
    items[i] = value
  }

  peek() {
    return this.items[0]
  }

  pop() {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (items.length > 0 && last !== undefined) {
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = left + 1
        let smallest = i
        let value = last
        if (left < items.length && (items[left] as number) < value) {
          smallest = left
          value = items[left] as number
        }
        if (right < items.length && (items[right] as number) < value) {
          smallest = right
        }
        if (smallest === i) {
          break
        }
        items[i] = items[smallest] as number
        i = smallest
      }
      items[i] = last
    }
    return top
  }
}

class Matrix {
  readonly aSums: number[]
  readonly bSums: number[]
  readonly points = new Map<number, Map<number, Point>>()
  private pendingEdits = new MinHeap()

  constructor(
    readonly a: number[],
    readonly b: number[],
    weight: (x: number) => number,
  ) {
    this.aSums = prefixSums(a, weight)
    this.bSums = prefixSums(b, weight)
    this.set(0, 0, { weight: 0, a: 0, b: 0, matches: 0 })
  }

  private set(edits: number, diagonal: number, point: Point) {
    let row = this.points.get(edits)
    if (!row) {
      row = new Map()
      this.points.set(edits, row)
      this.pendingEdits.push(edits)
    }
    row.set(diagonal, point)
  }

  get(edits: number, diagonal: number) {
    return this.points.get(edits)?.get(diagonal)
  }

  private tryInsert(edits: number, diagonal: number, point: Point) {
    const existing = this.get(edits, diagonal)
    if (!existing || point.weight > existing.weight) {
      this.set(edits, diagonal, point)
    }
  }

  aWeight(offset: number) {
    return (this.aSums[offset + 1] as number) - (this.aSums[offset] as number)
  }

  bWeight(offset: number) {
    return (this.bSums[offset + 1] as number) - (this.bSums[offset] as number)
  }

  extend(edits: number): Point | undefined {
    const row = this.points.get(edits)
    if (!row) {
      return undefined
    }
    const diagonals = [...row.keys()].sort((x, y) => x - y)
    for (const diagonal of diagonals) {
      const found = row.get(diagonal)
      if (!found) {
        continue
      }
      const point = { ...found }
      while (point.a < this.a.length && point.b < this.b.length && this.a[point.a] === this.b[point.b]) {
        point.weight += 2 * this.aWeight(point.a)
        point.a += 1
        point.b += 1
        point.matches += 1
      }
      if (point.matches > 0) {
        row.set(diagonal, point)
      }
      if (point.a === this.a.length && point.b === this.b.length) {
        return point
      }
      if (point.a < this.a.length) {
        const w = this.aWeight(point.a)
        this.tryInsert(edits + w, diagonal + w, { weight: point.weight, a: point.a + 1, b: point.b, matches: 0 })
      }
      if (point.b < this.b.length) {
        const w = this.bWeight(point.b)
        this.tryInsert(edits + w, diagonal - w, { weight: point.weight, a: point.a, b: point.b + 1, matches: 0 })
      }
    }
    return undefined
  }

  nextEdits(edits: number) {
    while (this.pendingEdits.peek() !== undefined && (this.pendingEdits.peek() as number) <= edits) {
      this.pendingEdits.pop()
    }
    return this.pendingEdits.peek()
  }

  predecessor(a: number, b: number, edits: number): [Point, number] | undefined {
    const diagonal = (this.aSums[a] as number) - (this.bSums[b] as number)
    const prev = a > 0 && this.aWeight(a - 1) <= edits ? this.get(edits - this.aWeight(a - 1), diagonal - this.aWeight(a - 1)) : undefined
    const next = b > 0 && this.bWeight(b - 1) <= edits ? this.get(edits - this.bWeight(b - 1), diagonal + this.bWeight(b - 1)) : undefined
    if (prev && next) {
      return prev.weight > next.weight ? [prev, edits - this.aWeight(a - 1)] : [next, edits - this.bWeight(b - 1)]
    }
    if (prev) {
      return [prev, edits - this.aWeight(a - 1)]
    }
    if (next) {
      return [next, edits - this.bWeight(b - 1)]
    }
    return undefined
  }
}

export function weightedLcs(a: number[], b: number[], weight: (x: number) => number): [pairs: [number, number][], weight: number] {
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix += 1
  }
  const pairs: [number, number][] = []
  let total = 0
  for (let i = 0; i < prefix; i++) {
    pairs.push([i, i])
    total += weight(a[i] as number)
  }
  const [middle, middleWeight] = weightedLcsCore(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), weight)
  for (const [i, j] of middle) {
    pairs.push([i + prefix, j + prefix])
  }
  total += middleWeight
  for (let i = suffix; i > 0; i--) {
    pairs.push([a.length - i, b.length - i])
    total += weight(a[a.length - i] as number)
  }
  return [pairs, total]
}

function weightedLcsCore(a: number[], b: number[], weight: (x: number) => number): [pairs: [number, number][], weight: number] {
  if (a.length === 0 || b.length === 0) {
    return [[], 0]
  }
  const matrix = new Matrix(a, b, weight)
  let edits = 0
  let point: Point = { weight: 0, a: 0, b: 0, matches: 0 }
  for (;;) {
    const end = matrix.extend(edits)
    if (end) {
      point = end
      break
    }
    const next = matrix.nextEdits(edits)
    if (next === undefined) {
      break
    }
    edits = next
  }
  const result: [number, number][] = []
  const finalWeight = point.weight / 2
  point = { ...point }
  for (;;) {
    for (let i = 0; i < point.matches; i++) {
      point.a -= 1
      point.b -= 1
      result.push([point.a, point.b])
    }
    const pred = matrix.predecessor(point.a, point.b, edits)
    if (!pred) {
      break
    }
    point = { ...pred[0] }
    edits = pred[1]
  }
  result.reverse()
  return [result, finalWeight]
}
