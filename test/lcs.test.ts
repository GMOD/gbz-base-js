import { describe, expect, it } from 'vitest'

import { weightedLcs } from '../src/lcs.ts'

function naive(a: number[], b: number[], weight: (x: number) => number) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const row = dp[i + 1] as number[]
      const prev = dp[i] as number[]
      row[j + 1] = Math.max(row[j] as number, prev[j + 1] as number)
      if (a[i] === b[j]) {
        row[j + 1] = Math.max(row[j + 1] as number, (prev[j] as number) + weight(a[i] as number))
      }
    }
  }
  return (dp[a.length] as number[])[b.length] as number
}

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
      const a = Array.from({ length: n }, () => 1 + Math.floor(rand() * alphabet))
      const b = Array.from({ length: m }, () => 1 + Math.floor(rand() * alphabet))
      const weight = (x: number) => 1 + (x % 3)
      const [pairs, total] = weightedLcs(a, b, weight)
      expect(total).toBe(naive(a, b, weight))
      let sum = 0
      let lastA = -1
      let lastB = -1
      for (const [i, j] of pairs) {
        expect(i).toBeGreaterThan(lastA)
        expect(j).toBeGreaterThan(lastB)
        expect(a[i]).toBe(b[j])
        sum += weight(a[i] as number)
        lastA = i
        lastB = j
      }
      expect(sum).toBe(total)
    }
  })
})
