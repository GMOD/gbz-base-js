import { pathNameFor, toPathQuery } from './pathName.ts'
import { Subgraph, SubgraphLimitError } from './subgraph.ts'

import type { GBZBase } from './db.ts'
import type { PathName, PathRef } from './pathName.ts'
import type { HaplotypeOutput, SnarlOutput } from './subgraph.ts'

export interface QueryOptions {
  context?: number | undefined
  haplotypes?: HaplotypeOutput | undefined
  snarls?: SnarlOutput | undefined
  limit?: number | undefined
  signal?: AbortSignal | undefined
}

export interface PathWindow {
  path: PathRef
  start: number
  end: number
}

export interface IntervalQuery extends PathWindow, QueryOptions {
  keep?: ((name: PathName) => boolean) | undefined
}

export interface OffsetQuery extends QueryOptions {
  path: PathRef
  offset: number
}

export type NodeHaplotypeOutput = Exclude<HaplotypeOutput, 'reference-only'>

export interface NodesQuery extends Omit<QueryOptions, 'haplotypes'> {
  nodeIds: number[]
  haplotypes?: NodeHaplotypeOutput | undefined
}

export interface BetweenQuery {
  startHandle: number
  endHandle: number
  haplotypes?: NodeHaplotypeOutput | undefined
  limit?: number | undefined
  signal?: AbortSignal | undefined
}

export async function subgraphAtOffset(db: GBZBase, opts: OffsetQuery) {
  const subgraph = Subgraph.create(db, opts)
  const reference = await subgraph.pathPosition(
    pathNameFor(toPathQuery(opts.path), opts.offset),
  )
  await subgraph.aroundPosition(
    reference.position.handle,
    reference.position.nodeOffset,
    opts.context ?? 100,
  )
  await subgraph.extractSnarls(opts.snarls ?? 'none')
  subgraph.extractPaths(reference, opts.haplotypes ?? 'all')
  return subgraph
}

// The subgraph both routes read a window from: the reference walk through it,
// `context` bp around that, and the snarls `snarls` selects.
async function aroundWindow(db: GBZBase, opts: IntervalQuery) {
  const { start, end } = opts
  const subgraph = Subgraph.create(db, opts)
  try {
    const reference = await subgraph.pathPosition(
      pathNameFor(toPathQuery(opts.path), start),
    )
    await subgraph.prefetchReferenceWalk(reference, end - start)
    await subgraph.aroundInterval(
      reference.position,
      end - start,
      opts.context ?? 100,
    )
    await subgraph.extractSnarls(opts.snarls ?? 'none')
    return { subgraph, reference }
  } catch (error) {
    throw error instanceof SubgraphLimitError && error.windowBp === undefined
      ? new SubgraphLimitError(error.limit, {
          windowBp: end - start,
          walkedBp: subgraph.referenceWalkedBp ?? 0,
        })
      : error
  }
}

// With `keep`, the window for a chosen set of haplotypes: the same subgraph and
// the same walks as the sampled route narrowed by keepHaplotypes, found from
// the haplotype index without walking the haplotypes `keep` rejects, or by
// extracting and identifying every walk when the index cannot show those walks
// complete. 'distinct' merges the kept walks afterwards, so its weights count
// kept haplotypes.
export async function subgraphInInterval(db: GBZBase, opts: IntervalQuery) {
  const { keep } = opts
  const haplotypes = opts.haplotypes ?? 'all'
  const named = haplotypes === 'all' || haplotypes === 'distinct'
  if (keep !== undefined && named && !db.hasHaplotypeIndex) {
    throw new Error(
      'keep needs the haplotype index: this database cannot name its walks',
    )
  }
  const { subgraph, reference } = await aroundWindow(db, opts)
  if (keep === undefined || !named) {
    subgraph.extractPaths(reference, haplotypes)
    return subgraph
  }
  if (
    !(await subgraph.extractChosenPaths(
      reference,
      opts.end - opts.start,
      keep,
      opts.context ?? 100,
    ))
  ) {
    subgraph.extractPaths(reference, 'all')
    await subgraph.identifyPaths()
  }
  subgraph.keepHaplotypes(keep)
  if (haplotypes === 'distinct') {
    subgraph.mergeDistinct()
  }
  return subgraph
}

export async function subgraphAroundNodes(db: GBZBase, opts: NodesQuery) {
  const haplotypes = (opts.haplotypes ?? 'all') as HaplotypeOutput
  const snarls = opts.snarls ?? 'none'
  if (haplotypes === 'reference-only') {
    throw new Error('Cannot output a reference path in a node-based query')
  }
  if (snarls === 'overlapping' && new Set(opts.nodeIds).size > 1) {
    throw new Error(
      'Overlapping snarls cannot be extracted for a node-based query with multiple nodes',
    )
  }
  const subgraph = Subgraph.create(db, opts)
  await subgraph.aroundNodes(opts.nodeIds, opts.context ?? 100)
  await subgraph.extractSnarls(snarls)
  subgraph.extractPaths(undefined, haplotypes)
  return subgraph
}

export async function subgraphBetween(db: GBZBase, opts: BetweenQuery) {
  const haplotypes = (opts.haplotypes ?? 'all') as HaplotypeOutput
  if (haplotypes === 'reference-only') {
    throw new Error('Cannot output a reference path in a node-based query')
  }
  const subgraph = Subgraph.create(db, opts)
  await subgraph.betweenNodes(opts.startHandle, opts.endHandle)
  subgraph.extractPaths(undefined, haplotypes)
  return subgraph
}
