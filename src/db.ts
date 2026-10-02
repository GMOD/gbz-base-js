import { ENDMARKER, nodeId, nodeOrientation } from './gbwt/node.ts'
import { GbwtRecord, decompressEdges } from './gbwt/record.ts'
import { decodeSequence, encodedSequenceLength } from './gbwt/sequence.ts'
import { graphNameFromTags } from './graphName.ts'
import { formatPathName, pathNameFor, toPathQuery } from './pathName.ts'
import {
  subgraphAroundNodes,
  subgraphAtOffset,
  subgraphBetween,
  subgraphInInterval,
} from './query.ts'
import { SqliteDatabase } from './sqlite/database.ts'
import { SubgraphLimitError } from './subgraph.ts'

import type { ByteSource } from './filehandle.ts'
import type { Pos } from './gbwt/record.ts'
import type { GraphName } from './graphName.ts'
import type { PathName, PathRef } from './pathName.ts'
import type {
  BetweenQuery,
  IntervalQuery,
  NodesQuery,
  OffsetQuery,
  PathWindow,
} from './query.ts'
import type { PagerOptions } from './sqlite/pager.ts'
import type { SqlValue } from './sqlite/record.ts'
import type { HaplotypeAlignment, Subgraph } from './subgraph.ts'

export const SCHEMA_VERSION = 'GBZ-base version 4'

export interface PathFragment {
  path: GbzPath
  start: number
  end: number
}

export type WindowQuery = IntervalQuery

export interface AlignmentQuery extends Omit<
  WindowQuery,
  'haplotypes' | 'snarls'
> {
  haplotypes?: 'all' | 'distinct' | undefined
}

export class UnknownPathError extends Error {
  override name = 'UnknownPathError'

  readonly path: PathName

  constructor(path: PathName) {
    super(`the graph has no path named ${formatPathName(path)}`)
    this.path = path
  }
}

export class ForwardOnlyIndexError extends Error {
  override name = 'ForwardOnlyIndexError'

  constructor() {
    super(
      'the haplotype index was written with --forward-only, which cannot name the walks stored against their reference (about half of them); rebuild it with gbz-haplotype-index without --forward-only',
    )
  }
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

export interface IndexedPosition {
  pathOffset: number
  pos: Pos
}

export interface HaplotypeSample {
  node: number
  offset: number
  pathHandle: number
  orientation: 'forward' | 'reverse'
  pathOffset: number
}

export interface HaplotypeAnchor {
  node: number
  pathOffset: number
}

// A row of HaplotypeStrays: a stretch of one path, from pathStart to the visit
// at pathEnd, holding visits to nodes of one bin that the walks from anchor
// visits can miss. `node` and `offset` are the GBWT position of its first
// visit in the path's forward orientation. A row with a snarl names a path
// that lies between those two boundary nodes from end to end.
export interface HaplotypeStray {
  bin: number
  pathHandle: number
  pathStart: number
  pathEnd: number
  snarl: [number, number] | undefined
  node: number
  offset: number
}

export interface HaplotypeStrayOptions {
  // The largest query context the rows cover.
  context: number
  bin: number
  bound: number
  // The most nodes between a filled snarl's boundaries for the rows to cover
  // it, or undefined when the rows leave snarls out.
  snarlNodes: number | undefined
}

export interface GbzPath {
  handle: number
  /** @internal */
  fwStart: Pos
  /** @internal */
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

export interface OpenOptions {
  source: ByteSource
  haplotypeIndex?: ByteSource | undefined
  blockSize?: number | undefined
  maxBlocks?: number | undefined
}

export interface FetchStats {
  fetches: number
  bytesFetched: number
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
  private pathMapCache: Promise<Map<number, GbzPath>> | undefined
  private indexTags = new Map<string, string>()

  /** @internal */
  readonly sqlite: SqliteDatabase
  /** @internal */
  readonly index: SqliteDatabase | undefined

  private constructor(
    sqlite: SqliteDatabase,
    index: SqliteDatabase | undefined,
  ) {
    this.sqlite = sqlite
    this.index = index
  }

  static async open(opts: OpenOptions) {
    const { source, haplotypeIndex } = opts
    const pagerOptions: PagerOptions = {
      blockSize: opts.blockSize,
      maxBlocks: opts.maxBlocks,
    }
    const sqlite = await SqliteDatabase.open(source, pagerOptions)
    for (const table of ['Tags', 'Nodes', 'Paths', 'ReferenceIndex']) {
      sqlite.rootPage(table)
    }
    const index = haplotypeIndex
      ? await SqliteDatabase.open(haplotypeIndex, pagerOptions)
      : undefined
    const db = new GBZBase(sqlite, index)
    const version = await db.tag('version')
    if (version !== SCHEMA_VERSION) {
      throw new SchemaVersionError(version)
    }
    if (index) {
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
      if (db.indexTags.get('haplotype_index_orientations') === 'forward') {
        throw new ForwardOnlyIndexError()
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

  /** @internal */
  prefetchRecords(lo: number, hi: number) {
    return this.sqlite.prefetchRows('Nodes', lo, hi)
  }

  /** @internal */
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

  /** @internal */
  async getPath(handle: number) {
    const row = await this.sqlite.byRowid('Paths', handle)
    return row ? rowToPath(handle, row) : undefined
  }

  /** @internal */
  pathsByHandle() {
    this.pathMapCache ??= this.paths().then(
      paths => new Map(paths.map(path => [path.handle, path])),
    )
    return this.pathMapCache
  }

  /** @internal */
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

  /** @internal */
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
          `Path ${path ? formatPathName(path.name) : handle} has not been indexed for random access`,
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

  async getPathFragments(opts: PathWindow): Promise<PathFragment[]> {
    const { start, end } = opts
    const ordered = await this.pathsNamed(opts.path)
    if (ordered.length === 0) {
      throw new UnknownPathError(pathNameFor(toPathQuery(opts.path), 0))
    }
    if (end <= start) {
      return []
    }
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

  private async subgraphForFragment(fragment: PathFragment, opts: WindowQuery) {
    const { sample, contig, haplotype } = fragment.path.name
    const start = Math.max(opts.start, fragment.start)
    const haplotypes = opts.haplotypes ?? 'all'
    try {
      const subgraph = await subgraphInInterval(this, {
        ...opts,
        path: { sample, contig, haplotype },
        start,
        end: Math.min(opts.end, fragment.end),
      })
      if (
        opts.keep === undefined &&
        this.hasHaplotypeIndex &&
        (haplotypes === 'all' || haplotypes === 'distinct')
      ) {
        await subgraph.identifyPaths()
      }
      return subgraph
    } catch (error) {
      throw error instanceof SubgraphLimitError && error.walkedBp !== undefined
        ? new SubgraphLimitError(error.limit, {
            windowBp: opts.end - opts.start,
            walkedBp: start - opts.start + error.walkedBp,
          })
        : error
    }
  }

  async getSubgraphs(opts: WindowQuery): Promise<Subgraph[]> {
    const fragments = await this.getPathFragments(opts)
    return Promise.all(
      fragments.map(fragment => this.subgraphForFragment(fragment, opts)),
    )
  }

  async getAlignments(opts: AlignmentQuery): Promise<HaplotypeAlignment[]> {
    return (await this.getSubgraphs(opts)).flatMap(subgraph =>
      subgraph.alignments(),
    )
  }

  subgraphInInterval(opts: IntervalQuery) {
    return subgraphInInterval(this, opts)
  }

  subgraphAtOffset(opts: OffsetQuery) {
    return subgraphAtOffset(this, opts)
  }

  subgraphAroundNodes(opts: NodesQuery) {
    return subgraphAroundNodes(this, opts)
  }

  subgraphBetween(opts: BetweenQuery) {
    return subgraphBetween(this, opts)
  }

  fetchStats(): { graph: FetchStats; haplotypeIndex: FetchStats | undefined } {
    const stats = ({ pager }: SqliteDatabase) => ({
      fetches: pager.fetches,
      bytesFetched: pager.bytesFetched,
    })
    return {
      graph: stats(this.sqlite),
      haplotypeIndex: this.index ? stats(this.index) : undefined,
    }
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
    return this.index !== undefined
  }

  private get companion() {
    if (!this.index) {
      throw new Error('no haplotype index was opened with this database')
    }
    return this.index
  }

  /** @internal */
  async haplotypeSampleInterval() {
    const value = this.indexTags.get('haplotype_index_interval')
    return value === undefined ? undefined : Number(value)
  }

  // The most bp between two samples of any path: the reference paths take
  // --reference-interval, which can exceed --interval.
  /** @internal */
  async haplotypeSampleGap() {
    const interval = await this.haplotypeSampleInterval()
    const reference = this.indexTags.get('haplotype_index_reference_interval')
    return interval === undefined
      ? undefined
      : Math.max(interval, reference === undefined ? 0 : Number(reference))
  }

  /** @internal */
  async haplotypeAnchorSpacing() {
    const value = this.index?.has('HaplotypeAnchors')
      ? this.indexTags.get('haplotype_index_anchor_spacing')
      : undefined
    return value === undefined ? undefined : Number(value)
  }

  // How HaplotypeStrays and HaplotypeBinNodes were built, or undefined
  // without them.
  /** @internal */
  async haplotypeStrayOptions(): Promise<HaplotypeStrayOptions | undefined> {
    const tag = (key: string) =>
      this.indexTags.get(`haplotype_index_stray_${key}`)
    if (
      !this.index?.has('HaplotypeStrays') ||
      !this.index.has('HaplotypeBinNodes') ||
      tag('format') !== '2'
    ) {
      return undefined
    }
    const snarls =
      tag('snarls') === 'modeled' &&
      tag('chain_links') === ((await this.tag('chain_links')) ?? '0')
    return {
      context: Number(tag('context')),
      bin: Number(tag('bin')),
      bound: Number(tag('bound')),
      snarlNodes: snarls ? Number(tag('snarl_nodes')) : undefined,
    }
  }

  // The HaplotypeStrays rows of the bins firstBin..lastBin of one reference
  // path.
  /** @internal */
  async haplotypeStraysInBins(
    referenceHandle: number,
    firstBin: number,
    lastBin: number,
  ) {
    const rows: HaplotypeStray[] = []
    for await (const row of this.companion.indexScanFrom('HaplotypeStrays', [
      referenceHandle,
      firstBin,
    ])) {
      const bin = num(row[1], 'HaplotypeStrays.bin')
      if (row[0] !== referenceHandle || bin > lastBin) {
        break
      }
      const low = num(row[4], 'HaplotypeStrays.snarl_low')
      const high = num(row[5], 'HaplotypeStrays.snarl_high')
      rows.push({
        bin,
        pathHandle: num(row[2], 'HaplotypeStrays.path_handle'),
        pathStart: num(row[3], 'HaplotypeStrays.path_start'),
        snarl: high > 0 ? [low, high] : undefined,
        pathEnd: num(row[6], 'HaplotypeStrays.path_end'),
        node: num(row[7], 'HaplotypeStrays.node_handle'),
        offset: num(row[8], 'HaplotypeStrays.node_offset'),
      })
    }
    return rows
  }

  // The nodes HaplotypeBinNodes lists for the bins firstBin..lastBin of one
  // reference path, as a test of one node id.
  /** @internal */
  async haplotypeBinNodes(
    referenceHandle: number,
    firstBin: number,
    lastBin: number,
  ) {
    const runs: [number, number][] = []
    for await (const row of this.companion.indexScanFrom('HaplotypeBinNodes', [
      referenceHandle,
      firstBin,
    ])) {
      if (
        row[0] !== referenceHandle ||
        num(row[1], 'HaplotypeBinNodes.bin') > lastBin
      ) {
        break
      }
      const bytes = blob(row[3], 'HaplotypeBinNodes.nodes')
      let previous = 0
      let at = 0
      const read = () => {
        let value = 0
        let scale = 1
        for (;;) {
          const byte = bytes[at++]
          if (byte === undefined) {
            throw new Error('HaplotypeBinNodes.nodes ends inside a number')
          }
          value += (byte & 0x7f) * scale
          scale *= 128
          if ((byte & 0x80) === 0) {
            return value
          }
        }
      }
      while (at < bytes.length) {
        const start = previous + read()
        previous = start + read()
        runs.push([start, previous])
      }
    }
    runs.sort((x, y) => x[0] - y[0])
    const starts: number[] = []
    const ends: number[] = []
    for (const [start, end] of runs) {
      const last = ends.length - 1
      if (last >= 0 && start <= ends[last]! + 1) {
        ends[last] = Math.max(ends[last]!, end)
      } else {
        starts.push(start)
        ends.push(end)
      }
    }
    return (id: number) => {
      let lo = 0
      let hi = starts.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (starts[mid]! <= id) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      return lo > 0 && id <= ends[lo - 1]!
    }
  }

  /** @internal */
  async haplotypeAnchor(
    pathHandle: number,
    anchorOffset: number,
  ): Promise<HaplotypeAnchor | undefined> {
    const key = await this.companion.indexSeekLE('HaplotypeAnchors', [
      pathHandle,
      anchorOffset,
    ])
    const row =
      key?.[0] === pathHandle && key[1] === anchorOffset
        ? await this.companion.byRowid(
            'HaplotypeAnchors',
            num(key[2], 'HaplotypeAnchors rowid'),
          )
        : undefined
    return row
      ? {
          node: num(row[2], 'HaplotypeAnchors.node_handle'),
          pathOffset: num(row[3], 'HaplotypeAnchors.path_offset'),
        }
      : undefined
  }

  /** @internal */
  haplotypeSamplesAtNode(handle: number) {
    return this.haplotypeSamplesInRange(handle, handle)
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

  /** @internal */
  async haplotypeSamplesInRange(minHandle: number, maxHandle: number) {
    const samples: HaplotypeSample[] = []
    for await (const key of this.companion.indexScanFrom('HaplotypeSamples', [
      minHandle,
      0,
    ])) {
      const node = num(key[0], 'HaplotypeSamples.node_handle')
      if (node > maxHandle) {
        break
      }
      const row = await this.companion.byRowid(
        'HaplotypeSamples',
        num(key[2], 'HaplotypeSamples rowid'),
      )
      if (row) {
        samples.push(this.sampleFromRow(row))
      }
    }
    return samples
  }

  /** @internal */
  async haplotypeSampleAt(node: number, offset: number) {
    const key = await this.companion.indexSeekLE('HaplotypeSamples', [
      node,
      offset,
    ])
    if (key?.[0] !== node || key[1] !== offset) {
      return undefined
    }
    const row = await this.companion.byRowid(
      'HaplotypeSamples',
      num(key[2], 'HaplotypeSamples rowid'),
    )
    return row ? this.sampleFromRow(row) : undefined
  }

  /** @internal */
  async haplotypeLength(pathHandle: number) {
    const row = await this.companion.byRowid('HaplotypeLengths', pathHandle)
    return row ? num(row[1], 'HaplotypeLengths.length') : undefined
  }

  private async indexedRow(rowid: number): Promise<IndexedPosition> {
    const row = await this.sqlite.byRowid('ReferenceIndex', rowid)
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

  private async indexedRowid(pathHandle: number, pathOffset: number) {
    const key = await this.sqlite.indexSeekLE('ReferenceIndex', [
      pathHandle,
      pathOffset,
    ])
    return key?.[0] === pathHandle
      ? num(key[2], 'ReferenceIndex rowid')
      : undefined
  }

  /** @internal */
  async indexedPosition(
    pathHandle: number,
    pathOffset: number,
  ): Promise<IndexedPosition | undefined> {
    const rowid = await this.indexedRowid(pathHandle, pathOffset)
    return rowid === undefined ? undefined : this.indexedRow(rowid)
  }

  /** @internal */
  async indexedPositionsBetween(
    pathHandle: number,
    fromOffset: number,
    toOffset: number,
  ) {
    const [first, last] = await Promise.all([
      this.indexedRowid(pathHandle, fromOffset),
      this.indexedRowid(pathHandle, toOffset),
    ])
    const positions: IndexedPosition[] = []
    if (first !== undefined && last !== undefined) {
      await this.sqlite.prefetchRows('ReferenceIndex', first, last + 1)
      for (let rowid = first; rowid <= last; rowid++) {
        positions.push(await this.indexedRow(rowid))
      }
    }
    return positions
  }
}
