import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it, vi } from 'vitest'

import { main } from '../src/cli.ts'
import { GBZBase } from '../src/db.ts'
import { encodeNode } from '../src/gbwt/node.ts'
import { reverseComplement } from '../src/gbwt/sequence.ts'
import { pairAlignments, pairCigar } from '../src/pairAlignment.ts'
import { subgraphInInterval } from '../src/query.ts'

const dataDir = path.join(import.meta.dirname, 'data')

const SEQUENCES: Record<number, string> = {
  1: 'ACGTACGTAC',
  2: 'ACGATGCA',
  3: 'CCCCCCCCCC',
  4: 'ACGTTGCA',
  5: 'T'.repeat(24),
  6: 'CA'.repeat(15),
  7: 'GATTACAGAT'.repeat(4),
  8: 'TTGACCAGTA'.repeat(4),
}
const sequenceOf = (id: number) => SEQUENCES[id]!
const forward = (...ids: number[]) => ids.map(id => encodeNode(id, 'forward'))
const flipped = (...ids: number[]) => ids.map(id => encodeNode(id, 'reverse'))

describe('pairAlignments', () => {
  it('aligns the private stretch between two shared nodes base by base', () => {
    const [chain] = pairAlignments(
      forward(1, 4, 3),
      forward(1, 2, 3),
      sequenceOf,
      { minMatch: 1 },
    )
    expect(chain).toMatchObject({
      queryStart: 0,
      queryEnd: 28,
      targetStart: 0,
      targetEnd: 28,
      strand: '+',
    })
    expect(pairCigar(chain!.edits)).toBe('13=1X14=')
  })

  it('writes a flipped walk as a - record whose edits read along the target', () => {
    const [chain] = pairAlignments(
      flipped(3, 4, 1),
      forward(1, 2, 3),
      sequenceOf,
      { minMatch: 1 },
    )
    expect(chain).toMatchObject({
      queryStart: 0,
      queryEnd: 28,
      targetStart: 0,
      targetEnd: 28,
      strand: '-',
    })
    expect(pairCigar(chain!.edits)).toBe('13=1X14=')
  })

  it('writes two unrelated stretches as an insertion and a deletion', () => {
    const [chain] = pairAlignments(
      forward(7, 5, 8),
      forward(7, 6, 8),
      sequenceOf,
      { minMatch: 1 },
    )
    expect(pairCigar(chain!.edits)).toBe('40=24I30D40=')
    expect(chain!.sharedBases).toBe(80)
  })

  it('breaks a record at a private run longer than maxGap', () => {
    const chains = pairAlignments(
      forward(7, 5, 8),
      forward(7, 6, 8),
      sequenceOf,
      { maxGap: 25, minMatch: 1 },
    )
    expect(chains.map(chain => pairCigar(chain.edits))).toEqual(['40=', '40='])
    expect(
      chains.map(chain => chain.targetStart).sort((a, b) => a - b),
    ).toEqual([0, 70])
  })
})

// An LCG's low bits are its worst, and 'ACGT'[state % 4] off one writes poly-A
function randomSequence(length: number, seed: number) {
  let state = seed
  return Array.from({ length }, () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return 'ACGT'[((t ^ (t >>> 14)) >>> 0) % 4]!
  }).join('')
}

describe('pairAlignments past the exact alignment', () => {
  // long enough to be worth chaining across a 3 kb indel, as a real anchor is
  const FLANK = 200
  const unit = randomSequence(3000, 3)
  const sequences: Record<number, string> = {
    1: randomSequence(FLANK, 1),
    2: randomSequence(FLANK, 2),
    3: unit,
    4: reverseComplement(unit),
    5: randomSequence(60, 5),
    6: randomSequence(60, 6),
  }
  const lookup = (id: number) => sequences[id]!
  const count = (edits: [string, number][], op: string) =>
    edits.reduce((sum, [o, len]) => sum + (o === op ? len : 0), 0)

  it('reports an inversion the graph holds as two unrelated nodes as a - record', () => {
    const records = pairAlignments(forward(1, 3, 2), forward(1, 4, 2), lookup)
    expect(
      records.map(r => [
        r.strand,
        r.queryStart,
        r.queryEnd,
        pairCigar(r.edits),
      ]),
    ).toEqual([
      ['+', 0, 3400, '200=3000I3000D200='],
      ['-', 200, 3200, '3000='],
    ])
    expect(records[1]).toMatchObject({ targetStart: 200, targetEnd: 3200 })
  })

  it('aligns a tandem copy by its bases where a walk revisits the node', () => {
    const [record, ...rest] = pairAlignments(
      forward(1, 3, 3, 2),
      forward(1, 3, 2),
      lookup,
    )
    expect(rest).toEqual([])
    expect(count(record!.edits, '=')).toBe(3400)
    expect(count(record!.edits, 'I')).toBe(3000)
    expect(count(record!.edits, 'D') + count(record!.edits, 'X')).toBe(0)
    expect(record!.sharedBases).toBe(2 * FLANK)
  })

  it('leaves anchors worth fewer bases than the gap between them costs apart', () => {
    const records = pairAlignments(
      forward(5, 3, 3, 6),
      forward(5, 3, 6),
      lookup,
      { minMatch: 1 },
    )
    expect(records.map(r => pairCigar(r.edits))).toEqual(['60=', '60='])
  })
})

describe('Subgraph.pairAlignments', () => {
  it('matches the bases of both walks in every column, haplotype against haplotype', async () => {
    const db = await GBZBase.open(
      new LocalFile(path.join(dataDir, 'micb-kir3dl1.gbz.db')),
    )
    const subgraph = await subgraphInInterval(
      db,
      { sample: 'GRCh38', contig: 'chr6' },
      31500000,
      31501000,
      { context: 500 },
    )
    await subgraph.identifyPaths()
    const json = subgraph.toSubgraphJson({ names: 'resolved' })
    const nodeSequence = new Map(json.nodes.map(n => [n.id, n.sequence]))
    const walks = new Map(
      json.paths.map(p => {
        const [, name, start] = /^(.*)\[(\d+)-\d+\]$/.exec(p.name)!
        return [
          `${name} ${start}`,
          p.path
            .map(step => {
              const sequence = nodeSequence.get(step.id)!
              return step.is_reverse ? reverseComplement(sequence) : sequence
            })
            .join(''),
        ] as const
      }),
    )
    const target = subgraph
      .alignments()
      .flatMap(a => (a.resolved && a.strand === '+' ? [a.name] : []))
      .find(name => name.sample !== 'GRCh38')!
    const records = subgraph.pairAlignments({ target, maxGap: 100000 })
    expect(records.length).toBeGreaterThan(50)
    expect(records.some(r => r.strand === '-')).toBe(true)
    expect(records.some(r => r.query.sample === 'GRCh38')).toBe(true)

    const walkHolding = (
      name: { sample: string; haplotype: number; contig: string },
      start: number,
      end: number,
    ) => {
      const prefix = `${name.sample}#${name.haplotype}#${name.contig} `
      for (const [key, sequence] of walks) {
        const walkStart = Number(key.slice(prefix.length))
        if (
          key.startsWith(prefix) &&
          walkStart <= start &&
          end <= walkStart + sequence.length
        ) {
          return sequence.slice(start - walkStart, end - walkStart)
        }
      }
      throw new Error(`no walk holds ${prefix}${start}-${end}`)
    }

    const query = records.find(r => r.query.sample !== 'GRCh38')!.query
    const onePair = subgraph.pairAlignments({ target, query, maxGap: 100000 })
    expect(onePair).toEqual(
      records.filter(
        r =>
          r.query.sample === query.sample &&
          r.query.haplotype === query.haplotype,
      ),
    )
    expect(onePair.length).toBeGreaterThan(0)

    let compared = 0
    for (const record of records) {
      const forwardQuery = walkHolding(
        record.query,
        record.queryStart,
        record.queryEnd,
      )
      const query =
        record.strand === '-' ? reverseComplement(forwardQuery) : forwardQuery
      const targetBases = walkHolding(
        record.target,
        record.targetStart,
        record.targetEnd,
      )
      let q = 0
      let t = 0
      for (const [, len, op] of record.cigar.matchAll(/(\d+)([=XID])/g)) {
        const n = Number(len)
        if (op === '=' || op === 'X') {
          for (let i = 0; i < n; i++) {
            expect(query[q + i] === targetBases[t + i]).toBe(op === '=')
          }
          compared += n
        }
        q += op === 'D' ? 0 : n
        t += op === 'I' ? 0 : n
      }
      expect(q).toBe(query.length)
      expect(t).toBe(targetBases.length)
    }
    expect(compared).toBeGreaterThan(50000)
  })
})

describe('gbz-base-query --stack', () => {
  it('prints each row against the next as PAF, a reverse-strand walk included', async () => {
    const lengths = path.join(tmpdir(), `gbz-base-lengths-${process.pid}.tsv`)
    await writeFile(lengths, 'HG03579#1#JAGYVU010000035.1\t20000000\n')
    const written: string[] = []
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(chunk => {
        written.push(String(chunk))
        return true
      })
    try {
      await main([
        path.join(dataDir, 'micb-kir3dl1.gbz.db'),
        '--sample',
        'GRCh38',
        '--contig',
        'chr6',
        '--interval',
        '31500000..31501000',
        '--context',
        '0',
        '--stack',
        'HG03579#1,GRCh38#0,HG02723#1',
        '--contig-lengths',
        lengths,
      ])
    } finally {
      write.mockRestore()
      await rm(lengths)
    }
    const rows = written
      .join('')
      .trimEnd()
      .split('\n')
      .map(line => line.split('\t'))
    expect(rows.map(f => [f[0], f[4], f[5]])).toEqual([
      ['HG03579#1#JAGYVU010000035.1', '-', 'GRCh38#0#chr6'],
      ['GRCh38#0#chr6', '+', 'HG02723#1#JAHEOU010000100.1'],
    ])
    expect(rows[0]![1]).toBe('20000000')
    expect(rows[1]![1]).toBe(rows[1]![3])
    expect(rows.every(f => /^ns:i:\d+$/.test(f[12]!))).toBe(true)
    expect(rows.every(f => /^cg:Z:(\d+[=XID])+$/.test(f[13]!))).toBe(true)
  })
})
