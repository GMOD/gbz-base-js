type Weight = (x: number) => number

function lowerBound(ascending: number[], value: number) {
  let lo = 0
  let hi = ascending.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ascending[mid]! < value) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

class ColumnMax {
  readonly ending: Float64Array
  private readonly tree: Int32Array

  constructor(columns: number) {
    this.ending = new Float64Array(columns)
    this.tree = new Int32Array(columns + 1).fill(-1)
  }

  bestBefore(column: number) {
    let best = -1
    for (let p = column; p > 0; p -= p & -p) {
      const candidate = this.tree[p]!
      if (
        candidate !== -1 &&
        (best === -1 || this.ending[candidate]! > this.ending[best]!)
      ) {
        best = candidate
      }
    }
    return best
  }

  raise(column: number, value: number) {
    this.ending[column] = value
    for (let p = column + 1; p < this.tree.length; p += p & -p) {
      const holder = this.tree[p]!
      if (holder === -1 || value > this.ending[holder]!) {
        this.tree[p] = column
      }
    }
  }
}

interface Trace {
  row: Int32Array
  column: Int32Array
  previous: Int32Array
  endingMatch: Int32Array
  count: number
}

class SparseLcs {
  readonly pairs: [number, number][] = []
  total = 0
  private readonly a: number[]
  private readonly weight: Weight
  private readonly occurrences = new Map<number, number[]>()

  constructor(a: number[], b: number[], weight: Weight) {
    this.a = a
    this.weight = weight
    b.forEach((x, j) => {
      const list = this.occurrences.get(x)
      if (list) {
        list.push(j)
      } else {
        this.occurrences.set(x, [j])
      }
    })
  }

  solve(a0: number, a1: number, b0: number, b1: number) {
    if (a0 === a1 || b0 === b1) {
      return
    }
    const matches = this.matchCount(a0, a1, b0, b1)
    if (matches === 0) {
      return
    }
    if (matches <= a1 - a0 + (b1 - b0)) {
      this.chain(a0, a1, b0, b1, matches)
      return
    }
    const mid = (a0 + a1) >> 1
    const split = this.split(a0, mid, a1, b0, b1)
    this.solve(a0, mid, b0, split)
    this.solve(mid, a1, split, b1)
  }

  private matchCount(a0: number, a1: number, b0: number, b1: number) {
    let count = 0
    for (let i = a0; i < a1; i++) {
      const list = this.occurrences.get(this.a[i]!)
      if (list) {
        count += lowerBound(list, b1) - lowerBound(list, b0)
      }
    }
    return count
  }

  private sweep(
    from: number,
    to: number,
    step: 1 | -1,
    b0: number,
    b1: number,
    columns: ColumnMax,
    trace?: Trace,
  ) {
    for (let i = from; i !== to; i += step) {
      const list = this.occurrences.get(this.a[i]!)
      if (!list) {
        continue
      }
      const w = this.weight(this.a[i]!)
      const lo = lowerBound(list, b0)
      const hi = lowerBound(list, b1)
      for (let k = 0; k < hi - lo; k++) {
        const column =
          step === 1 ? list[hi - 1 - k]! - b0 : b1 - 1 - list[lo + k]!
        const before = columns.bestBefore(column)
        const value = (before === -1 ? 0 : columns.ending[before]!) + w
        if (value > columns.ending[column]!) {
          columns.raise(column, value)
          if (trace) {
            const match = trace.count++
            trace.row[match] = i
            trace.column[match] = column
            trace.previous[match] =
              before === -1 ? -1 : trace.endingMatch[before]!
            trace.endingMatch[column] = match
          }
        }
      }
    }
  }

  private chain(
    a0: number,
    a1: number,
    b0: number,
    b1: number,
    matches: number,
  ) {
    const columns = new ColumnMax(b1 - b0)
    const trace: Trace = {
      row: new Int32Array(matches),
      column: new Int32Array(matches),
      previous: new Int32Array(matches),
      endingMatch: new Int32Array(b1 - b0),
      count: 0,
    }
    this.sweep(a0, a1, 1, b0, b1, columns, trace)
    const last = columns.bestBefore(b1 - b0)
    if (last === -1) {
      return
    }
    this.total += columns.ending[last]!
    const chained: [number, number][] = []
    for (
      let match = trace.endingMatch[last]!;
      match !== -1;
      match = trace.previous[match]!
    ) {
      chained.push([trace.row[match]!, b0 + trace.column[match]!])
    }
    for (let k = chained.length - 1; k >= 0; k--) {
      this.pairs.push(chained[k]!)
    }
  }

  private frontier(
    from: number,
    to: number,
    step: 1 | -1,
    b0: number,
    b1: number,
  ) {
    const columns = new ColumnMax(b1 - b0)
    this.sweep(from, to, step, b0, b1, columns)
    const best = new Float64Array(b1 - b0 + 1)
    for (let column = 0; column < b1 - b0; column++) {
      best[column + 1] = Math.max(best[column]!, columns.ending[column]!)
    }
    return best
  }

  private split(a0: number, mid: number, a1: number, b0: number, b1: number) {
    const width = b1 - b0
    const before = this.frontier(a0, mid, 1, b0, b1)
    const after = this.frontier(a1 - 1, mid - 1, -1, b0, b1)
    let split = 0
    let best = -1
    for (let s = 0; s <= width; s++) {
      const combined = before[s]! + after[width - s]!
      if (combined > best) {
        best = combined
        split = s
      }
    }
    return b0 + split
  }
}

export function weightedLcs(
  a: number[],
  b: number[],
  weight: Weight,
): [pairs: [number, number][], weight: number] {
  const lcs = new SparseLcs(a, b, weight)
  lcs.solve(0, a.length, 0, b.length)
  return [lcs.pairs, lcs.total]
}
