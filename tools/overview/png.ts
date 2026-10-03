// A minimal PNG writer: 8-bit RGB, no dependencies beyond zlib.
import { deflateSync } from 'node:zlib'

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return c >>> 0
})

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(Buffer.from(type, 'latin1'), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

export class Canvas {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array

  constructor(width: number, height: number, fill = [255, 255, 255]) {
    this.width = width
    this.height = height
    this.pixels = new Uint8Array(width * height * 3)
    for (let i = 0; i < width * height; i++) {
      this.pixels.set(fill, i * 3)
    }
  }

  fill(x0: number, y0: number, x1: number, y1: number, rgb: number[]) {
    const left = Math.max(0, Math.floor(x0))
    const right = Math.min(this.width, Math.ceil(x1))
    const top = Math.max(0, Math.floor(y0))
    const bottom = Math.min(this.height, Math.ceil(y1))
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        this.pixels.set(rgb, (y * this.width + x) * 3)
      }
    }
  }

  png() {
    const stride = this.width * 3
    const raw = new Uint8Array((stride + 1) * this.height)
    for (let y = 0; y < this.height; y++) {
      raw[y * (stride + 1)] = 0
      raw.set(
        this.pixels.subarray(y * stride, (y + 1) * stride),
        y * (stride + 1) + 1,
      )
    }
    const header = new Uint8Array(13)
    const view = new DataView(header.buffer)
    view.setUint32(0, this.width)
    view.setUint32(4, this.height)
    header.set([8, 2, 0, 0, 0], 8)
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array()),
    ])
  }
}

// Glyphs for the few characters an axis label needs, 3 columns by 5 rows.
const GLYPHS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  '.': [0, 0, 0, 0, 2],
  ',': [0, 0, 0, 2, 4],
  ' ': [0, 0, 0, 0, 0],
  M: [5, 7, 7, 5, 5],
  k: [4, 4, 5, 6, 5],
  b: [4, 4, 7, 5, 7],
  c: [0, 7, 4, 4, 7],
  h: [4, 4, 7, 5, 5],
  r: [0, 7, 4, 4, 4],
  ':': [0, 2, 0, 2, 0],
  '-': [0, 0, 7, 0, 0],
  '#': [5, 7, 5, 7, 5],
  '%': [5, 1, 2, 4, 5],
  x: [0, 5, 2, 2, 5],
  a: [0, 7, 1, 7, 7],
  p: [0, 7, 5, 7, 4],
  s: [0, 7, 4, 1, 7],
  e: [0, 7, 7, 4, 7],
  t: [2, 7, 2, 2, 3],
  l: [2, 2, 2, 2, 3],
  i: [2, 0, 2, 2, 2],
  n: [0, 7, 5, 5, 5],
  m: [0, 5, 7, 7, 5],
  j: [1, 0, 1, 1, 6],
  z: [0, 7, 1, 2, 7],
  L: [4, 4, 4, 4, 7],
  S: [7, 4, 7, 1, 7],
  T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7],
  E: [7, 4, 7, 4, 7],
  D: [6, 5, 5, 5, 6],
  P: [7, 5, 7, 4, 4],
  O: [7, 5, 5, 5, 7],
  F: [7, 4, 7, 4, 4],
  W: [5, 5, 7, 7, 5],
  X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2],
  Z: [7, 1, 2, 4, 7],
  J: [1, 1, 1, 5, 7],
  Q: [7, 5, 5, 7, 1],
  o: [0, 7, 5, 5, 7],
  u: [0, 5, 5, 5, 7],
  v: [0, 5, 5, 5, 2],
  y: [0, 5, 5, 7, 1],
  q: [0, 7, 5, 7, 1],
  d: [1, 1, 7, 5, 7],
  g: [0, 7, 5, 7, 1],
  f: [3, 2, 7, 2, 2],
  w: [0, 5, 5, 7, 7],
  B: [6, 5, 6, 5, 6],
  G: [7, 4, 5, 5, 7],
  H: [5, 5, 7, 5, 5],
  R: [6, 5, 6, 5, 5],
  C: [7, 4, 4, 4, 7],
  N: [5, 7, 7, 7, 5],
  A: [2, 5, 7, 5, 5],
  K: [5, 5, 6, 5, 5],
  I: [7, 2, 2, 2, 7],
  V: [5, 5, 5, 5, 2],
  '(': [1, 2, 2, 2, 1],
  ')': [4, 2, 2, 2, 4],
  '/': [1, 1, 2, 4, 4],
  '+': [0, 2, 7, 2, 0],
  '=': [0, 7, 0, 7, 0],
}

export function text(
  canvas: Canvas,
  x: number,
  y: number,
  message: string,
  rgb = [40, 40, 40],
  scale = 2,
) {
  let at = x
  for (const char of message) {
    const glyph = GLYPHS[char] ?? GLYPHS[char.toLowerCase()] ?? [7, 5, 5, 5, 7]
    glyph.forEach((row, r) => {
      for (let c = 0; c < 3; c++) {
        if (row & (4 >> c)) {
          canvas.fill(
            at + c * scale,
            y + r * scale,
            at + (c + 1) * scale,
            y + (r + 1) * scale,
            rgb,
          )
        }
      }
    })
    at += 4 * scale
  }
  return at
}
