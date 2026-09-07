import { readFileSync } from 'node:fs'
import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { encodeNode } from '../src/gbwt/node.ts'
import * as nodes from '../src/gbwt/node.ts'
import {
  subgraphAroundNodes,
  subgraphAtOffset,
  subgraphBetween,
  subgraphInInterval,
} from '../src/query.ts'

import type {
  CompactSubgraph,
  HaplotypeOutput,
  SnarlOutput,
  SubgraphJson,
} from '../src/subgraph.ts'

const dataDir = path.join(import.meta.dirname, 'data')
const oracleDir = path.join(dataDir, 'oracle')

interface OracleQuery {
  name: string
  db: string
  args: string[]
}

const queries: OracleQuery[] = readFileSync(
  path.join(oracleDir, 'queries.txt'),
  'utf8',
)
  .trim()
  .split('\n')
  .map(line => {
    const [name, db, args] = line.split('\t') as [string, string, string]
    return { name, db, args: args.split(' ') }
  })

function option(args: string[], flag: string) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

async function runQuery(query: OracleQuery) {
  const db = await GBZBase.open(new LocalFile(path.join(dataDir, query.db)))
  const context = Number(option(query.args, '--context') ?? 100)
  const haplotypes = (option(query.args, '--haplotypes') ??
    'all') as HaplotypeOutput
  const sample = option(query.args, '--sample')
  const contig = option(query.args, '--contig') ?? ''
  const cigar = query.args.includes('--cigar')
  const snarls: SnarlOutput = query.args.includes('--extend-snarls')
    ? 'overlapping'
    : query.args.includes('--snarls')
      ? 'contained'
      : 'none'
  const opts = { context, haplotypes, snarls }
  const pathQuery = { contig, ...(sample === undefined ? {} : { sample }) }
  const interval = option(query.args, '--interval')
  const offset = option(query.args, '--offset')
  const between = option(query.args, '--between')
  const nodes = query.args.flatMap((arg, i) =>
    arg === '--node' ? [Number(query.args[i + 1])] : [],
  )
  const subgraph = interval
    ? await subgraphInInterval(
        db,
        pathQuery,
        ...(interval.split('..').map(Number) as [number, number]),
        opts,
      )
    : offset
      ? await subgraphAtOffset(db, pathQuery, Number(offset), opts)
      : between
        ? await subgraphBetween(
            db,
            ...(between.split(':').map(parseHandle) as [number, number]),
            opts,
          )
        : await subgraphAroundNodes(db, nodes, opts)
  return {
    json: subgraph.toSubgraphJson({ cigar }),
    compact: subgraph.toCompactSubgraph({ cigar }),
    gfa: await subgraph.toGFA({ cigar }),
  }
}

// The upstream JSON rebuilt from the compact arrays. Holding this against
// toSubgraphJson on every oracle fixture is what keeps the two outputs from
// drifting apart once the compact one is the shape consumers depend on.
function jsonFromCompact(compact: CompactSubgraph): SubgraphJson {
  const step = (handle: number) => ({
    id: String(nodes.nodeId(handle)),
    is_reverse: nodes.isReverse(handle),
  })
  const edges: SubgraphJson['edges'] = []
  for (let i = 0; i < compact.edges.length; i += 2) {
    const from = step(compact.edges[i]!)
    const to = step(compact.edges[i + 1]!)
    edges.push({
      from: from.id,
      from_is_reverse: from.is_reverse,
      to: to.id,
      to_is_reverse: to.is_reverse,
    })
  }
  return {
    nodes: [...compact.nodeIds].map((id, i) => ({
      id: String(id),
      sequence: compact.nodeSequences[i]!,
    })),
    edges,
    paths: compact.paths.map(path => ({
      name: path.name,
      ...(path.weight === undefined ? {} : { weight: path.weight }),
      ...(path.cigar === undefined ? {} : { cigar: path.cigar }),
      path: [...path.steps].map(handle => step(handle)),
    })),
  }
}

function parseHandle(text: string) {
  return encodeNode(
    Number(text.slice(0, -1)),
    text.endsWith('-') ? 'reverse' : 'forward',
  )
}

describe('matches upstream gbz-base query output', () => {
  for (const query of queries) {
    it(query.name, async () => {
      const expectedJson = JSON.parse(
        readFileSync(path.join(oracleDir, `${query.name}.json`), 'utf8'),
      )
      const expectedGfa = readFileSync(
        path.join(oracleDir, `${query.name}.gfa`),
        'utf8',
      )
      const { json, compact, gfa } = await runQuery(query)
      expect(json).toEqual(expectedJson)
      expect(gfa).toBe(expectedGfa)
      expect(jsonFromCompact(compact)).toEqual(expectedJson)
    })
  }
})
