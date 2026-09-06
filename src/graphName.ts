export interface GraphName {
  name: string | undefined
  subgraph: Map<string, Set<string>>
  translation: Map<string, Set<string>>
}

function parseRelationships(field: string | undefined, what: string) {
  const relationships = new Map<string, Set<string>>()
  if (field !== undefined) {
    for (const rel of field.split(';')) {
      const parts = rel.split(',')
      const [from, to] = parts
      if (parts.length !== 2 || !from || !to) {
        throw new Error(`Invalid ${what} relationship: ${rel}`)
      }
      let targets = relationships.get(from)
      if (!targets) {
        targets = new Set()
        relationships.set(from, targets)
      }
      targets.add(to)
    }
  }
  return relationships
}

export function graphNameFromTags(tags: Map<string, string>): GraphName {
  return {
    name: tags.get('pggname'),
    subgraph: parseRelationships(tags.get('subgraph'), 'subgraph'),
    translation: parseRelationships(tags.get('translation'), 'translation'),
  }
}

function merge(into: Map<string, Set<string>>, from: Map<string, Set<string>>) {
  for (const [key, values] of from) {
    let targets = into.get(key)
    if (!targets) {
      targets = new Set()
      into.set(key, targets)
    }
    for (const value of values) {
      targets.add(value)
    }
  }
}

export function subgraphName(name: string, parent: GraphName): GraphName {
  const result: GraphName = {
    name,
    subgraph: new Map(),
    translation: new Map(),
  }
  if (parent.name !== undefined) {
    result.subgraph.set(name, new Set([parent.name]))
    merge(result.subgraph, parent.subgraph)
    merge(result.translation, parent.translation)
  }
  return result
}

function sortedEntries(relationships: Map<string, Set<string>>) {
  return [...relationships.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([from, tos]) => [...tos].sort().map(to => [from, to] as const))
}

export function gfaHeaderLines(graphName: GraphName) {
  const lines: string[] = []
  if (graphName.name !== undefined) {
    lines.push(`H\tNM:Z:${graphName.name}`)
  }
  for (const [subgraph, supergraph] of sortedEntries(graphName.subgraph)) {
    lines.push(`H\tSG:Z:${subgraph},${supergraph}`)
  }
  for (const [from, to] of sortedEntries(graphName.translation)) {
    lines.push(`H\tTL:Z:${from},${to}`)
  }
  return lines
}

export async function sha256Hex(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}
