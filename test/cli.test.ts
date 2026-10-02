import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { main } from '../src/cli.ts'

const dataDir = path.join(import.meta.dirname, 'data')
const graph = path.join(dataDir, 'micb-kir3dl1.gbz.db')
const index = path.join(dataDir, 'micb-kir3dl1.haplotype-index.db')
const window = [
  '--sample',
  'GRCh38',
  '--contig',
  'chr6',
  '--interval',
  '31500000..31501000',
]

async function captured(argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    out.push(String(chunk))
    return true
  })
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    err.push(String(chunk))
    return true
  })
  try {
    await main(argv)
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
  return { stdout: out.join(''), stderr: err.join('') }
}

describe('gbz-base-query arguments', () => {
  it.each([
    [['--context', 'abc'], '--context needs a whole number, not abc'],
    [['--context', '-5'], '--context needs a whole number, not -5'],
    [['--context', ''], '--context needs a whole number, not '],
    [['--offset', '1.5'], '--offset needs a whole number, not 1.5'],
    [['--node', '0'], '--node needs a whole number of at least 1, not 0'],
    [['--limit', '0'], '--limit needs a whole number of at least 1, not 0'],
    [['--block-size', 'big'], '--block-size needs a whole number'],
    [['--interval', '5'], '--interval needs A..B, not 5'],
    [['--interval', '1..2..3'], '--interval needs A..B, not 1..2..3'],
    [['--interval', '1..x'], '--interval needs a whole number, not x'],
    [['--sample', '--contig', 'chr6'], '--sample needs a value'],
    [['--keep', '-o', '5'], '--keep needs a value'],
  ])('refuses %j', async (args, message) => {
    await expect(main([graph, ...args])).rejects.toThrow(message)
  })

  it.each(['S#', 'S#x', 'S#1#2', '#1'])('refuses --keep %s', async keep => {
    await expect(
      main([graph, '--haplotype-index', index, ...window, '--keep', keep]),
    ).rejects.toThrow(`Expected sample or sample#haplotype, got ${keep}`)
  })

  it('refuses a contig length that is not a whole number', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gbz-base-cli-'))
    const lengths = path.join(dir, 'lengths.tsv')
    await writeFile(lengths, 'chr6\tlong\n')
    try {
      await expect(
        main([
          graph,
          '--haplotype-index',
          index,
          ...window,
          '--stack',
          'GRCh38#0,HG00438#1',
          '--contig-lengths',
          lengths,
        ]),
      ).rejects.toThrow('--contig-lengths chr6 needs a whole number, not long')
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  it('leaves the identification report out of --stats when --keep anchors the query', async () => {
    const { stderr } = await captured([
      graph,
      '--haplotype-index',
      index,
      ...window,
      '--keep',
      'HG00438',
      '--stats',
    ])
    expect(stderr).toContain('keep:')
    expect(stderr).not.toContain('identification:')
  })
})

describe('gbz-base-query output', () => {
  it('exits quietly when its reader closes the pipe early', async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { run } from ${JSON.stringify(path.join(import.meta.dirname, '..', 'src', 'cli.ts'))}; run(process.argv.slice(1))`,
        graph,
        '--sample',
        'GRCh38',
        '--contig',
        'chr6',
        '--interval',
        '31500000..31510000',
        '--format',
        'gfa',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdout.once('data', () => {
      child.stdout.destroy()
    })
    const code = await new Promise(resolve => child.on('close', resolve))
    expect(stderr).not.toContain('EPIPE')
    expect(code).toBe(0)
  })
})
