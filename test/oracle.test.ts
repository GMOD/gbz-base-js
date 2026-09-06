import { readFileSync } from 'node:fs'
import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import {
  subgraphAroundNodes,
  subgraphAtOffset,
  subgraphInInterval,
} from '../src/query.ts'

import type { HaplotypeOutput } from '../src/subgraph.ts'

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
  const opts = { context, haplotypes }
  const pathQuery = { contig, ...(sample === undefined ? {} : { sample }) }
  const interval = option(query.args, '--interval')
  const offset = option(query.args, '--offset')
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
      : await subgraphAroundNodes(db, nodes, opts)
  return subgraph.toJSON(cigar)
}

describe('matches upstream gbz-base query output', () => {
  for (const query of queries) {
    it(query.name, async () => {
      const expected = JSON.parse(
        readFileSync(path.join(oracleDir, `${query.name}.json`), 'utf8'),
      )
      expect(await runQuery(query)).toEqual(expected)
    })
  }
})
