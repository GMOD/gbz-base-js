import { decodeRecord, readVarint } from './record.ts'

import type { Pager } from './pager.ts'
import type { SqlValue } from './record.ts'

const INTERIOR_INDEX = 0x02
const INTERIOR_TABLE = 0x05
const LEAF_INDEX = 0x0a
const LEAF_TABLE = 0x0d

interface PageHeader {
  type: number
  cellCount: number
  rightChild: number
  cellPointers: number
}

function readHeader(page: Uint8Array, start: number): PageHeader {
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength)
  const type = page[start]
  if (
    type !== INTERIOR_INDEX &&
    type !== INTERIOR_TABLE &&
    type !== LEAF_INDEX &&
    type !== LEAF_TABLE
  ) {
    throw new Error(`SQLite page has unknown b-tree type ${type}`)
  }
  const interior = type === INTERIOR_INDEX || type === INTERIOR_TABLE
  return {
    type,
    cellCount: view.getUint16(start + 3),
    rightChild: interior ? view.getUint32(start + 8) : 0,
    cellPointers: start + (interior ? 12 : 8),
  }
}

function cellOffset(page: Uint8Array, header: PageHeader, index: number) {
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength)
  return view.getUint16(header.cellPointers + 2 * index)
}

function readUint32(page: Uint8Array, offset: number) {
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength)
  return view.getUint32(offset)
}

export class BTree {
  private readonly usable: number
  private pager: Pager

  constructor(pager: Pager, reservedBytes: number) {
    this.pager = pager
    this.usable = pager.pageSize - reservedBytes
  }

  private localPayloadSize(total: number, isIndex: boolean) {
    const usable = this.usable
    const maxLocal = isIndex
      ? Math.floor(((usable - 12) * 64) / 255) - 23
      : usable - 35
    if (total <= maxLocal) {
      return total
    }
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23
    const spill = minLocal + ((total - minLocal) % (usable - 4))
    return spill <= maxLocal ? spill : minLocal
  }

  private async payload(
    page: Uint8Array,
    offset: number,
    total: number,
    isIndex: boolean,
  ) {
    const local = this.localPayloadSize(total, isIndex)
    if (local === total) {
      return page.subarray(offset, offset + total)
    }
    const result = new Uint8Array(total)
    result.set(page.subarray(offset, offset + local), 0)
    let filled = local
    let next = readUint32(page, offset + local)
    while (next !== 0 && filled < total) {
      const overflow = await this.pager.page(next)
      const chunk = overflow.subarray(
        4,
        4 + Math.min(this.usable - 4, total - filled),
      )
      result.set(chunk, filled)
      filled += chunk.length
      next = readUint32(overflow, 0)
    }
    if (filled !== total) {
      throw new Error(
        'SQLite overflow chain ended before the payload was complete',
      )
    }
    return result
  }

  private async pageAt(pageNumber: number) {
    const page = await this.pager.page(pageNumber)
    return { page, header: readHeader(page, pageNumber === 1 ? 100 : 0) }
  }

  async tableRowid(
    root: number,
    rowid: number,
  ): Promise<SqlValue[] | undefined> {
    let pageNumber = root
    for (;;) {
      const { page, header } = await this.pageAt(pageNumber)
      if (header.type === LEAF_TABLE) {
        let low = 0
        let high = header.cellCount
        while (low < high) {
          const mid = (low + high) >> 1
          const offset = cellOffset(page, header, mid)
          const [size, afterSize] = readVarint(page, offset)
          const [key, afterKey] = readVarint(page, afterSize)
          if (key === rowid) {
            return decodeRecord(await this.payload(page, afterKey, size, false))
          }
          if (key < rowid) {
            low = mid + 1
          } else {
            high = mid
          }
        }
        return undefined
      }
      if (header.type !== INTERIOR_TABLE) {
        throw new Error('SQLite table b-tree contains an index page')
      }
      let low = 0
      let high = header.cellCount
      while (low < high) {
        const mid = (low + high) >> 1
        const offset = cellOffset(page, header, mid)
        const [key] = readVarint(page, offset + 4)
        if (key < rowid) {
          low = mid + 1
        } else {
          high = mid
        }
      }
      pageNumber =
        low === header.cellCount
          ? header.rightChild
          : readUint32(page, cellOffset(page, header, low))
    }
  }

  async *tableScan(
    root: number,
  ): AsyncGenerator<{ rowid: number; values: SqlValue[] }> {
    const { page, header } = await this.pageAt(root)
    if (header.type === LEAF_TABLE) {
      for (let i = 0; i < header.cellCount; i++) {
        const offset = cellOffset(page, header, i)
        const [size, afterSize] = readVarint(page, offset)
        const [rowid, afterKey] = readVarint(page, afterSize)
        yield {
          rowid,
          values: decodeRecord(await this.payload(page, afterKey, size, false)),
        }
      }
    } else {
      for (let i = 0; i < header.cellCount; i++) {
        yield* this.tableScan(readUint32(page, cellOffset(page, header, i)))
      }
      yield* this.tableScan(header.rightChild)
    }
  }

  private async indexCell(page: Uint8Array, header: PageHeader, index: number) {
    const offset = cellOffset(page, header, index)
    const interior = header.type === INTERIOR_INDEX
    const [size, afterSize] = readVarint(page, interior ? offset + 4 : offset)
    const values = decodeRecord(await this.payload(page, afterSize, size, true))
    return { values, leftChild: interior ? readUint32(page, offset) : 0 }
  }

  async *indexScanFrom(
    root: number,
    low: number[],
  ): AsyncGenerator<SqlValue[]> {
    const { page, header } = await this.pageAt(root)
    let first = 0
    let high = header.cellCount
    while (first < high) {
      const mid = (first + high) >> 1
      const cell = await this.indexCell(page, header, mid)
      if (compareKey(cell.values, low) < 0) {
        first = mid + 1
      } else {
        high = mid
      }
    }
    for (let i = first; i < header.cellCount; i++) {
      const cell = await this.indexCell(page, header, i)
      if (header.type === INTERIOR_INDEX) {
        yield* this.indexScanFrom(cell.leftChild, low)
      }
      yield cell.values
    }
    if (header.type === INTERIOR_INDEX) {
      yield* this.indexScanFrom(header.rightChild, low)
    }
  }

  async indexSeekLE(
    root: number,
    key: number[],
  ): Promise<SqlValue[] | undefined> {
    let best: SqlValue[] | undefined
    let pageNumber = root
    for (;;) {
      const { page, header } = await this.pageAt(pageNumber)
      let low = 0
      let high = header.cellCount
      let child = 0
      while (low < high) {
        const mid = (low + high) >> 1
        const cell = await this.indexCell(page, header, mid)
        if (compareKey(cell.values, key) <= 0) {
          best = cell.values
          low = mid + 1
        } else {
          child = cell.leftChild
          high = mid
        }
      }
      if (header.type === LEAF_INDEX) {
        return best
      }
      pageNumber = low === header.cellCount ? header.rightChild : child
    }
  }
}

function compareKey(values: SqlValue[], key: number[]) {
  for (let i = 0; i < key.length; i++) {
    const a = values[i]
    const b = key[i]
    if (typeof a !== 'number' || b === undefined) {
      throw new Error('SQLite index key is not numeric')
    }
    if (a !== b) {
      return a < b ? -1 : 1
    }
  }
  return 0
}
