import { GENERIC_SAMPLE } from './db.ts'
import { Subgraph } from './subgraph.ts'

import type { GBZBase, PathName } from './db.ts'
import type { HaplotypeOutput } from './subgraph.ts'

export interface QueryOptions {
  context?: number
  haplotypes?: HaplotypeOutput
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
  subgraph.extractPaths(reference, opts.haplotypes ?? 'all')
  return subgraph
}

export async function subgraphAroundNodes(
  db: GBZBase,
  nodes: number[],
  opts: QueryOptions = {},
) {
  const haplotypes = opts.haplotypes ?? 'all'
  if (haplotypes === 'reference-only') {
    throw new Error('Cannot output a reference path in a node-based query')
  }
  const subgraph = new Subgraph(db)
  subgraph.limit = opts.limit
  await subgraph.aroundNodes(nodes, opts.context ?? 100)
  subgraph.extractPaths(undefined, haplotypes)
  return subgraph
}
