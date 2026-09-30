export type Step = [id: number, isReverse: boolean]

export interface GfaPath {
  sample: string
  haplotype: number
  contig: string
  fragment: number
  length: number
  ids: number[]
  reverse: boolean[]
  offsets: number[]
}

export interface Gfa {
  referenceSamples: string[]
  nodeLengths: Map<number, number>
  paths: GfaPath[]
}

export interface Piece {
  sample: string
  haplotype: number
  contig: string
  fragment: number
  hapStart: number
  hapEnd: number
  nodes: Step[]
}

function edgeKey(
  from: number,
  fromReverse: boolean,
  to: number,
  toReverse: boolean,
) {
  const forward = `${from}${fromReverse ? '-' : '+'}${to}${toReverse ? '-' : '+'}`
  const flipped = `${to}${toReverse ? '+' : '-'}${from}${fromReverse ? '+' : '-'}`
  return forward < flipped ? forward : flipped
}

function integer(text: string | undefined, what: string, line: number) {
  if (text === undefined || !/^\d+$/.test(text)) {
    throw new Error(`GFA line ${line}: ${what} "${text}" is not an integer`)
  }
  return Number(text)
}

// Reads the S, L and W lines of a GFA and rejects one whose W coordinates,
// steps or edges disagree, so a generator bug fails here and not as a mismatch.
export function parseGfa(text: string): Gfa {
  const nodeLengths = new Map<number, number>()
  const edges = new Set<string>()
  const walks: { fields: string[]; line: number }[] = []
  let referenceSamples: string[] = []
  text.split('\n').forEach((row, index) => {
    const line = index + 1
    const fields = row.split('\t')
    if (fields[0] === 'H') {
      const tag = fields.find(f => f.startsWith('RS:Z:'))
      if (tag) {
        referenceSamples = tag.slice(5).split(' ')
      }
    } else if (fields[0] === 'S') {
      nodeLengths.set(integer(fields[1], 'segment', line), fields[2]!.length)
    } else if (fields[0] === 'L') {
      edges.add(
        edgeKey(
          integer(fields[1], 'segment', line),
          fields[2] === '-',
          integer(fields[3], 'segment', line),
          fields[4] === '-',
        ),
      )
    } else if (fields[0] === 'W') {
      walks.push({ fields, line })
    }
  })
  const names = new Set<string>()
  const paths = walks.map(({ fields, line }) => {
    const [, sample, haplotype, contig, start, end, walk] = fields
    const fragment = integer(start, 'start', line)
    const ids: number[] = []
    const reverse: boolean[] = []
    const offsets: number[] = []
    let length = 0
    for (const [, direction, id] of walk!.matchAll(/([<>])(\d+)/g)) {
      const nodeLength = nodeLengths.get(Number(id))
      if (nodeLength === undefined) {
        throw new Error(`GFA line ${line}: walk visits missing segment ${id}`)
      }
      const last = ids.length - 1
      if (
        last >= 0 &&
        !edges.has(
          edgeKey(ids[last]!, reverse[last]!, Number(id), direction === '<'),
        )
      ) {
        throw new Error(
          `GFA line ${line}: no L line joins ${ids[last]} and ${id}`,
        )
      }
      ids.push(Number(id))
      reverse.push(direction === '<')
      offsets.push(length)
      length += nodeLength
    }
    if (ids.length === 0) {
      throw new Error(`GFA line ${line}: empty walk`)
    }
    if (integer(end, 'end', line) - fragment !== length) {
      throw new Error(
        `GFA line ${line}: ${start}-${end} does not span the walk's ${length} bp`,
      )
    }
    const name = `${sample}#${haplotype}#${contig}@${fragment}`
    if (names.has(name)) {
      throw new Error(`GFA line ${line}: second walk named ${name}`)
    }
    names.add(name)
    return {
      sample: sample!,
      haplotype: integer(haplotype, 'haplotype', line),
      contig: contig!,
      fragment,
      length,
      ids,
      reverse,
      offsets,
    }
  })
  return { referenceSamples, nodeLengths, paths }
}

// Every maximal run of consecutive steps of each path on the given nodes.
export function piecesIn(gfa: Gfa, nodes: Set<number>) {
  const pieces: Piece[] = []
  for (const path of gfa.paths) {
    const { ids, reverse, offsets } = path
    let first = -1
    for (let i = 0; i <= ids.length; i++) {
      const inside = i < ids.length && nodes.has(ids[i]!)
      if (inside && first < 0) {
        first = i
      } else if (!inside && first >= 0) {
        const steps: Step[] = []
        for (let k = first; k < i; k++) {
          steps.push([ids[k]!, reverse[k]!])
        }
        pieces.push({
          sample: path.sample,
          haplotype: path.haplotype,
          contig: path.contig,
          fragment: path.fragment,
          hapStart: offsets[first]!,
          hapEnd: i < ids.length ? offsets[i]! : path.length,
          nodes: steps,
        })
        first = -1
      }
    }
  }
  return pieces
}
