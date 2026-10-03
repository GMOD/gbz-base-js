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

// Blocks a reader asked for ahead of time, fetched in chunks as its reads
// approach the end of what has been fetched.
interface Plan {
  blocks: number[]
  position: Map<number, number>
  next: number
}

export class Pager {
  private blocks = new Map<number, Promise<Uint8Array>>()
  private readonly blockSize: number
  private readonly maxBlocks: number
  private plan: Plan | undefined
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
    this.follow(index)
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

  private get chunk() {
    return Math.max(1, Math.floor(this.prefetchBudget / 2))
  }

  // Fetches the pages' blocks when they fit the budget together.
  prefetch(pageNumbers: number[]) {
    const indexes = new Set(pageNumbers.map(n => this.blockOf(n)))
    if (indexes.size > this.prefetchBudget) {
      return false
    }
    this.fetchBlocks(indexes)
    return true
  }

  // Fetches the first pages' blocks now, up to the budget, and plans the rest
  // in the pages' order, to be fetched chunk by chunk as reads approach them.
  prefetchLeading(pageNumbers: number[]) {
    const blocks: number[] = []
    const position = new Map<number, number>()
    for (const pageNumber of pageNumbers) {
      const index = this.blockOf(pageNumber)
      if (!position.has(index)) {
        position.set(index, blocks.length)
        blocks.push(index)
      }
    }
    this.plan = { blocks, position, next: 0 }
    this.advance(this.prefetchBudget)
  }

  private advance(count: number) {
    const plan = this.plan
    if (!plan) {
      return
    }
    const slice = plan.blocks.slice(plan.next, plan.next + count)
    plan.next += slice.length
    if (plan.next >= plan.blocks.length) {
      this.plan = undefined
    }
    this.fetchBlocks(new Set(slice))
  }

  // A read within half a chunk of the end of the fetched part of the plan
  // brings in the next chunk.
  private follow(index: number) {
    const plan = this.plan
    const at = plan?.position.get(index)
    if (plan && at !== undefined && at >= plan.next - Math.ceil(this.chunk / 2)) {
      this.advance(this.chunk)
    }
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
