import { describe, expect, it } from 'vitest'

import { weightedLcs } from '../src/lcs.ts'

function naive(a: number[], b: number[], weight: (x: number) => number) {
  const dp = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const row = dp[i + 1]!
      const prev = dp[i]!
      row[j + 1] = Math.max(row[j]!, prev[j + 1]!)
      if (a[i] === b[j]) {
        row[j + 1] = Math.max(row[j + 1]!, prev[j]! + weight(a[i]!))
      }
    }
  }
  return dp[a.length]![b.length]!
}

function looping(flank: number, segment: number, passes: number) {
  const ref = Array.from({ length: 2 * flank + segment }, (_, i) => i + 1)
  const copies = Array.from({ length: passes }, (_, k) => [
    ...ref.slice(flank, flank + segment),
    -2 - k,
  ])
  const path = [
    -1,
    ...ref.slice(0, flank),
    ...copies.flat(),
    ...ref.slice(flank + segment),
    -1000,
  ]
  return { ref, path }
}

function runStarts(pairs: [number, number][]) {
  return pairs.filter(
    ([i, j], k) =>
      k === 0 || i !== pairs[k - 1]![0] + 1 || j !== pairs[k - 1]![1] + 1,
  )
}

function expectChain(
  a: number[],
  b: number[],
  weight: (x: number) => number,
  [pairs, total]: [[number, number][], number],
) {
  let sum = 0
  let lastA = -1
  let lastB = -1
  for (const [i, j] of pairs) {
    expect(i).toBeGreaterThan(lastA)
    expect(j).toBeGreaterThan(lastB)
    expect(a[i]).toBe(b[j])
    sum += weight(a[i]!)
    lastA = i
    lastB = j
  }
  expect(sum).toBe(total)
}

const nodeLength = (x: number) => (x < 0 ? 500 : 5 + (x % 23))

function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

describe('weighted lcs', () => {
  it('handles empty and identical inputs', () => {
    expect(weightedLcs([], [1, 2], () => 1)).toEqual([[], 0])
    expect(weightedLcs([1, 2, 3], [1, 2, 3], x => x)).toEqual([
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
      6,
    ])
  })

  it('matches the documented example', () => {
    expect(weightedLcs([1, 2, 3, 4, 5], [2, 4, 6, 8, 10], () => 1)[0]).toEqual([
      [1, 0],
      [3, 1],
    ])
  })

  it('reaches the same weight as naive dynamic programming', () => {
    const rand = random(7)
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 12)
      const m = 1 + Math.floor(rand() * 12)
      const alphabet = 2 + Math.floor(rand() * 5)
      const a = Array.from(
        { length: n },
        () => 1 + Math.floor(rand() * alphabet),
      )
      const b = Array.from(
        { length: m },
        () => 1 + Math.floor(rand() * alphabet),
      )
      const weight = (x: number) => 1 + (x % 3)
      const result = weightedLcs(a, b, weight)
      expect(result[1]).toBe(naive(a, b, weight))
      expectChain(a, b, weight, result)
    }
  })

  it('matches a looped segment on its first pass and inserts the rest', () => {
    const { ref, path } = looping(5, 10, 3)
    const [pairs, total] = weightedLcs(path, ref, nodeLength)
    expect(total).toBe(naive(path, ref, nodeLength))
    expect(pairs).toHaveLength(ref.length)
    expect(runStarts(pairs)).toEqual([
      [1, 0],
      [39, 15],
    ])
  })

  it('aligns a walk looping thousands of steps in milliseconds', () => {
    const { ref, path } = looping(500, 500, 4)
    const start = performance.now()
    const [pairs, total] = weightedLcs(path, ref, nodeLength)
    expect(performance.now() - start).toBeLessThan(500)
    expect(total).toBe(naive(path, ref, nodeLength))
    expect(runStarts(pairs)).toEqual([
      [1, 0],
      [2505, 1000],
    ])
  })

  it('reaches the naive weight when both sequences loop the same nodes', () => {
    const segment = Array.from({ length: 10 }, (_, i) => 100 + i)
    const repeat = (passes: number, head: number[], tail: number[]) => [
      ...head,
      ...Array.from({ length: passes }, (_, k) => [...segment, 200 + k]).flat(),
      ...tail,
    ]
    const ref = repeat(30, [1, 2, 3], [4, 5])
    const path = repeat(40, [2, 1, 3], [5, 4])
    const result = weightedLcs(path, ref, nodeLength)
    expect(result[1]).toBe(naive(path, ref, nodeLength))
    expectChain(path, ref, nodeLength, result)
  })
})
