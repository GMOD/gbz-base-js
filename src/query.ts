import { pathNameFor } from './pathName.ts'
import { Subgraph, SubgraphLimitError } from './subgraph.ts'

import type { GBZBase } from './db.ts'
import type { PathName, PathQuery } from './pathName.ts'
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
  try {
    const reference = await subgraph.pathPosition(pathNameFor(query, start))
    await subgraph.prefetchReferenceWalk(reference, end - start)
    await subgraph.aroundInterval(
      reference.position,
      end - start,
      opts.context ?? 100,
    )
    await subgraph.extractSnarls(opts.snarls ?? 'none')
    subgraph.extractPaths(reference, opts.haplotypes ?? 'all')
  } catch (error) {
    throw error instanceof SubgraphLimitError && error.windowBp === undefined
      ? new SubgraphLimitError(error.limit, {
          windowBp: end - start,
          walkedBp: subgraph.referenceWalkedBp ?? 0,
        })
      : error
  }
  return subgraph
}

export interface HaplotypeQueryOptions extends QueryOptions {
  keep: (name: PathName) => boolean
}

// The window for a chosen set of haplotypes. With a companion that carries
// anchor rows the set's walks come from the anchor node before the window
// and nothing else is extracted or identified; without one, or when a wanted
// contig starts inside the window, it is the sampled route narrowed after
// identification, which is what a caller without `keep` gets.
export async function subgraphForHaplotypes(
  db: GBZBase,
  query: PathQuery,
  start: number,
  end: number,
  opts: HaplotypeQueryOptions,
) {
  if (!db.hasHaplotypeIndex) {
    throw new Error(
      'keep needs the haplotype index: this database cannot name its walks',
    )
  }
  const spacing = await db.haplotypeAnchorSpacing()
  let anchored: Subgraph | undefined
  let fallback: string | undefined
  if (spacing !== undefined && (opts.haplotypes ?? 'all') === 'all') {
    const subgraph = new Subgraph(db, opts)
    try {
      const reference = await subgraph.pathPosition(pathNameFor(query, start))
      fallback = await subgraph.walkHaplotypesFromAnchor(
        reference,
        end - start,
        spacing,
        opts.keep,
        opts.context ?? 100,
      )
    } catch (error) {
      throw error instanceof SubgraphLimitError && error.windowBp === undefined
        ? new SubgraphLimitError(error.limit, {
            windowBp: end - start,
            walkedBp: subgraph.referenceWalkedBp ?? 0,
          })
        : error
    }
    if (fallback === undefined) {
      anchored = subgraph
    } else {
      fallback = `${fallback}; identified from the per-path samples instead`
      const sampled = await subgraphInInterval(db, query, start, end, opts)
      await sampled.identifyPaths()
      sampled.keepHaplotypes(opts.keep)
      sampled.stats.anchorWalk = subgraph.stats.anchorWalk
      if (sampled.stats.anchorWalk) {
        sampled.stats.anchorWalk.fallback = fallback
      }
      anchored = sampled
    }
  } else {
    anchored = await subgraphInInterval(db, query, start, end, opts)
    await anchored.identifyPaths()
    anchored.keepHaplotypes(opts.keep)
  }
  return anchored
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
