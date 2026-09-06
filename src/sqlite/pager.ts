import type { ByteSource } from '../filehandle.ts'

export interface PagerOptions {
  blockSize?: number
  maxBlocks?: number
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
    let attempt = 0
    for (;;) {
      try {
        const bytes = await this.source.read(length, start)
        this.bytesFetched += bytes.length
        return bytes
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
    const cached = this.blocks.get(index)
    if (cached) {
      this.blocks.delete(index)
      this.blocks.set(index, cached)
      return cached
    }
    const start = index * this.blockSize
    const length = Math.min(this.blockSize, this.fileSize - start)
    const pending = this.read(length, start)
    this.fetches += 1
    this.blocks.set(index, pending)
    this.forgetOnFailure(pending, [index])
    this.evict()
    return pending
  }

  prefetch(pageNumbers: number[]) {
    const wanted = [
      ...new Set(
        pageNumbers.map(pageNumber =>
          Math.floor(((pageNumber - 1) * this.pageSize) / this.blockSize),
        ),
      ),
    ]
      .filter(index => !this.blocks.has(index))
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
    const indexes: number[] = []
    for (let i = 0; i < count; i++) {
      const within = i * this.blockSize
      indexes.push(firstIndex + i)
      this.blocks.set(
        firstIndex + i,
        pending.then(bytes => bytes.subarray(within, within + this.blockSize)),
      )
    }
    this.forgetOnFailure(pending, indexes)
    this.evict()
  }

  private forgetOnFailure(pending: Promise<Uint8Array>, indexes: number[]) {
    pending.catch(() => {
      for (const index of indexes) {
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
