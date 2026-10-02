import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { SqliteDatabase } from '../src/sqlite/database.ts'
import { readVarint } from '../src/sqlite/record.ts'

const bytes = await readFile(
  path.join(import.meta.dirname, 'data', 'micb-kir3dl1.gbz.db'),
)

function source(fails: (length: number, position: number) => boolean) {
  return {
    read: async (length: number, position: number) => {
      if (fails(length, position)) {
        throw new Error('network down')
      }
      return bytes.subarray(position, position + length)
    },
  }
}

async function countRows(db: SqliteDatabase) {
  const rowids = new Set<number>()
  for await (const { rowid } of db.scan('Nodes')) {
    rowids.add(rowid)
  }
  return rowids.size
}

function countUnhandled() {
  const seen: unknown[] = []
  const listener = (reason: unknown) => seen.push(reason)
  process.on('unhandledRejection', listener)
  return {
    seen,
    stop: () => process.off('unhandledRejection', listener),
  }
}

describe('pager', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves no unhandled rejection when a prefetch nobody reads fails', async () => {
    let failing = false
    const db = await SqliteDatabase.open(
      source(() => failing),
      { blockSize: 4096 },
    )
    failing = true
    vi.useFakeTimers()
    const unhandled = countUnhandled()
    db.pager.prefetch([20, 21, 22])
    const scan = countRows(db).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await scan).toMatchObject({ message: 'network down' })
    unhandled.stop()
    expect(unhandled.seen).toEqual([])
  })

  it('keeps a refetched block when an older fetch of it fails later', async () => {
    const db = await SqliteDatabase.open(
      source(length => length > 4096),
      { blockSize: 4096, maxBlocks: 4 },
    )
    const { pager } = db
    vi.useFakeTimers()
    pager.prefetch([20, 21])
    for (const page of [30, 31, 32]) {
      await pager.page(page)
    }
    await pager.page(20)
    await vi.advanceTimersByTimeAsync(1000)
    const fetches = pager.fetches
    await pager.page(20)
    expect(pager.fetches).toBe(fetches)
  })

  it('never prefetches more blocks than half the cache holds', async () => {
    const plain = await SqliteDatabase.open(
      source(() => false),
      { blockSize: 4096, maxBlocks: 4 },
    )
    for (let rowid = 1; rowid <= 5782; rowid += 50) {
      await plain.byRowid('Nodes', rowid)
    }
    const prefetched = await SqliteDatabase.open(
      source(() => false),
      { blockSize: 4096, maxBlocks: 4 },
    )
    expect(await prefetched.prefetchRows('Nodes', [[1, 5782]])).toBe(false)
    for (let rowid = 1; rowid <= 5782; rowid += 50) {
      await prefetched.byRowid('Nodes', rowid)
    }
    expect(prefetched.pager.bytesFetched).toBe(plain.pager.bytesFetched)
  })

  it('budgets the runs of one prefetch together, not one at a time', async () => {
    const open = () =>
      SqliteDatabase.open(
        source(() => false),
        { blockSize: 4096, maxBlocks: 8 },
      )
    const runs = (count: number) =>
      Array.from({ length: count }, (_, i): [number, number] => [
        1 + i * 1000,
        40 + i * 1000,
      ])
    const fits = await open()
    expect(await fits.prefetchRows('Nodes', runs(3))).toBe(true)
    const fetches = fits.pager.fetches
    for (const [lo, hi] of runs(3)) {
      for (let rowid = lo; rowid <= hi; rowid++) {
        await fits.byRowid('Nodes', rowid)
      }
    }
    expect(fits.pager.fetches).toBe(fetches)
    const tooMany = await open()
    expect(await tooMany.prefetchRows('Nodes', runs(5))).toBe(false)
  })

  it('scans a three-level table without fetching any block twice', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gbz-base-pager-'))
    const file = path.join(dir, 'deep.db')
    try {
      const writer = new DatabaseSync(file)
      writer.exec('PRAGMA page_size = 512')
      writer.exec('CREATE TABLE T (id INTEGER PRIMARY KEY, v BLOB)')
      const insert = writer.prepare('INSERT INTO T VALUES (?, ?)')
      writer.exec('BEGIN')
      for (let id = 1; id <= 20000; id++) {
        insert.run(id, new Uint8Array(8).fill(id % 251))
      }
      writer.exec('COMMIT')
      writer.close()
      const deep = await readFile(file)
      const db = await SqliteDatabase.open(
        {
          read: async (length: number, position: number) =>
            deep.subarray(position, position + length),
        },
        { blockSize: 512, maxBlocks: 8 },
      )
      let last = 0
      for await (const { rowid } of db.scan('T')) {
        last = rowid
      }
      expect(last).toBe(20000)
      expect(db.pager.bytesFetched).toBeLessThanOrEqual(deep.length)
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  it('scans a table without fetching any block twice', async () => {
    const db = await SqliteDatabase.open(
      source(() => false),
      { blockSize: 4096, maxBlocks: 4 },
    )
    expect(await countRows(db)).toBe(5782)
    expect(db.pager.bytesFetched).toBeLessThanOrEqual(bytes.length)
  })

  it('opens with a block size smaller than the SQLite header', async () => {
    const db = await SqliteDatabase.open(
      source(() => false),
      { blockSize: 64 },
    )
    expect(db.objects.has('Nodes')).toBe(true)
  })

  it('refuses a block size or cache size that is not a positive integer', async () => {
    for (const opts of [
      { blockSize: Number.NaN },
      { blockSize: 0 },
      { maxBlocks: Number.NaN },
      { maxBlocks: -1 },
    ]) {
      await expect(
        SqliteDatabase.open(
          source(() => false),
          opts,
        ),
      ).rejects.toThrow(/must be a positive integer/)
    }
  })
})

describe('readVarint', () => {
  function encode(value: bigint) {
    const out: number[] = []
    for (let shift = 49n; shift > 0n; shift -= 7n) {
      out.push(Number((value >> shift) & 0x7fn) | 0x80)
    }
    out.push(Number(value & 0x7fn))
    return Uint8Array.from(out)
  }

  it('reads an 8-byte varint up to the largest safe integer', () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER)
    expect(readVarint(encode(max), 0)).toEqual([Number.MAX_SAFE_INTEGER, 8])
  })

  it('refuses an 8-byte varint past the safe integer range', () => {
    expect(() => readVarint(encode(2n ** 53n), 0)).toThrow(
      /exceeds the safe integer range/,
    )
  })
})
