import { expect, it } from 'vitest'

import {
  encodeNode,
  pairAlignments,
  pairCigar,
  weightedLcs,
} from '../src/index.ts'

const lengths: Record<number, number> = { 1: 200, 2: 1, 3: 1, 4: 300, 5: 40 }
const sequenceOf = (id: number) => 'N'.repeat(lengths[id]!)
const walk = (ids: number[]) => ids.map(id => encodeNode(id, 'forward'))

it('aligns two walks on the nodes they share, from node lengths alone', () => {
  const chains = pairAlignments({
    query: walk([1, 3, 5, 4]),
    target: walk([1, 2, 4]),
    sequenceOf,
    bases: false,
  })
  expect(chains).toHaveLength(1)
  const [chain] = chains
  expect(chain).toMatchObject({
    queryStart: 0,
    queryEnd: 541,
    targetStart: 0,
    targetEnd: 501,
    strand: '+',
    sharedBases: 500,
  })
  expect(pairCigar(chain!.edits)).toBe('200=41I1D300=')
})

it('matches a walk that repeats a node against one that passes it once', () => {
  const [pairs, weight] = weightedLcs(
    walk([1, 4, 5, 4, 2]),
    walk([1, 4, 2]),
    handle => lengths[handle / 2]!,
  )
  expect(pairs.map(([, b]) => b)).toEqual([0, 1, 2])
  expect(weight).toBe(501)
})
