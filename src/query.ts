import { pathNameFor } from './pathName.ts'
import { Subgraph } from './subgraph.ts'

import type { GBZBase } from './db.ts'
import type { PathQuery } from './pathName.ts'
import type { HaplotypeOutput, SnarlOutput } from './subgraph.ts'

export type { PathQuery } from './pathName.ts'

export interface QueryOptions {
  context?: number | undefined
  haplotypes?: HaplotypeOutput | undefined
  snarls?: SnarlOutput | undefined
  limit?: number | undefined
  signal?: AbortSignal | undefined
}

export async function subgraphAtOffset(
  db: GBZBase,
  query: PathQuery,
  offset: number,
  opts: QueryOptions = {},
) {
  const subgraph = new Subgraph(db, opts)
  const reference = await subgraph.pathPosition(pathNameFor(query, offset))
  await subgraph.aroundPosition(
    reference.position.handle,
    reference.position.nodeOffset,
    opts.context ?? 100,
  )
  await subgraph.extractSnarls(opts.snarls ?? 'none')
  subgraph.extractPaths(reference, opts.haplotypes ?? 'all')
  return subgraph
}

export async function subgraphInInterval(
  db: GBZBase,
  query: PathQuery,
  start: number,
  end: number,
  opts: QueryOptions = {},
) {
  const subgraph = new Subgraph(db, opts)
  const reference = await subgraph.pathPosition(pathNameFor(query, start))
  await subgraph.prefetchReferenceWalk(reference, end - start)
  await subgraph.aroundInterval(
    reference.position,
    end - start,
    opts.context ?? 100,
  )
  await subgraph.extractSnarls(opts.snarls ?? 'none')
  subgraph.extractPaths(reference, opts.haplotypes ?? 'all')
  return subgraph
}

export async function subgraphAroundNodes(
  db: GBZBase,
  nodes: number[],
  opts: QueryOptions = {},
) {
  const haplotypes = opts.haplotypes ?? 'all'
  const snarls = opts.snarls ?? 'none'
  if (haplotypes === 'reference-only') {
    throw new Error('Cannot output a reference path in a node-based query')
  }
  if (snarls === 'overlapping' && nodes.length > 1) {
    throw new Error(
      'Overlapping snarls cannot be extracted for a node-based query with multiple nodes',
    )
  }
  const subgraph = new Subgraph(db, opts)
  await subgraph.aroundNodes(nodes, opts.context ?? 100)
  await subgraph.extractSnarls(snarls)
  subgraph.extractPaths(undefined, haplotypes)
  return subgraph
}

export async function subgraphBetween(
  db: GBZBase,
  start: number,
  end: number,
  opts: Pick<QueryOptions, 'haplotypes' | 'limit' | 'signal'> = {},
) {
  const haplotypes = opts.haplotypes ?? 'all'
  if (haplotypes === 'reference-only') {
    throw new Error('Cannot output a reference path in a node-based query')
  }
  const subgraph = new Subgraph(db, opts)
  await subgraph.betweenNodes(start, end)
  subgraph.extractPaths(undefined, haplotypes)
  return subgraph
}
