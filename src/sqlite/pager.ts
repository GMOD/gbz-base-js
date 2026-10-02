import type { ByteSource } from '../filehandle.ts'

export interface PagerOptions {
  blockSize?: number | undefined
  maxBlocks?: number | undefined
}

export function checkPagerOptions({ blockSize, maxBlocks }: PagerOptions) {
  if (
    blockSize !== undefined &&
    !(Number.isSafeInteger(blockSize) && blockSize > 0)
  ) {
    throw new Error(`blockSize must be a positive integer, not ${blockSize}`)
  }
  if (
    maxBlocks !== undefined &&
    !(Number.isSafeInteger(maxBlocks) && maxBlocks > 0)
  ) {
    throw new Error(`maxBlocks must be a positive integer, not ${maxBlocks}`)
  }
}

export class Pager {
  private blocks = new Map<number, Promise<Uint8Array>>()
  private readonly blockSize: number
  private readonly maxBlocks: number
  bytesFetched = 0
  fetches = 0

  private source: ByteSource
  readonly pageSize: number
  private fileSize: number

  constructor(
    source: ByteSource,
    pageSize: number,
    fileSize: number,
    opts: PagerOptions = {},
  ) {
    this.source = source
    this.pageSize = pageSize
    this.fileSize = fileSize
    const requested = opts.blockSize ?? 65536
    this.blockSize = Math.max(
      pageSize,
      Math.ceil(requested / pageSize) * pageSize,
    )
    this.maxBlocks = opts.maxBlocks ?? 256
  }

  private async read(length: number, start: number) {
    const bytes = await this.readRetrying(length, start)
    this.bytesFetched += bytes.length
    if (bytes.length < length) {
      throw new Error(
        `the file ends at byte ${start + bytes.length}, short of the ${this.fileSize} bytes its SQLite header gives`,
      )
    }
    return bytes
  }

  private async readRetrying(length: number, start: number) {
    let attempt = 0
    for (;;) {
      try {
        return await this.source.read(length, start)
      } catch (error) {
        attempt += 1
        if (attempt >= 3) {
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, 200 * attempt))
      }
    }
  }

  seed(index: number, bytes: Uint8Array) {
    if (
      bytes.length ===
      Math.min(this.blockSize, this.fileSize - index * this.blockSize)
    ) {
      this.blocks.set(index, Promise.resolve(bytes))
    }
  }

  private block(index: number) {
    const cached = this.touch(index)
    if (cached) {
      return cached
    }
    const start = index * this.blockSize
    const length = Math.min(this.blockSize, this.fileSize - start)
    const pending = this.read(length, start)
    this.fetches += 1
    this.store(index, pending)
    this.evict()
    return pending
  }

  private touch(index: number) {
    const cached = this.blocks.get(index)
    if (cached) {
      this.blocks.delete(index)
      this.blocks.set(index, cached)
    }
    return cached
  }

  private blockOf(pageNumber: number) {
    return Math.floor(((pageNumber - 1) * this.pageSize) / this.blockSize)
  }

  // half the cache, so a prefetch cannot evict its own blocks
  private get prefetchBudget() {
    return Math.max(1, Math.floor(this.maxBlocks / 2))
  }

  prefetch(pageNumbers: number[]) {
    const indexes = new Set(pageNumbers.map(n => this.blockOf(n)))
    if (indexes.size > this.prefetchBudget) {
      return false
    }
    this.fetchBlocks(indexes)
    return true
  }

  prefetchLeading(pageNumbers: number[]) {
    const indexes = new Set<number>()
    let count = 0
    for (const pageNumber of pageNumbers) {
      const index = this.blockOf(pageNumber)
      if (!indexes.has(index) && indexes.size === this.prefetchBudget) {
        break
      }
      indexes.add(index)
      count += 1
    }
    this.fetchBlocks(indexes)
    return count
  }

  private fetchBlocks(indexes: Set<number>) {
    const wanted = [...indexes]
      .filter(index => !this.touch(index))
      .sort((a, b) => a - b)
    let runStart = 0
    while (runStart < wanted.length) {
      let runEnd = runStart + 1
      while (
        runEnd < wanted.length &&
        wanted[runEnd] === wanted[runEnd - 1]! + 1
      ) {
        runEnd += 1
      }
      this.fetchRun(wanted[runStart]!, runEnd - runStart)
      runStart = runEnd
    }
  }

  private fetchRun(firstIndex: number, count: number) {
    const start = firstIndex * this.blockSize
    const length = Math.min(count * this.blockSize, this.fileSize - start)
    const pending = this.read(length, start)
    this.fetches += 1
    for (let i = 0; i < count; i++) {
      const within = i * this.blockSize
      this.store(
        firstIndex + i,
        pending.then(bytes => bytes.subarray(within, within + this.blockSize)),
      )
    }
    this.evict()
  }

  private store(index: number, block: Promise<Uint8Array>) {
    this.blocks.set(index, block)
    block.catch(() => {
      if (this.blocks.get(index) === block) {
        this.blocks.delete(index)
      }
    })
  }

  private evict() {
    while (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.blocks.delete(oldest)
    }
  }

  async page(pageNumber: number) {
    const offset = (pageNumber - 1) * this.pageSize
    if (pageNumber < 1 || offset + this.pageSize > this.fileSize) {
      throw new Error(`SQLite page ${pageNumber} is outside the file`)
    }
    const bytes = await this.block(Math.floor(offset / this.blockSize))
    const within = offset % this.blockSize
    return bytes.subarray(within, within + this.pageSize)
  }
}
