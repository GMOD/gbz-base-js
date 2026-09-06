import { ENDMARKER, nodeId, nodeOrientation } from './gbwt/node.ts'
import { GbwtRecord, decompressEdges } from './gbwt/record.ts'
import { decodeSequence, encodedSequenceLength } from './gbwt/sequence.ts'
import { graphNameFromTags } from './graphName.ts'
import { formatPathName, pathNameFor, toPathQuery } from './pathName.ts'
import { subgraphInInterval } from './query.ts'
import { SqliteDatabase } from './sqlite/database.ts'

import type { ByteSource } from './filehandle.ts'
import type { Pos } from './gbwt/record.ts'
import type { GraphName } from './graphName.ts'
import type { PathName, PathRef } from './pathName.ts'
import type { QueryOptions } from './query.ts'
import type { PagerOptions } from './sqlite/pager.ts'
import type { SqlValue } from './sqlite/record.ts'
import type { HaplotypeAlignment, Subgraph } from './subgraph.ts'

export const SCHEMA_VERSION = 'GBZ-base version 4'

export interface PathFragment {
  path: GbzPath
  start: number
  end: number
}

export class SchemaVersionError extends Error {
  override name = 'SchemaVersionError'

  readonly found: string | undefined

  constructor(found: string | undefined) {
    super(
      found === undefined
        ? `not a gbz-base database: its Tags table has no version`
        : `unsupported database schema "${found}"; this reader understands "${SCHEMA_VERSION}"`,
    )
    this.found = found
  }
}

export interface HaplotypeSample {
  node: number
  offset: number
  pathHandle: number
  orientation: 'forward' | 'reverse'
  pathOffset: number
}

export interface GbzPath {
  handle: number
  fwStart: Pos
  revStart: Pos
  name: PathName
  isIndexed: boolean
}

export class GbzRecord {
  readonly sequenceLen: number
  readonly handle: number
  readonly edges: Pos[]
  readonly bwt: Uint8Array
  readonly encodedSequence: Uint8Array
  readonly next: number | undefined
  private decoded: string | undefined

  constructor(
    handle: number,
    edges: Pos[],
    bwt: Uint8Array,
    encodedSequence: Uint8Array,
    next: number | undefined,
  ) {
    this.handle = handle
    this.edges = edges
    this.bwt = bwt
    this.encodedSequence = encodedSequence
    this.next = next
    this.sequenceLen = encodedSequenceLength(encodedSequence)
  }

  get id() {
    return nodeId(this.handle)
  }

  get orientation() {
    return nodeOrientation(this.handle)
  }

  get sequence() {
    this.decoded ??= decodeSequence(this.encodedSequence)
    return this.decoded
  }

  successors() {
    return this.edges.filter(e => e.node !== ENDMARKER).map(e => e.node)
  }

  gbwt() {
    if (this.edges.length === 0) {
      throw new Error(`GBWT record for handle ${this.handle} is empty`)
    }
    return new GbwtRecord(this.edges, this.bwt)
  }
}

function num(value: SqlValue | undefined, what: string) {
  if (typeof value !== 'number') {
    throw new Error(`${what} is not a number in the database`)
  }
  return value
}

function str(value: SqlValue | undefined, what: string) {
  if (typeof value !== 'string') {
    throw new Error(`${what} is not text in the database`)
  }
  return value
}

function blob(value: SqlValue | undefined, what: string) {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${what} is not a blob in the database`)
  }
  return value
}

function rowToPath(rowid: number, values: SqlValue[]): GbzPath {
  return {
    handle: rowid,
    fwStart: {
      node: num(values[1], 'Paths.fw_node'),
      offset: num(values[2], 'Paths.fw_offset'),
    },
    revStart: {
      node: num(values[3], 'Paths.rev_node'),
      offset: num(values[4], 'Paths.rev_offset'),
    },
    name: {
      sample: str(values[5], 'Paths.sample'),
      contig: str(values[6], 'Paths.contig'),
      haplotype: num(values[7], 'Paths.haplotype'),
      fragment: num(values[8], 'Paths.fragment'),
    },
    isIndexed: num(values[9], 'Paths.is_indexed') !== 0,
  }
}

export interface OpenOptions extends PagerOptions {
  haplotypeIndex?: ByteSource
}

async function readTags(sqlite: SqliteDatabase) {
  const tags = new Map<string, string>()
  for await (const { values } of sqlite.scan('Tags')) {
    tags.set(str(values[0], 'Tags.key'), str(values[1], 'Tags.value'))
  }
  return tags
}

export class GBZBase {
  private tagCache: Promise<Map<string, string>> | undefined
  private pathCache: Promise<GbzPath[]> | undefined
  private indexTags: Map<string, string> | undefined

  readonly sqlite: SqliteDatabase
  readonly index: SqliteDatabase

  private constructor(sqlite: SqliteDatabase, index: SqliteDatabase) {
    this.sqlite = sqlite
    this.index = index
  }

  static async open(source: ByteSource, opts: OpenOptions = {}) {
    const { haplotypeIndex, ...pagerOptions } = opts
    const sqlite = await SqliteDatabase.open(source, pagerOptions)
    for (const table of ['Tags', 'Nodes', 'Paths', 'ReferenceIndex']) {
      sqlite.rootPage(table)
    }
    const index = haplotypeIndex
      ? await SqliteDatabase.open(haplotypeIndex, pagerOptions)
      : sqlite
    const db = new GBZBase(sqlite, index)
    const version = await db.tag('version')
    if (version !== SCHEMA_VERSION) {
      throw new SchemaVersionError(version)
    }
    if (haplotypeIndex) {
      for (const table of ['Tags', 'HaplotypeSamples', 'HaplotypeLengths']) {
        index.rootPage(table)
      }
      db.indexTags = await readTags(index)
      const indexed = db.indexTags.get('haplotype_index_paths')
      const paths = await db.tag('paths')
      if (indexed !== paths) {
        throw new Error(
          `haplotype index was built for ${indexed ?? 'an unknown number of'} paths but the graph has ${paths}`,
        )
      }
      const indexedNodes = db.indexTags.get('haplotype_index_nodes')
      const nodes = await db.tag('nodes')
      if (indexedNodes !== undefined && indexedNodes !== nodes) {
        throw new Error(
          `haplotype index was built for a graph with ${indexedNodes} nodes but this one has ${nodes}`,
        )
      }
    }
    return db
  }

  tags() {
    this.tagCache ??= readTags(this.sqlite)
    return this.tagCache
  }

  async tag(key: string) {
    return (await this.tags()).get(key)
  }

  async getRecord(handle: number) {
    const row = await this.sqlite.byRowid('Nodes', handle)
    if (!row) {
      return undefined
    }
    const next = row[4]
    return new GbzRecord(
      handle,
      decompressEdges(blob(row[1], 'Nodes.edges')),
      blob(row[2], 'Nodes.bwt'),
      blob(row[3], 'Nodes.sequence'),
      typeof next === 'number' ? next : undefined,
    )
  }

  paths() {
    this.pathCache ??= (async () => {
      const paths: GbzPath[] = []
      for await (const { rowid, values } of this.sqlite.scan('Paths')) {
        paths.push(rowToPath(rowid, values))
      }
      return paths
    })()
    return this.pathCache
  }

  async getPath(handle: number) {
    const row = await this.sqlite.byRowid('Paths', handle)
    return row ? rowToPath(handle, row) : undefined
  }

  async findPath(name: PathName) {
    const candidates = (await this.paths()).filter(
      p =>
        p.name.sample === name.sample &&
        p.name.contig === name.contig &&
        p.name.haplotype === name.haplotype &&
        p.name.fragment <= name.fragment,
    )
    return candidates.sort((a, b) => b.name.fragment - a.name.fragment)[0]
  }

  async pathsForSample(sample: string) {
    return (await this.paths()).filter(p => p.name.sample === sample)
  }

  private async pathsNamed(ref: PathRef) {
    const name = pathNameFor(toPathQuery(ref), 0)
    return (await this.paths())
      .filter(
        p =>
          p.name.sample === name.sample &&
          p.name.contig === name.contig &&
          p.name.haplotype === name.haplotype,
      )
      .sort((a, b) => a.name.fragment - b.name.fragment)
  }

  async hasPath(ref: PathRef) {
    return (await this.pathsNamed(ref)).length > 0
  }

  private pathLengths = new Map<number, Promise<number>>()

  pathLength(handle: number) {
    let length = this.pathLengths.get(handle)
    if (!length) {
      length = this.walkPathLength(handle)
      this.pathLengths.set(handle, length)
      length.catch(() => this.pathLengths.delete(handle))
    }
    return length
  }

  private async walkPathLength(handle: number) {
    const indexed = this.hasHaplotypeIndex
      ? await this.haplotypeLength(handle)
      : undefined
    if (indexed === undefined) {
      const last = await this.indexedPosition(handle, Number.MAX_SAFE_INTEGER)
      if (!last) {
        const path = await this.getPath(handle)
        throw new Error(
          `Path ${path ? formatPathName(path.name, path.name.fragment) : handle} has not been indexed for random access`,
        )
      }
      let length = last.pathOffset
      let pos = last.pos
      for (;;) {
        const record = await this.getRecord(pos.node)
        if (!record) {
          throw new Error(`Node ${pos.node} does not exist in the graph`)
        }
        length += record.sequenceLen
        const next = record.gbwt().lf(pos.offset)
        if (!next || next.node === ENDMARKER) {
          return length
        }
        pos = next
      }
    }
    return indexed
  }

  async pathFragmentsForRange(
    ref: PathRef,
    start: number,
    end: number,
  ): Promise<PathFragment[]> {
    if (end <= start) {
      return []
    }
    const ordered = await this.pathsNamed(ref)
    const covering = ordered.filter(p => p.name.fragment <= start).slice(-1)
    const within = ordered.filter(
      p => p.name.fragment > start && p.name.fragment < end,
    )
    const fragments = await Promise.all(
      [...covering, ...within].map(async path => ({
        path,
        start: path.name.fragment,
        end: path.name.fragment + (await this.pathLength(path.handle)),
      })),
    )
    return fragments.filter(f => start < f.end)
  }

  private async subgraphForFragment(
    fragment: PathFragment,
    start: number,
    end: number,
    opts: QueryOptions,
  ) {
    const lo = Math.max(start, fragment.start)
    const hi = Math.min(end, fragment.end)
    let subgraph: Subgraph | undefined
    if (hi > lo) {
      const { sample, contig, haplotype } = fragment.path.name
      subgraph = await subgraphInInterval(
        this,
        { sample, contig, haplotype },
        lo,
        hi,
        opts,
      )
      const haplotypes = opts.haplotypes ?? 'all'
      const named = haplotypes === 'all' || haplotypes === 'distinct'
      if (this.hasHaplotypeIndex && named) {
        await subgraph.identifyPaths()
      }
    }
    return subgraph
  }

  async getSubgraphForRange(
    ref: PathRef,
    start: number,
    end: number,
    opts: QueryOptions = {},
  ) {
    const [fragment] = await this.pathFragmentsForRange(ref, start, end)
    return fragment
      ? this.subgraphForFragment(fragment, start, end, opts)
      : undefined
  }

  async getAlignmentsForRange(
    ref: PathRef,
    start: number,
    end: number,
    opts: QueryOptions = {},
  ) {
    const result: HaplotypeAlignment[] = []
    for (const fragment of await this.pathFragmentsForRange(ref, start, end)) {
      const subgraph = await this.subgraphForFragment(
        fragment,
        start,
        end,
        opts,
      )
      if (subgraph) {
        result.push(...subgraph.alignments())
      }
    }
    return result
  }

  async graphName() {
    const gbzTags = new Map<string, string>()
    for (const [key, value] of await this.tags()) {
      if (key.startsWith('gbz_')) {
        gbzTags.set(key.slice('gbz_'.length), value)
      }
    }
    let name: GraphName = {
      name: undefined,
      subgraph: new Map(),
      translation: new Map(),
    }
    try {
      name = graphNameFromTags(gbzTags)
    } catch {
      // upstream falls back to an empty name when the tags do not parse
    }
    return name
  }

  async hasChainLinks() {
    const links = await this.tag('chain_links')
    return links !== undefined && Number(links) > 0
  }

  get hasHaplotypeIndex() {
    return (
      this.index.has('HaplotypeSamples') && this.index.has('HaplotypeLengths')
    )
  }

  async haplotypeSampleInterval() {
    const value = this.indexTags
      ? this.indexTags.get('haplotype_index_interval')
      : await this.tag('haplotype_index_interval')
    return value === undefined ? undefined : Number(value)
  }

  private sampleFromRow(values: SqlValue[]): HaplotypeSample {
    return {
      node: num(values[0], 'HaplotypeSamples.node_handle'),
      offset: num(values[1], 'HaplotypeSamples.node_offset'),
      pathHandle: num(values[2], 'HaplotypeSamples.path_handle'),
      orientation:
        num(values[3], 'HaplotypeSamples.orientation') === 0
          ? 'forward'
          : 'reverse',
      pathOffset: num(values[4], 'HaplotypeSamples.path_offset'),
    }
  }

  async haplotypeSamplesInRange(minHandle: number, maxHandle: number) {
    const samples: HaplotypeSample[] = []
    for await (const key of this.index.indexScanFrom('HaplotypeSamples', [
      minHandle,
      0,
    ])) {
      const node = num(key[0], 'HaplotypeSamples.node_handle')
      if (node > maxHandle) {
        break
      }
      const row = await this.index.byRowid(
        'HaplotypeSamples',
        num(key[2], 'HaplotypeSamples rowid'),
      )
      if (row) {
        samples.push(this.sampleFromRow(row))
      }
    }
    return samples
  }

  async haplotypeSampleAt(node: number, offset: number) {
    const key = await this.index.indexSeekLE('HaplotypeSamples', [node, offset])
    if (key?.[0] !== node || key[1] !== offset) {
      return undefined
    }
    const row = await this.index.byRowid(
      'HaplotypeSamples',
      num(key[2], 'HaplotypeSamples rowid'),
    )
    return row ? this.sampleFromRow(row) : undefined
  }

  async haplotypeLength(pathHandle: number) {
    const row = await this.index.byRowid('HaplotypeLengths', pathHandle)
    return row ? num(row[1], 'HaplotypeLengths.length') : undefined
  }

  async indexedPosition(
    pathHandle: number,
    pathOffset: number,
  ): Promise<{ pathOffset: number; pos: Pos } | undefined> {
    const key = await this.sqlite.indexSeekLE('ReferenceIndex', [
      pathHandle,
      pathOffset,
    ])
    if (key?.[0] !== pathHandle) {
      return undefined
    }
    const row = await this.sqlite.byRowid(
      'ReferenceIndex',
      num(key[2], 'ReferenceIndex rowid'),
    )
    if (!row) {
      throw new Error('ReferenceIndex row referenced by its index is missing')
    }
    return {
      pathOffset: num(row[1], 'ReferenceIndex.path_offset'),
      pos: {
        node: num(row[2], 'ReferenceIndex.node_handle'),
        offset: num(row[3], 'ReferenceIndex.node_offset'),
      },
    }
  }
}
