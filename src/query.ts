import { GENERIC_SAMPLE } from './db.ts'
import { Subgraph } from './subgraph.ts'

import type { GBZBase, PathName } from './db.ts'
import type { HaplotypeOutput, SnarlOutput } from './subgraph.ts'

export interface QueryOptions {
  context?: number
  haplotypes?: HaplotypeOutput
  snarls?: SnarlOutput
  limit?: number
}

export interface PathQuery {
  sample?: string
  contig: string
  haplotype?: number
}

function pathName(query: PathQuery, fragment: number): PathName {
  return {
    sample: query.sample ?? GENERIC_SAMPLE,
    contig: query.contig,
    haplotype: query.haplotype ?? 0,
    fragment,
  }
}

export async function subgraphAtOffset(
  db: GBZBase,
  query: PathQuery,
  offset: number,
  opts: QueryOptions = {},
) {
  const subgraph = new Subgraph(db)
  subgraph.limit = opts.limit
  const reference = await subgraph.pathPosition(pathName(query, offset))
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
  const subgraph = new Subgraph(db)
  subgraph.limit = opts.limit
  const reference = await subgraph.pathPosition(pathName(query, start))
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
  const subgraph = new Subgraph(db)
  subgraph.limit = opts.limit
  await subgraph.aroundNodes(nodes, opts.context ?? 100)
  await subgraph.extractSnarls(snarls)
  subgraph.extractPaths(undefined, haplotypes)
  return subgraph
}

export async function subgraphBetween(
  db: GBZBase,
  start: number,
  end: number,
  opts: Pick<QueryOptions, 'haplotypes' | 'limit'> = {},
) {
  const haplotypes = opts.haplotypes ?? 'all'
  if (haplotypes === 'reference-only') {
    throw new Error('Cannot output a reference path in a node-based query')
  }
  const subgraph = new Subgraph(db)
  subgraph.limit = opts.limit
  await subgraph.betweenNodes(start, end)
  subgraph.extractPaths(undefined, haplotypes)
  return subgraph
}
