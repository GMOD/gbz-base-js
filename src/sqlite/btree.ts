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

function readUint16(page: Uint8Array, offset: number) {
  return page[offset]! * 256 + page[offset + 1]!
}

function readUint32(page: Uint8Array, offset: number) {
  return (
    page[offset]! * 16777216 +
    page[offset + 1]! * 65536 +
    page[offset + 2]! * 256 +
    page[offset + 3]!
  )
}

function readHeader(page: Uint8Array, start: number): PageHeader {
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
    cellCount: readUint16(page, start + 3),
    rightChild: interior ? readUint32(page, start + 8) : 0,
    cellPointers: start + (interior ? 12 : 8),
  }
}

function cellOffset(page: Uint8Array, header: PageHeader, index: number) {
  return readUint16(page, header.cellPointers + 2 * index)
}

interface IndexCell {
  values: SqlValue[]
  leftChild: number
}

const MAX_DECODED_INDEX_PAGES = 4096

export class BTree {
  private readonly usable: number
  private pager: Pager
  private decodedIndexPages = new Map<number, (IndexCell | undefined)[]>()
  private tableDepths = new Map<number, Promise<number>>()

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

  private tableDepth(root: number, towards: number) {
    let depth = this.tableDepths.get(root)
    if (!depth) {
      depth = (async () => {
        let pageNumber = root
        for (let level = 0; ; level++) {
          const { page, header } = await this.pageAt(pageNumber)
          if (header.type === LEAF_TABLE) {
            return level
          }
          if (header.type !== INTERIOR_TABLE) {
            throw new Error('SQLite table b-tree contains an index page')
          }
          const child = this.childIndexFor(page, header, towards)
          pageNumber =
            child === header.cellCount
              ? header.rightChild
              : readUint32(page, cellOffset(page, header, child))
        }
      })()
      this.tableDepths.set(root, depth)
      depth.catch(() => this.tableDepths.delete(root))
    }
    return depth
  }

  private childIndexFor(page: Uint8Array, header: PageHeader, rowid: number) {
    let low = 0
    let high = header.cellCount
    while (low < high) {
      const mid = (low + high) >> 1
      const [key] = readVarint(page, cellOffset(page, header, mid) + 4)
      if (key < rowid) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return low
  }

  // Fetches the pages that hold the rows of the ranges, level by level. Up to
  // the pager's budget they come at once; past it a strict prefetch gives up
  // and returns false, and a streaming one fetches the leading blocks now and
  // the rest in chunks as reads approach them.
  async prefetchRowidRanges(
    root: number,
    ranges: [number, number][],
    stream = false,
  ) {
    if (ranges.length === 0) {
      return true
    }
    const leafLevel = await this.tableDepth(root, ranges[0]![0])
    let frontiers = ranges.map(() => [root])
    for (let level = 0; level < leafLevel; level++) {
      frontiers = await Promise.all(
        frontiers.map((pages, r) => this.childrenInRange(pages, ...ranges[r]!)),
      )
      const pages = frontiers.flat()
      if (stream) {
        this.pager.prefetchLeading(pages)
      } else if (!this.pager.prefetch(pages)) {
        return false
      }
    }
    return true
  }

  private async childrenInRange(pages: number[], lo: number, hi: number) {
    const decoded = await Promise.all(pages.map(n => this.pageAt(n)))
    const children: number[] = []
    decoded.forEach(({ page, header }, i) => {
      const from = i === 0 ? this.childIndexFor(page, header, lo) : 0
      const to =
        i === decoded.length - 1
          ? this.childIndexFor(page, header, hi)
          : header.cellCount
      for (let c = from; c <= to; c++) {
        children.push(
          c === header.cellCount
            ? header.rightChild
            : readUint32(page, cellOffset(page, header, c)),
        )
      }
    })
    return children
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
    yield* this.scanPage(root, await this.tableDepth(root, 0))
  }

  // Prefetches only leaves: interior pages prefetched a level up would be
  // evicted by the leaf prefetches below them before they were read
  private async *scanPage(
    pageNumber: number,
    depth: number,
  ): AsyncGenerator<{ rowid: number; values: SqlValue[] }> {
    const { page, header } = await this.pageAt(pageNumber)
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
      const children: number[] = []
      for (let i = 0; i < header.cellCount; i++) {
        children.push(readUint32(page, cellOffset(page, header, i)))
      }
      children.push(header.rightChild)
      if (depth === 1) {
        this.pager.prefetchLeading(children)
      }
      for (const child of children) {
        yield* this.scanPage(child, depth - 1)
      }
    }
  }

  private decodedCells(pageNumber: number, header: PageHeader) {
    let cells = this.decodedIndexPages.get(pageNumber)
    if (cells) {
      this.decodedIndexPages.delete(pageNumber)
    } else {
      cells = new Array<IndexCell | undefined>(header.cellCount)
      if (this.decodedIndexPages.size >= MAX_DECODED_INDEX_PAGES) {
        const oldest = this.decodedIndexPages.keys().next().value
        if (oldest !== undefined) {
          this.decodedIndexPages.delete(oldest)
        }
      }
    }
    this.decodedIndexPages.set(pageNumber, cells)
    return cells
  }

  private async indexCell(
    pageNumber: number,
    page: Uint8Array,
    header: PageHeader,
    index: number,
  ): Promise<IndexCell> {
    const cells = this.decodedCells(pageNumber, header)
    let cell = cells[index]
    if (!cell) {
      const offset = cellOffset(page, header, index)
      const interior = header.type === INTERIOR_INDEX
      const [size, afterSize] = readVarint(page, interior ? offset + 4 : offset)
      cell = {
        values: decodeRecord(await this.payload(page, afterSize, size, true)),
        leftChild: interior ? readUint32(page, offset) : 0,
      }
      cells[index] = cell
    }
    return cell
  }

  // The first cell at or past `key`, by binary search from `from`.
  private async lowerBound(
    pageNumber: number,
    page: Uint8Array,
    header: PageHeader,
    key: number[],
    from: number,
    inclusive: boolean,
  ) {
    let low = from
    let high = header.cellCount
    while (low < high) {
      const mid = (low + high) >> 1
      const cell = await this.indexCell(pageNumber, page, header, mid)
      const order = compareKey(cell.values, key)
      if (order < 0 || (inclusive && order === 0)) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    return low
  }

  // The entries from `low` on in key order, and with `high` only those up to
  // it, their pages read ahead.
  async *indexScanFrom(
    root: number,
    low: number[],
    high?: number[],
  ): AsyncGenerator<SqlValue[]> {
    const { page, header } = await this.pageAt(root)
    const first = await this.lowerBound(root, page, header, low, 0, false)
    const interior = header.type === INTERIOR_INDEX
    if (interior && high) {
      const past = await this.lowerBound(root, page, header, high, first, true)
      const children: number[] = []
      for (let c = first; c <= past; c++) {
        children.push(
          c === header.cellCount
            ? header.rightChild
            : (await this.indexCell(root, page, header, c)).leftChild,
        )
      }
      this.pager.prefetchLeading(children)
    }
    for (let i = first; i < header.cellCount; i++) {
      const cell = await this.indexCell(root, page, header, i)
      if (interior) {
        yield* this.indexScanFrom(cell.leftChild, low, high)
      }
      if (high && compareKey(cell.values, high) > 0) {
        return
      }
      yield cell.values
    }
    if (interior) {
      yield* this.indexScanFrom(header.rightChild, low, high)
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
        const cell = await this.indexCell(pageNumber, page, header, mid)
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
