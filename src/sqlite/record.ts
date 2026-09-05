export type SqlValue = null | number | string | Uint8Array

export function readVarint(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let value = 0
  for (let i = 0; i < 8; i++) {
    const byte = bytes[offset + i]
    if (byte === undefined) {
      throw new Error('SQLite varint runs past the end of the buffer')
    }
    value = value * 128 + (byte & 0x7f)
    if ((byte & 0x80) === 0) {
      return [value, offset + i + 1]
    }
  }
  const last = bytes[offset + 8]
  if (last === undefined) {
    throw new Error('SQLite varint runs past the end of the buffer')
  }
  value = value * 256 + last
  if (!Number.isSafeInteger(value)) {
    throw new Error('SQLite varint exceeds the safe integer range')
  }
  return [value, offset + 9]
}

function readSignedInt(view: DataView, offset: number, width: number) {
  switch (width) {
    case 1:
      return view.getInt8(offset)
    case 2:
      return view.getInt16(offset)
    case 3:
      return (view.getInt8(offset) << 16) | view.getUint16(offset + 1)
    case 4:
      return view.getInt32(offset)
    case 6:
      return view.getInt16(offset) * 4294967296 + view.getUint32(offset + 2)
    default: {
      const big = view.getBigInt64(offset)
      if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new Error(`SQLite integer ${big} exceeds the safe integer range`)
      }
      return Number(big)
    }
  }
}

const decoder = new TextDecoder()

export function decodeRecord(payload: Uint8Array): SqlValue[] {
  const [headerSize, firstType] = readVarint(payload, 0)
  const types: number[] = []
  let offset = firstType
  while (offset < headerSize) {
    const [type, next] = readVarint(payload, offset)
    types.push(type)
    offset = next
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  let body = headerSize
  return types.map(type => {
    if (type === 0) {
      return null
    }
    if (type >= 1 && type <= 6) {
      const width = type <= 4 ? type : type === 5 ? 6 : 8
      const value = readSignedInt(view, body, width)
      body += width
      return value
    }
    if (type === 7) {
      const value = view.getFloat64(body)
      body += 8
      return value
    }
    if (type === 8) {
      return 0
    }
    if (type === 9) {
      return 1
    }
    if (type >= 12) {
      const length = (type - 12) >> 1
      const slice = payload.subarray(body, body + length)
      body += length
      return type % 2 === 0 ? slice : decoder.decode(slice)
    }
    throw new Error(`SQLite serial type ${type} is reserved`)
  })
}
