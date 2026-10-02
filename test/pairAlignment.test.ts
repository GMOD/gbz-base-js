import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { openSampled, sampledCompanion } from './fixtures.ts'
import { main } from '../src/cli.ts'
import { encodeNode } from '../src/gbwt/node.ts'
import { reverseComplement } from '../src/gbwt/sequence.ts'
import { pairAlignments, pairCigar } from '../src/pairAlignment.ts'

import type { PairChain } from '../src/pairAlignment.ts'
import type { PairAlignment } from '../src/subgraph.ts'

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
  9: 'A',
  10: 'G',
  11: 'ACGATGCA',
}
const sequenceOf = (id: number) => SEQUENCES[id]!
const forward = (...ids: number[]) => ids.map(id => encodeNode(id, 'forward'))
const flipped = (...ids: number[]) => ids.map(id => encodeNode(id, 'reverse'))
const count = (edits: [string, number][], op: string) =>
  edits.reduce((sum, [o, len]) => sum + (o === op ? len : 0), 0)

describe('pairAlignments', () => {
  it('aligns the private stretch between two shared nodes base by base', () => {
    const [chain] = pairAlignments({
      query: forward(1, 4, 3),
      target: forward(1, 2, 3),
      sequenceOf,
      minMatch: 1,
    })
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
    const [chain] = pairAlignments({
      query: flipped(3, 4, 1),
      target: forward(1, 2, 3),
      sequenceOf,
      minMatch: 1,
    })
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
    const [chain] = pairAlignments({
      query: forward(7, 5, 8),
      target: forward(7, 6, 8),
      sequenceOf,
      minMatch: 1,
    })
    expect(pairCigar(chain!.edits)).toBe('40=24I30D40=')
    expect(chain!.sharedBases).toBe(80)
  })

  it('breaks a record at a private run longer than maxGap', () => {
    const chains = pairAlignments({
      query: forward(7, 5, 8),
      target: forward(7, 6, 8),
      sequenceOf,
      maxGap: 25,
      minMatch: 1,
    })
    expect(chains.map(chain => pairCigar(chain.edits))).toEqual(['40=', '40='])
    expect(
      chains.map(chain => chain.targetStart).sort((a, b) => a - b),
    ).toEqual([0, 70])
  })

  it('starts a run at the first target step when the query visits the last one just before', () => {
    const records = pairAlignments({
      query: forward(8, 5, 7),
      target: forward(7, 8),
      sequenceOf,
      minMatch: 1,
      bases: false,
    })
    expect(
      records.map(r => [r.queryStart, r.targetStart, pairCigar(r.edits)]),
    ).toEqual([
      [0, 40, '40='],
      [64, 0, '40='],
    ])
  })

  it('aligns a single-node target to the same node walked backwards', () => {
    const records = pairAlignments({
      query: flipped(7),
      target: forward(7),
      sequenceOf,
      minMatch: 1,
    })
    expect(records.map(r => [r.strand, pairCigar(r.edits)])).toEqual([
      ['-', '40='],
    ])
  })

  it.each([
    [
      'a SNP bubble',
      forward(1, 9, 3),
      forward(1, 10, 3),
      '10=1X10=',
      '10=1I1D10=',
    ],
    [
      'a SNP bubble on a flipped walk',
      flipped(3, 9, 1),
      forward(1, 10, 3),
      '10=1X10=',
      '10=1D1I10=',
    ],
    [
      'a stretch both walks hold on different nodes',
      forward(1, 4, 3),
      forward(1, 2, 3),
      '13=1X14=',
      '10=8I8D10=',
    ],
    [
      'the same bases on different nodes',
      forward(1, 11, 3),
      forward(1, 2, 3),
      '28=',
      '10=8I8D10=',
    ],
    [
      'two unrelated stretches',
      forward(7, 5, 8),
      forward(7, 6, 8),
      '40=24I30D40=',
      '40=24I30D40=',
    ],
    [
      'an insertion private to the query',
      forward(7, 5, 8),
      forward(7, 8),
      '40=24I40=',
      '40=24I40=',
    ],
    [
      'a deletion private to the target',
      forward(7, 8),
      forward(7, 5, 8),
      '40=24D40=',
      '40=24D40=',
    ],
  ])(
    'with bases: false, writes %s from the shared nodes alone',
    (_, query, target, compared, shared) => {
      const records = (bases: boolean) =>
        pairAlignments({ query, target, sequenceOf, minMatch: 1, bases }).map(
          ({ edits, sharedBases, ...span }) => ({
            span,
            cigar: pairCigar(edits),
            matches: count(edits, '='),
            sharedBases,
          }),
        )
      const withBases = records(true)
      const withoutBases = records(false)
      expect(withBases.map(r => r.cigar)).toEqual([compared])
      expect(withoutBases.map(r => r.cigar)).toEqual([shared])
      expect(withoutBases.map(r => r.span)).toEqual(withBases.map(r => r.span))
      expect(withoutBases.every(r => r.matches === r.sharedBases)).toBe(true)
    },
  )
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

  it('reports an inversion the graph holds as two unrelated nodes as a - record', () => {
    const records = pairAlignments({
      query: forward(1, 3, 2),
      target: forward(1, 4, 2),
      sequenceOf: lookup,
    })
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

  const throughSharedInversion = [...forward(1), ...flipped(3), ...forward(2)]
  const summary = (records: PairChain[]) =>
    records.map(r => [
      r.strand,
      r.queryStart,
      r.queryEnd,
      r.targetStart,
      r.targetEnd,
      pairCigar(r.edits),
      r.sharedBases,
    ])

  it('reports an inversion a walk takes through a shared node once, though its bases align again in the gap of the forward record over it', () => {
    expect(
      summary(
        pairAlignments({
          query: throughSharedInversion,
          target: forward(1, 3, 2),
          sequenceOf: lookup,
        }),
      ),
    ).toEqual([
      ['+', 0, 3400, 0, 3400, '200=3000I3000D200=', 400],
      ['-', 200, 3200, 200, 3200, '3000=', 3000],
    ])
  })

  it('with bases: false, reports the inversion a walk takes through a shared node and none that only the bases would find', () => {
    const noBases = (query: number[], target: number[]) =>
      summary(
        pairAlignments({ query, target, sequenceOf: lookup, bases: false }),
      )
    expect(noBases(forward(1, 3, 2), forward(1, 4, 2))).toEqual([
      ['+', 0, 3400, 0, 3400, '200=3000I3000D200=', 400],
    ])
    expect(noBases(throughSharedInversion, forward(1, 3, 2))).toEqual([
      ['+', 0, 3400, 0, 3400, '200=3000I3000D200=', 400],
      ['-', 200, 3200, 200, 3200, '3000=', 3000],
    ])
  })

  it('aligns a tandem copy by its bases where a walk revisits the node', () => {
    const [record, ...rest] = pairAlignments({
      query: forward(1, 3, 3, 2),
      target: forward(1, 3, 2),
      sequenceOf: lookup,
    })
    expect(rest).toEqual([])
    expect(count(record!.edits, '=')).toBe(3400)
    expect(count(record!.edits, 'I')).toBe(3000)
    expect(count(record!.edits, 'D') + count(record!.edits, 'X')).toBe(0)
    expect(record!.sharedBases).toBe(2 * FLANK)
  })

  it('leaves anchors worth fewer bases than the gap between them costs apart', () => {
    const records = pairAlignments({
      query: forward(5, 3, 3, 6),
      target: forward(5, 3, 6),
      sequenceOf: lookup,
      minMatch: 1,
    })
    expect(records.map(r => pairCigar(r.edits))).toEqual(['60=', '60='])
  })
})

describe('pairAlignments inside a large private stretch', () => {
  // anchors long enough to chain across the stretch between them
  const records = (query: string, target: string) => {
    const sequences: Record<number, string> = {
      1: randomSequence(300, 11),
      2: randomSequence(300, 12),
      3: query,
      4: target,
    }
    return pairAlignments({
      query: forward(1, 3, 2),
      target: forward(1, 4, 2),
      sequenceOf: id => sequences[id]!,
    })
  }

  it('aligns the gap between two chained k-mer runs by seeding it again', () => {
    // the target repeats the unit 66 times, past the 64 occurrences a k-mer may
    // seed from, so only the flanks chain; the gap between them holds one copy
    const unit = randomSequence(2100, 13)
    const left = randomSequence(1000, 14)
    const right = randomSequence(1000, 15)
    const [record, ...rest] = records(
      left + unit + right,
      unit.repeat(65) + left + unit + right,
    )
    expect(rest).toEqual([])
    expect(count(record!.edits, 'I')).toBe(0)
    expect(count(record!.edits, '=')).toBe(300 + 1000 + 2100 + 1000 + 300)
  })

  it('keeps an inversion nested in the gap of the forward chain over the same stretch', () => {
    const left = randomSequence(1000, 14)
    const inverted = randomSequence(1000, 15)
    const right = randomSequence(1000, 16)
    const rs = records(
      left + inverted + right,
      left + reverseComplement(inverted) + right,
    )
    // each flank may run a base into the inversion by chance, which costs the
    // inversion that base and no more
    expect(rs.map(r => r.strand)).toEqual(['+', '-'])
    const inversion = rs[1]!
    expect(inversion.queryStart).toBeGreaterThanOrEqual(1300)
    expect(inversion.queryEnd).toBeLessThanOrEqual(2300)
    expect(inversion.edits.every(([op]) => op === '=')).toBe(true)
    expect(count(inversion.edits, '=')).toBeGreaterThanOrEqual(990)
  })

  it('lets no later chain re-claim, on a paralog, what an earlier record of its orientation spans', () => {
    // flipped against the target, left-gap-right chains as one record, and the
    // gap's own copy sits past it in the target, where only a nested chain
    // could reach it
    const left = randomSequence(1000, 14)
    const gap = randomSequence(1000, 15)
    const other = randomSequence(1000, 16)
    const right = randomSequence(1000, 17)
    const rs = records(
      left + gap + right,
      reverseComplement(left + other + right + gap),
    )
    expect(rs.filter(r => r.strand === '-')).toHaveLength(1)
  })

  it('aligns a base in one record only, the one scoring higher over the stretch two records share', () => {
    // the target holds the query's copy inverted base for base, and forward
    // with every tenth base changed, which no k-mer seeds and only the exact
    // alignment of the forward record's gap reaches
    const unit = randomSequence(1000, 21)
    const diverged = unit.replace(/./g, (base, i: number) =>
      i % 10 === 5 ? (base === 'A' ? 'C' : 'A') : base,
    )
    const left = randomSequence(1000, 22)
    const right = randomSequence(1000, 23)
    const rs = records(
      left + unit + right,
      left + reverseComplement(unit) + diverged + right,
    )
    const alignedTimes = new Uint8Array(300 + 3000 + 300)
    for (const r of rs) {
      let qi = 0
      for (const [op, len] of r.edits) {
        for (let k = 0; k < len && op !== 'D'; k++) {
          if (op === '=' || op === 'X') {
            alignedTimes[
              r.strand === '-' ? r.queryEnd - 1 - qi - k : r.queryStart + qi + k
            ]! += 1
          }
        }
        qi += op === 'D' ? 0 : len
      }
    }
    expect(Math.max(...alignedTimes)).toBe(1)
    const inversion = rs.find(r => r.strand === '-')!
    expect(count(inversion.edits, '=')).toBeGreaterThanOrEqual(990)
  })
})

describe('Subgraph.pairAlignments', () => {
  const micbWindow = async () => {
    const db = await openSampled('micb-kir3dl1.gbz.db')
    const subgraph = await db.subgraphInInterval({
      path: { sample: 'GRCh38', contig: 'chr6' },
      start: 31500000,
      end: 31501000,
      context: 500,
    })
    await subgraph.identifyPaths()
    const target = subgraph
      .alignments()
      .flatMap(a => (a.resolved && a.strand === '+' ? [a.name] : []))
      .find(name => name.sample !== 'GRCh38')!
    return { subgraph, target }
  }

  it('matches the bases of both walks in every column, haplotype against haplotype', async () => {
    const { subgraph, target } = await micbWindow()
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

  it('with bases: false, matches only the bases on shared nodes', async () => {
    const { subgraph, target } = await micbWindow()
    const records = subgraph.pairAlignments({
      target,
      maxGap: 100000,
      bases: false,
    })
    expect(records.length).toBeGreaterThan(50)
    expect(records.some(r => r.strand === '-')).toBe(true)
    for (const record of records) {
      expect(record.cigar).toMatch(/^(\d+[=ID])+$/)
      expect(record.matches).toBe(record.sharedBases)
    }
    const compared = subgraph.pairAlignments({ target, maxGap: 100000 })
    expect(compared.some(r => r.cigar.includes('X'))).toBe(true)
    const span = ({ cigar, matches, columns, ...rest }: PairAlignment) => rest
    expect(records.map(span)).toEqual(compared.map(span))
  })
})

describe('gbz-base-query --stack', () => {
  const paf = async (...args: string[]) => {
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
        '--haplotype-index',
        sampledCompanion('micb-kir3dl1.gbz.db'),
        '--sample',
        'GRCh38',
        '--contig',
        'chr6',
        '--interval',
        '31500000..31501000',
        '--contig-lengths',
        lengths,
        ...args,
      ])
    } finally {
      write.mockRestore()
      await rm(lengths)
    }
    return written
      .join('')
      .trimEnd()
      .split('\n')
      .map(line => line.split('\t'))
  }

  it('prints each row against the next as PAF, a reverse-strand walk included', async () => {
    const rows = await paf(
      '--context',
      '0',
      '--stack',
      'HG03579#1,GRCh38#0,HG02723#1',
    )
    expect(rows.map(f => [f[0], f[4], f[5]])).toEqual([
      ['HG03579#1#JAGYVU010000035.1', '-', 'GRCh38#0#chr6'],
      ['GRCh38#0#chr6', '+', 'HG02723#1#JAHEOU010000100.1'],
    ])
    expect(rows[0]![1]).toBe('20000000')
    expect(rows[1]![1]).toBe(rows[1]![3])
    expect(rows.every(f => /^ns:i:\d+$/.test(f[12]!))).toBe(true)
    expect(rows.every(f => /^cg:Z:(\d+[=XID])+$/.test(f[13]!))).toBe(true)
  })

  it('with --no-bases, writes each SNP between two shared nodes as an insertion and a deletion', async () => {
    const stack = ['--context', '100', '--stack', 'HG03453#1,HG02723#1,CHM13#0']
    const compared = await paf(...stack)
    const shared = await paf(...stack, '--no-bases')
    const span = (f: string[]) => [f[0], f[2], f[3], f[4], f[5], f[7], f[8]]
    expect(shared.map(span)).toEqual(compared.map(span))
    const tags = (rows: string[][]) => rows.map(f => [f[4], f[9], f[12], f[13]])
    expect(tags(compared)).toEqual([
      ['-', '1430', 'ns:i:1430', 'cg:Z:417=1X77=1X45=1X253=1X4=1X456=1X178='],
      ['+', '1433', 'ns:i:1433', 'cg:Z:455=1X339=1X146=1X493='],
    ])
    expect(tags(shared)).toEqual([
      [
        '-',
        '1430',
        'ns:i:1430',
        'cg:Z:417=1D1I77=1D1I45=1D1I253=1D1I4=1D1I456=1D1I178=',
      ],
      ['+', '1433', 'ns:i:1433', 'cg:Z:455=1I1D339=1I1D146=1I1D493='],
    ])
  })
})
