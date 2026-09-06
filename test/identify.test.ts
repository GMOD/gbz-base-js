import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { ForwardOnlyIndexError, GBZBase } from '../src/db.ts'
import { ENDMARKER, encodeNode, flipNode } from '../src/gbwt/node.ts'
import { subgraphInInterval } from '../src/query.ts'

import type { Pos } from '../src/gbwt/record.ts'

const dataDir = path.join(import.meta.dirname, 'data')

async function walkBack(db: GBZBase, pos: Pos) {
  let current = pos
  let bpBefore = 0
  for (;;) {
    const flipped = await db.getRecord(flipNode(current.node))
    const predecessor = flipped?.gbwt().predecessorAt(current.offset)
    if (predecessor === undefined) {
      return { start: current, bpBefore }
    }
    const record = await db.getRecord(predecessor)
    const offset = record?.gbwt().offsetTo(current)
    if (!record || offset === undefined) {
      throw new Error(
        `No offset in ${predecessor} leads to ${current.node}:${current.offset}`,
      )
    }
    current = { node: predecessor, offset }
    bpBefore += record.sequenceLen
  }
}

function cigarConsumption(cigar: string) {
  let query = 0
  let reference = 0
  for (const [, len, op] of cigar.matchAll(/(\d+)([MID])/g)) {
    if (op !== 'D') {
      query += Number(len)
    }
    if (op !== 'I') {
      reference += Number(len)
    }
  }
  return { query, reference }
}

async function checkIdentities(
  file: string,
  sample: string | undefined,
  contig: string,
  start: number,
  end: number,
  context: number,
) {
  const db = await GBZBase.open(new LocalFile(path.join(dataDir, file)))
  const subgraph = await subgraphInInterval(
    db,
    { contig, ...(sample === undefined ? {} : { sample }) },
    start,
    end,
    { context },
  )
  await subgraph.identifyPaths()
  const alignments = subgraph.alignments()
  expect(alignments.length).toBeGreaterThan(0)
  for (const alignment of alignments) {
    expect(alignment.resolved).toBe(true)
    if (alignment.resolved) {
      const gbzPath = await db.getPath(alignment.pathHandle)
      expect(gbzPath).toBeDefined()
      const { start: seqStart, bpBefore } = await walkBack(db, alignment.start)
      expect(seqStart).toEqual(
        alignment.strand === '+' ? gbzPath?.fwStart : gbzPath?.revStart,
      )
      const length = (await db.haplotypeLength(alignment.pathHandle))!
      const local = {
        start: alignment.hapStart - gbzPath!.name.fragment,
        end: alignment.hapEnd - gbzPath!.name.fragment,
      }
      expect(alignment.strand === '+' ? local.start : length - local.end).toBe(
        bpBefore,
      )
      let pathLen = 0
      for (const handle of alignment.path) {
        pathLen += (await db.getRecord(handle))?.sequenceLen ?? 0
      }
      expect(local.end - local.start).toBeGreaterThanOrEqual(pathLen)
      const consumed = cigarConsumption(alignment.cigar)
      expect(local.end - local.start).toBe(consumed.query)
      expect(alignment.refEnd - alignment.refStart).toBe(consumed.reference)
      expect(alignment.refEnd).toBeGreaterThan(alignment.refStart)
      expect(
        alignment.cigar.startsWith('D') || /^\d+D/.test(alignment.cigar),
      ).toBe(false)
    }
  }
  return { subgraph, alignments }
}

describe('haplotype identification', () => {
  it('names every fragment in a context-free window', async () => {
    const { alignments } = await checkIdentities(
      'micb-kir3dl1.gbz.db',
      'GRCh38',
      'chr6',
      31500000,
      31501000,
      0,
    )
    const samples = new Set(
      alignments.flatMap(a =>
        a.resolved ? [`${a.name.sample}#${a.name.haplotype}`] : [],
      ),
    )
    expect(samples.size).toBeGreaterThan(50)
    expect(alignments.some(a => a.strand === '-')).toBe(true)
    expect(alignments.some(a => a.strand === '+')).toBe(true)
  })

  it('names every haplotype walk with context', async () => {
    const { alignments, subgraph } = await checkIdentities(
      'micb-kir3dl1.gbz.db',
      'GRCh38',
      'chr6',
      31500000,
      31501000,
      100,
    )
    expect(alignments.length).toBe(subgraph.pathCount - 1)
    const json = subgraph.toSubgraphJson({ cigar: true, names: 'resolved' })
    expect(json.paths.slice(1).every(p => !p.name.startsWith('unknown#'))).toBe(
      true,
    )
    expect(json.paths[1]?.name).toMatch(/^[A-Z0-9]+#[12]#\S+\[\d+-\d+\]$/)
  })

  it('works on the other reference and chromosome', async () => {
    await checkIdentities(
      'micb-kir3dl1.gbz.db',
      'CHM13',
      'chr6',
      31352000,
      31352500,
      20,
    )
    await checkIdentities(
      'micb-kir3dl1.gbz.db',
      'GRCh38',
      'chr19',
      54816500,
      54822000,
      0,
    )
  })

  it('accounts for every fragment in exactly one chain', async () => {
    const { subgraph } = await checkIdentities(
      'micb-kir3dl1.gbz.db',
      'GRCh38',
      'chr6',
      31500000,
      31501000,
      0,
    )
    const { chains, fragmentLengths, interval } = subgraph.stats.identification
    expect(interval).toBe(1000)
    expect(fragmentLengths.length).toBe(subgraph.pathCount - 1)
    expect(chains.reduce((n, c) => n + c.fragments, 0)).toBe(
      subgraph.pathCount - 1,
    )
    expect(chains.every(c => c.pathHandle !== undefined)).toBe(true)
    expect(chains.some(c => c.fragments > 1)).toBe(true)
    expect(
      chains
        .filter(c => c.end === 'in-fragment sample' && c.fragments === 1)
        .every(c => c.steps === 0),
    ).toBe(true)
    expect(chains.reduce((n, c) => n + c.steps, 0)).toBe(
      subgraph.stats.identificationSteps,
    )
  })

  it('works on the tiny example graph', async () => {
    await checkIdentities('example.gbz.db', undefined, 'A', 1, 4, 1)
    await checkIdentities('example-v3.gbz.db', undefined, 'B', 0, 3, 2)
  })
})

describe('companion haplotype index', () => {
  const graph = path.join(dataDir, 'micb-kir3dl1.gbz.db')
  const companion = path.join(dataDir, 'micb-kir3dl1.haplotype-index.db')

  async function alignmentsWith(db: GBZBase) {
    const subgraph = await subgraphInInterval(
      db,
      { sample: 'GRCh38', contig: 'chr6' },
      31500000,
      31501000,
      { context: 100 },
    )
    await subgraph.identifyPaths()
    return subgraph.alignments().map(a => ({ ...a, start: undefined }))
  }

  it('names haplotypes exactly as the embedded tables do', async () => {
    const embedded = await GBZBase.open(new LocalFile(graph))
    const withCompanion = await GBZBase.open(new LocalFile(graph), {
      haplotypeIndex: new LocalFile(companion),
    })
    expect(withCompanion.hasHaplotypeIndex).toBe(true)
    expect(await withCompanion.haplotypeSampleInterval()).toBe(1000)
    expect(await alignmentsWith(withCompanion)).toEqual(
      await alignmentsWith(embedded),
    )
  })

  it('rejects a companion built for a different graph', async () => {
    await expect(
      GBZBase.open(new LocalFile(path.join(dataDir, 'example.gbz.db')), {
        haplotypeIndex: new LocalFile(companion),
      }),
    ).rejects.toThrow(/built for 169 paths but the graph has 6/)
  })
})

async function forwardWalk(db: GBZBase, pathHandle: number) {
  const gbzPath = await db.getPath(pathHandle)
  const handles: number[] = []
  let pos = gbzPath?.fwStart
  while (pos && pos.node !== ENDMARKER) {
    handles.push(pos.node)
    const record = await db.getRecord(pos.node)
    pos = record?.gbwt().lf(pos.offset)
  }
  return handles
}

function isContiguousRun(walk: number[], steps: number[]) {
  return walk.some((_, at) => steps.every((step, k) => walk[at + k] === step))
}

function parseSteps(body: string) {
  return [...body.matchAll(/([<>])(\d+)/g)].map(m =>
    encodeNode(Number(m[2]), m[1] === '<' ? 'reverse' : 'forward'),
  )
}

describe('named walks in output', () => {
  it('list every resolved W line and JSON path in the haplotype direction', async () => {
    const db = await GBZBase.open(
      new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
    )
    const subgraph = await subgraphInInterval(
      db,
      { sample: 'GRCh38', contig: 'chr6' },
      31500000,
      31501000,
      { context: 100 },
    )
    await subgraph.identifyPaths()
    const handleOfWalk = new Map<string, number>()
    for (const alignment of subgraph.alignments()) {
      if (alignment.resolved) {
        handleOfWalk.set(alignment.label, alignment.pathHandle)
      }
    }
    expect(handleOfWalk.size).toBeGreaterThan(50)
    const walks = new Map<number, number[]>()
    const walkOf = async (pathHandle: number) => {
      const cached = walks.get(pathHandle)
      const walk = cached ?? (await forwardWalk(db, pathHandle))
      walks.set(pathHandle, walk)
      return walk
    }

    const gfa = await subgraph.toGFA({ names: 'resolved' })
    let checkedLines = 0
    for (const line of gfa.split('\n')) {
      const [tag, sample, haplotype, contig, start, end, body] =
        line.split('\t')
      if (tag === 'W' && sample !== 'GRCh38') {
        const pathHandle = handleOfWalk.get(
          `${sample}#${haplotype}#${contig}[${start}-${end}]`,
        )
        expect(pathHandle).toBeDefined()
        expect(
          isContiguousRun(await walkOf(pathHandle!), parseSteps(body!)),
        ).toBe(true)
        checkedLines += 1
      }
    }
    expect(checkedLines).toBe(handleOfWalk.size)

    const json = subgraph.toSubgraphJson({ names: 'resolved' })
    for (const jsonPath of json.paths.slice(1)) {
      const pathHandle = handleOfWalk.get(jsonPath.name)
      expect(pathHandle).toBeDefined()
      const steps = jsonPath.path.map(step =>
        encodeNode(Number(step.id), step.is_reverse ? 'reverse' : 'forward'),
      )
      expect(isContiguousRun(await walkOf(pathHandle!), steps)).toBe(true)
    }
  })
})

describe('a forward-only haplotype index', () => {
  it('is refused at open, since it cannot name walks stored against the reference', async () => {
    await expect(
      GBZBase.open(new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')), {
        haplotypeIndex: new LocalFile(
          path.join(dataDir, 'micb-kir3dl1.forward-only.haplotype-index.db'),
        ),
      }),
    ).rejects.toThrow(ForwardOnlyIndexError)
  })
})

describe('keepHaplotypes', () => {
  it('keeps the reference and the wanted walks with only the nodes they visit', async () => {
    const db = await GBZBase.open(
      new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
    )
    const subgraph = await subgraphInInterval(
      db,
      { sample: 'GRCh38', contig: 'chr6' },
      31500000,
      31501000,
      { context: 100 },
    )
    await subgraph.identifyPaths()
    const before = { nodes: subgraph.nodeCount, paths: subgraph.pathCount }
    subgraph.keepHaplotypes(name => name.sample === 'HG01106')
    expect(subgraph.pathCount).toBe(3)
    expect(subgraph.nodeCount).toBeLessThan(before.nodes)
    expect(subgraph.pathCount).toBeLessThan(before.paths)
    const walks = (await subgraph.toGFA({ names: 'resolved' }))
      .split('\n')
      .filter(line => line.startsWith('W\t'))
      .map(line => line.split('\t')[1])
    expect(walks).toEqual(['GRCh38', 'HG01106', 'HG01106'])
    const alignments = subgraph.alignments()
    expect(alignments.length).toBe(2)
    expect(
      alignments.every(a => a.resolved && a.name.sample === 'HG01106'),
    ).toBe(true)
  })
})
