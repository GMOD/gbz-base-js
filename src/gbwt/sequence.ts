const DECODE = ['', 'A', 'C', 'G', 'T', 'N']

export function encodedSequenceLength(encoded: Uint8Array) {
  const last = encoded[encoded.length - 1]
  if (last === undefined) {
    return 0
  }
  let value = last
  let inLast = 0
  for (let i = 0; i < 3; i++) {
    if (value % 6 === 0) {
      break
    }
    value = Math.floor(value / 6)
    inLast += 1
  }
  return 3 * (encoded.length - 1) + inLast
}

export function decodeSequence(encoded: Uint8Array) {
  let result = ''
  for (const byte of encoded) {
    let value = byte
    for (let i = 0; i < 3; i++) {
      const base = DECODE[value % 6] as string
      if (base === '') {
        return result
      }
      value = Math.floor(value / 6)
      result += base
    }
  }
  return result
}

const COMPLEMENT: Record<string, string> = { A: 'T', C: 'G', G: 'C', T: 'A', N: 'N' }

export function reverseComplement(sequence: string) {
  let result = ''
  for (let i = sequence.length - 1; i >= 0; i--) {
    result += COMPLEMENT[sequence[i] as string] ?? 'N'
  }
  return result
}
