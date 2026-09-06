export class ByteCodeReader {
  offset = 0
  private bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get done() {
    return this.offset >= this.bytes.length
  }

  byte() {
    const value = this.bytes[this.offset]
    if (value === undefined) {
      return undefined
    }
    this.offset += 1
    return value
  }

  int() {
    let shift = 1
    let result = 0
    while (this.offset < this.bytes.length) {
      const value = this.bytes[this.offset]!
      this.offset += 1
      result += (value & 0x7f) * shift
      shift *= 128
      if ((value & 0x80) === 0) {
        return result
      }
    }
    return undefined
  }
}

export interface Run {
  value: number
  len: number
}

const RLE_THRESHOLD = 255
const RLE_UNIVERSE = 256

export class RunReader {
  private source: ByteCodeReader
  private sigma: number
  private threshold: number

  constructor(bytes: Uint8Array, sigma: number) {
    this.source = new ByteCodeReader(bytes)
    this.sigma = sigma === 0 ? Number.MAX_SAFE_INTEGER : sigma
    this.threshold =
      this.sigma < RLE_THRESHOLD ? Math.floor(RLE_UNIVERSE / this.sigma) : 0
  }

  next(): Run | undefined {
    if (this.sigma >= RLE_THRESHOLD) {
      const value = this.source.int()
      const len = this.source.int()
      return value === undefined || len === undefined
        ? undefined
        : { value, len: len + 1 }
    }
    const byte = this.source.byte()
    if (byte === undefined) {
      return undefined
    }
    const value = byte % this.sigma
    let len = Math.floor(byte / this.sigma) + 1
    if (len === this.threshold) {
      const extra = this.source.int()
      if (extra === undefined) {
        return undefined
      }
      len += extra
    }
    return { value, len }
  }

  *[Symbol.iterator]() {
    for (let run = this.next(); run !== undefined; run = this.next()) {
      yield run
    }
  }
}
