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

  constructor(
    private source: ByteSource,
    readonly pageSize: number,
    private fileSize: number,
    opts: PagerOptions = {},
  ) {
    const requested = opts.blockSize ?? 65536
    this.blockSize = Math.max(pageSize, Math.ceil(requested / pageSize) * pageSize)
    this.maxBlocks = opts.maxBlocks ?? 256
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
    const pending = this.source.read(length, start).then(bytes => {
      this.bytesFetched += bytes.length
      return bytes
    })
    this.fetches += 1
    this.blocks.set(index, pending)
    if (this.blocks.size > this.maxBlocks) {
      const oldest = this.blocks.keys().next().value
      if (oldest !== undefined) {
        this.blocks.delete(oldest)
      }
    }
    return pending
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
