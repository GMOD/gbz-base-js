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
        ? `not a gbz-base database: it has no version tag`
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

// An anchor of a reference path with the forward samples at its node: one
// visit of every haplotype that passes it, each with its GBWT position and
// its offset along its own path.
export interface HaplotypeAnchorRow extends HaplotypeAnchor {
  anchorOffset: number
  visits: HaplotypeSample[]
}

// One bin of a reference path in the haplotype index's overview: how many
// haplotypes fall in each class there, and the excursions from the reference
// that start in it.
export interface OverviewBin {
  start: number
  end: number
  // haplotypes that are absent, reference-like, partial and variant
  classes: [number, number, number, number]
  excursions: number
  variants: number
  longestExcursion: number
}

export const OVERVIEW_ABSENT = 0
export const OVERVIEW_REFERENCE = 1
export const OVERVIEW_PARTIAL = 2
export const OVERVIEW_VARIANT = 3

// A binned summary of every haplotype along a stretch of a reference path,
// at one zoom level. `cells` holds bins.length × haplotypes.length entries,
// bin by bin: the class in the low two bits, and for a variant cell a bucket
// of the bin's variant marks in the next two (1, 2 to 3, 4 to 15, 16 or
// more).
export interface HaplotypeOverview {
  level: number
  bin: number
  haplotypes: { sample: string; haplotype: number }[]
  bins: OverviewBin[]
  cells: Uint8Array
}

export interface OverviewQuery extends PathWindow {
  // The zoom level, clamped to those the index holds, or the bp per pixel to
  // choose the coarsest level whose bins are no larger than it. Level 0
  // without either.
  level?: number | undefined
  bpPerPixel?: number | undefined
}

function concatBytes(parts: Uint8Array[]) {
  if (parts.length === 1) {
    return parts[0]!
  }
  const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    whole.set(part, at)
    at += part.length
  }
  return whole
}

// The formats of the haplotype index this reader understands. Format 3 keeps
// the samples in their key b-tree, each anchor's visits with the anchor and
// each bin's stray rows with its node list.
const INDEX_FORMATS = [2, 3]

class Varints {
  private at = 0
  private bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  get done() {
    return this.at >= this.bytes.length
  }

  next() {
    let value = 0
    let scale = 1
    for (;;) {
      const byte = this.bytes[this.at++]
      if (byte === undefined) {
        throw new Error('a haplotype index blob ends inside a number')
      }
      value += (byte & 0x7f) * scale
      scale *= 128
      if ((byte & 0x80) === 0) {
        return value
      }
    }
  }
}

// Appends the runs of node ids a HaplotypeBins node-list part encodes: per
// run, the gap from the previous run's last id and the length less one.
function decodeRuns(bytes: Uint8Array, runs: [number, number][]) {
  const reader = new Varints(bytes)
  let previous = 0
  while (!reader.done) {
    const start = previous + reader.next()
    previous = start + reader.next()
    runs.push([start, previous])
  }
}

// A test of membership in the union of the runs.
function runTester(runs: [number, number][]) {
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

function decodeStrays(bin: number, bytes: Uint8Array, rows: HaplotypeStray[]) {
  const reader = new Varints(bytes)
  while (!reader.done) {
    const pathHandle = reader.next()
    const pathStart = reader.next()
    const pathEnd = reader.next()
    const low = reader.next()
    const high = reader.next()
    rows.push({
      bin,
      pathHandle,
      pathStart,
      pathEnd,
      snarl: high > 0 ? [low, high] : undefined,
      node: reader.next(),
      offset: reader.next(),
    })
  }
}

// The visits of a format 3 anchor row: per visit, the path handle doubled
// plus the orientation bit of the node handle, the node offset and the path
// offset.
function decodeVisits(
  anchorNode: number,
  parts: Uint8Array[],
  visits: HaplotypeSample[],
) {
  const id = nodeId(anchorNode)
  for (const part of parts) {
    const reader = new Varints(part)
    while (!reader.done) {
      const pathAndBit = reader.next()
      const bit = pathAndBit % 2
      visits.push({
        node: 2 * id + bit,
        offset: reader.next(),
        pathHandle: (pathAndBit - bit) / 2,
        orientation: 'forward',
        pathOffset: reader.next(),
      })
    }
  }
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

function forgetOnRejection<T>(pending: Promise<T>, forget: () => void) {
  pending.catch(forget)
  return pending
}

async function readTags(sqlite: SqliteDatabase) {
  const tags = new Map<string, string>()
  for await (const { values } of sqlite.scan('Tags')) {
    tags.set(str(values[0], 'Tags.key'), str(values[1], 'Tags.value'))
  }
  return tags
}

export class GBZBase {
  private pathCache: Promise<GbzPath[]> | undefined
  private pathMapCache: Promise<Map<number, GbzPath>> | undefined
  private indexTags = new Map<string, string>()
  private indexFormat = 2
  private samplesInline = false
  private overviewRowsCache:
    Promise<{ sample: string; haplotype: number }[]> | undefined

  /** @internal */
  readonly sqlite: SqliteDatabase
  /** @internal */
  readonly index: SqliteDatabase | undefined
  private readonly tagMap: Map<string, string>

  private constructor(
    sqlite: SqliteDatabase,
    index: SqliteDatabase | undefined,
    tags: Map<string, string>,
  ) {
    this.sqlite = sqlite
    this.index = index
    this.tagMap = tags
  }

  static async open(opts: OpenOptions) {
    const { source, haplotypeIndex } = opts
    const pagerOptions: PagerOptions = {
      blockSize: opts.blockSize,
      maxBlocks: opts.maxBlocks,
    }
    const sqlite = await SqliteDatabase.open(source, pagerOptions)
    const tags = sqlite.objects.has('Tags')
      ? await readTags(sqlite)
      : new Map<string, string>()
    const version = tags.get('version')
    if (version !== SCHEMA_VERSION) {
      throw new SchemaVersionError(version)
    }
    for (const table of ['Nodes', 'Paths', 'ReferenceIndex']) {
      sqlite.rootPage(table)
    }
    const index = haplotypeIndex
      ? await SqliteDatabase.open(haplotypeIndex, pagerOptions)
      : undefined
    const db = new GBZBase(sqlite, index, tags)
    if (index) {
      for (const table of ['Tags', 'HaplotypeSamples', 'HaplotypeLengths']) {
        if (!index.objects.has(table)) {
          throw new Error(
            `haplotypeIndex is not a gbz-base haplotype index: it has no ${table} table`,
          )
        }
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
      const format = Number(db.indexTags.get('haplotype_index_format') ?? '2')
      if (!INDEX_FORMATS.includes(format)) {
        throw new Error(
          `the haplotype index has format ${format}, newer than the formats this version of @gmod/gbz-base reads (${INDEX_FORMATS.join(', ')}); update the package`,
        )
      }
      db.indexFormat = format
      db.samplesInline = index.withoutRowid('HaplotypeSamples')
    }
    return db
  }

  async tags() {
    return this.tagMap
  }

  async tag(key: string) {
    return this.tagMap.get(key)
  }

  /** @internal */
  prefetchRecords(ranges: [number, number][], stream = false) {
    return this.sqlite.prefetchRows('Nodes', ranges, stream)
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
    this.pathCache ??= forgetOnRejection(this.scanPaths(), () => {
      this.pathCache = undefined
    })
    return this.pathCache
  }

  private async scanPaths() {
    const paths: GbzPath[] = []
    for await (const { rowid, values } of this.sqlite.scan('Paths')) {
      paths.push(rowToPath(rowid, values))
    }
    return paths
  }

  /** @internal */
  async getPath(handle: number) {
    const row = await this.sqlite.byRowid('Paths', handle)
    return row ? rowToPath(handle, row) : undefined
  }

  /** @internal */
  pathsByHandle() {
    this.pathMapCache ??= forgetOnRejection(
      this.paths().then(
        paths => new Map(paths.map(path => [path.handle, path])),
      ),
      () => {
        this.pathMapCache = undefined
      },
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
          `${path ? `The fragment of ${formatPathName(path.name)} at ${path.name.fragment}` : `Path ${handle}`} has not been indexed for random access`,
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
    if (Number.isNaN(start) || Number.isNaN(end)) {
      throw new Error(`The window ${start}..${end} is not a number range`)
    }
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
    const settled = await Promise.allSettled(
      fragments.map(fragment => this.subgraphForFragment(fragment, opts)),
    )
    return settled.map(result => {
      if (result.status === 'rejected') {
        throw result.reason
      }
      return result.value
    })
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

  // How the bins' node lists and stray rows were built, or undefined without
  // them.
  /** @internal */
  async haplotypeStrayOptions(): Promise<HaplotypeStrayOptions | undefined> {
    const tag = (key: string) =>
      this.indexTags.get(`haplotype_index_stray_${key}`)
    const tables =
      this.indexFormat >= 3
        ? ['HaplotypeBins']
        : ['HaplotypeStrays', 'HaplotypeBinNodes']
    if (
      !tables.every(table => this.index?.has(table)) ||
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

  // The rows of a format 3 table with blobs whose keys lie in low..high: a
  // key scan of its index, then its rows, which the indexer wrote in key
  // order, prefetched as one range. A table without a rowid yields its rows
  // from the scan itself.
  private async blobRows(table: string, low: number[], high: number[]) {
    const rows: SqlValue[][] = []
    if (this.companion.withoutRowid(table)) {
      for await (const row of this.companion.indexScanFrom(table, low, high)) {
        rows.push(row)
      }
      return rows
    }
    const rowids: number[] = []
    for await (const key of this.companion.indexScanFrom(table, low, high)) {
      rowids.push(num(key[key.length - 1], `${table} rowid`))
    }
    if (rowids.length > 1) {
      await this.companion.prefetchRows(
        table,
        [[Math.min(...rowids), Math.max(...rowids) + 1]],
        true,
      )
    }
    for (const rowid of rowids) {
      const row = await this.companion.byRowid(table, rowid)
      if (row) {
        rows.push(row)
      }
    }
    return rows
  }

  // The node lists and stray rows of the bins firstBin..lastBin of one
  // reference path: a test of whether a node id is listed, and the rows.
  /** @internal */
  async haplotypeBinData(
    referenceHandle: number,
    firstBin: number,
    lastBin: number,
  ): Promise<{ listed: (id: number) => boolean; strays: HaplotypeStray[] }> {
    const runs: [number, number][] = []
    const strays: HaplotypeStray[] = []
    if (this.indexFormat >= 3) {
      for (const row of await this.blobRows(
        'HaplotypeBins',
        [referenceHandle, firstBin],
        [referenceHandle, lastBin],
      )) {
        const bin = num(row[1], 'HaplotypeBins.bin')
        decodeRuns(blob(row[3], 'HaplotypeBins.nodes'), runs)
        decodeStrays(bin, blob(row[4], 'HaplotypeBins.strays'), strays)
      }
      return { listed: runTester(runs), strays }
    }
    await Promise.all([
      (async () => {
        for await (const row of this.companion.indexScanFrom(
          'HaplotypeBinNodes',
          [referenceHandle, firstBin],
          [referenceHandle, lastBin],
        )) {
          decodeRuns(blob(row[3], 'HaplotypeBinNodes.nodes'), runs)
        }
      })(),
      (async () => {
        for await (const row of this.companion.indexScanFrom(
          'HaplotypeStrays',
          [referenceHandle, firstBin],
          [referenceHandle, lastBin],
        )) {
          const low = num(row[4], 'HaplotypeStrays.snarl_low')
          const high = num(row[5], 'HaplotypeStrays.snarl_high')
          strays.push({
            bin: num(row[1], 'HaplotypeStrays.bin'),
            pathHandle: num(row[2], 'HaplotypeStrays.path_handle'),
            pathStart: num(row[3], 'HaplotypeStrays.path_start'),
            snarl: high > 0 ? [low, high] : undefined,
            pathEnd: num(row[6], 'HaplotypeStrays.path_end'),
            node: num(row[7], 'HaplotypeStrays.node_handle'),
            offset: num(row[8], 'HaplotypeStrays.node_offset'),
          })
        }
      })(),
    ])
    return { listed: runTester(runs), strays }
  }

  // The anchors of one reference path at offsets from lowOffset to
  // highOffset, each with the forward samples at its node.
  /** @internal */
  async haplotypeAnchorsBetween(
    pathHandle: number,
    lowOffset: number,
    highOffset: number,
    spacing: number,
  ): Promise<HaplotypeAnchorRow[]> {
    if (this.indexFormat >= 3) {
      const rows: HaplotypeAnchorRow[] = []
      let parts: Uint8Array[] = []
      const flush = () => {
        const last = rows[rows.length - 1]
        if (last) {
          decodeVisits(last.node, parts, last.visits)
        }
        parts = []
      }
      for (const row of await this.blobRows(
        'HaplotypeAnchors',
        [pathHandle, lowOffset],
        [pathHandle, highOffset],
      )) {
        const anchorOffset = num(row[1], 'HaplotypeAnchors.anchor_offset')
        if (rows[rows.length - 1]?.anchorOffset !== anchorOffset) {
          flush()
          rows.push({
            anchorOffset,
            node: num(row[3], 'HaplotypeAnchors.node_handle'),
            pathOffset: num(row[4], 'HaplotypeAnchors.path_offset'),
            visits: [],
          })
        }
        parts.push(blob(row[5], 'HaplotypeAnchors.visits'))
      }
      flush()
      return rows
    }
    const offsets: number[] = []
    for (let offset = lowOffset; offset <= highOffset; offset += spacing) {
      offsets.push(offset)
    }
    const found = await Promise.all(
      offsets.map(async anchorOffset => {
        const anchor = await this.haplotypeAnchor(pathHandle, anchorOffset)
        return anchor ? { ...anchor, anchorOffset } : undefined
      }),
    )
    const anchors = found.filter(anchor => anchor !== undefined)
    const nodes = [...new Set(anchors.map(anchor => nodeId(anchor.node)))]
    const visits = new Map(
      await Promise.all(
        nodes.map(
          async id =>
            [
              id,
              await this.haplotypeSamplesInRange(2 * id, 2 * id + 1),
            ] as const,
        ),
      ),
    )
    return anchors.map(anchor => ({
      ...anchor,
      visits: visits.get(nodeId(anchor.node))!,
    }))
  }

  /** @internal */
  async haplotypeAnchor(
    pathHandle: number,
    anchorOffset: number,
  ): Promise<HaplotypeAnchor | undefined> {
    if (this.indexFormat >= 3) {
      const [row] = await this.haplotypeAnchorsBetween(
        pathHandle,
        anchorOffset,
        anchorOffset,
        1,
      )
      return row && { node: row.node, pathOffset: row.pathOffset }
    }
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

  // The samples at the node handles minHandle..maxHandle. A format 2 index
  // keeps them in a rowid table in key order, so their rows are prefetched as
  // one range after the key scan.
  /** @internal */
  async haplotypeSamplesInRange(minHandle: number, maxHandle: number) {
    const samples: HaplotypeSample[] = []
    const keys = this.companion.indexScanFrom(
      'HaplotypeSamples',
      [minHandle, 0],
      [maxHandle, Number.MAX_SAFE_INTEGER],
    )
    if (this.samplesInline) {
      for await (const row of keys) {
        samples.push(this.sampleFromRow(row))
      }
      return samples
    }
    const rowids: number[] = []
    for await (const key of keys) {
      rowids.push(num(key[2], 'HaplotypeSamples rowid'))
    }
    if (rowids.length > 1) {
      await this.companion.prefetchRows('HaplotypeSamples', [
        [Math.min(...rowids), Math.max(...rowids) + 1],
      ])
    }
    for (const rowid of rowids) {
      const row = await this.companion.byRowid('HaplotypeSamples', rowid)
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
    if (this.samplesInline) {
      return this.sampleFromRow(key)
    }
    const row = await this.companion.byRowid(
      'HaplotypeSamples',
      num(key[2], 'HaplotypeSamples rowid'),
    )
    return row ? this.sampleFromRow(row) : undefined
  }

  private overviewRows() {
    this.overviewRowsCache ??= forgetOnRejection(
      (async () => {
        const rows: { sample: string; haplotype: number }[] = []
        for await (const { rowid, values } of this.companion.scan(
          'HaplotypeOverviewRows',
        )) {
          rows[rowid] = {
            sample: str(values[1], 'HaplotypeOverviewRows.sample'),
            haplotype: num(values[2], 'HaplotypeOverviewRows.haplotype'),
          }
        }
        return rows
      })(),
      () => {
        this.overviewRowsCache = undefined
      },
    )
    return this.overviewRowsCache
  }

  // The parts of one overview table for the chunks firstChunk..lastChunk of
  // one reference path at one level, joined per chunk.
  private async overviewChunks(
    table: string,
    pathHandle: number,
    level: number,
    firstChunk: number,
    lastChunk: number,
  ) {
    const parts = new Map<number, Uint8Array[]>()
    for (const row of await this.blobRows(
      table,
      [pathHandle, level, firstChunk],
      [pathHandle, level, lastChunk],
    )) {
      const chunk = num(row[2], `${table}.chunk`)
      const list = parts.get(chunk) ?? []
      list.push(blob(row[4], `${table} blob`))
      parts.set(chunk, list)
    }
    return new Map(
      [...parts].map(([chunk, list]) => [chunk, concatBytes(list)]),
    )
  }

  // The haplotype index's binned summary of every haplotype over a window of
  // a reference path, or undefined when the index has no overview or none for
  // this path, which is not a reference path of a sample with anchors.
  async haplotypeOverview(
    opts: OverviewQuery,
  ): Promise<HaplotypeOverview | undefined> {
    const tag = (key: string) =>
      this.indexTags.get(`haplotype_index_overview_${key}`)
    if (!this.index?.has('HaplotypeOverviewClasses') || tag('format') !== '1') {
      return undefined
    }
    const baseBin = Number(tag('bin'))
    const chunkBins = Number(tag('chunk'))
    const levels = Number(tag('levels'))
    let level = Math.max(
      0,
      Math.min(Math.floor(opts.level ?? 0) || 0, levels - 1),
    )
    if (opts.level === undefined && opts.bpPerPixel !== undefined) {
      while (
        level + 1 < levels &&
        baseBin * 4 ** (level + 1) <= opts.bpPerPixel
      ) {
        level += 1
      }
    }
    const bin = baseBin * 4 ** level
    const [fragments, haplotypes] = await Promise.all([
      this.getPathFragments(opts),
      this.overviewRows(),
    ])
    const bytesPerBin = Math.ceil(haplotypes.length / 2)
    const bins: OverviewBin[] = []
    const cellRows: Uint8Array[] = []
    for (const fragment of fragments) {
      const length = fragment.end - fragment.start
      const from = Math.max(opts.start, fragment.start) - fragment.start
      const to = Math.min(opts.end, fragment.end) - fragment.start
      const firstBin = Math.floor(from / bin)
      const lastBin = Math.floor((to - 1) / bin)
      const firstChunk = Math.floor(firstBin / chunkBins)
      const lastChunk = Math.floor(lastBin / chunkBins)
      const [summaries, cells] = await Promise.all([
        this.overviewChunks(
          'HaplotypeOverviewBins',
          fragment.path.handle,
          level,
          firstChunk,
          lastChunk,
        ),
        this.overviewChunks(
          'HaplotypeOverviewClasses',
          fragment.path.handle,
          level,
          firstChunk,
          lastChunk,
        ),
      ])
      for (let chunk = firstChunk; chunk <= lastChunk; chunk++) {
        const reader = new Varints(summaries.get(chunk) ?? new Uint8Array())
        const packed = cells.get(chunk) ?? new Uint8Array()
        for (let b = chunk * chunkBins; !reader.done; b++) {
          const values = Array.from({ length: 7 }, () => reader.next())
          if (b < firstBin || b > lastBin) {
            continue
          }
          bins.push({
            start: fragment.start + b * bin,
            end: fragment.start + Math.min((b + 1) * bin, length),
            classes: [values[0]!, values[1]!, values[2]!, values[3]!],
            excursions: values[4]!,
            variants: values[5]!,
            longestExcursion: values[6]!,
          })
          const at = (b - chunk * chunkBins) * bytesPerBin
          cellRows.push(packed.subarray(at, at + bytesPerBin))
        }
      }
    }
    if (bins.length === 0) {
      return undefined
    }
    const cells = new Uint8Array(bins.length * haplotypes.length)
    cellRows.forEach((packed, b) => {
      for (let row = 0; row < haplotypes.length; row++) {
        cells[b * haplotypes.length + row] =
          ((packed[row >> 1] ?? 0) >> (4 * (row % 2))) & 0xf
      }
    })
    return { level, bin, haplotypes, bins, cells }
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
      await this.sqlite.prefetchRows('ReferenceIndex', [[first, last + 1]])
      for (let rowid = first; rowid <= last; rowid++) {
        positions.push(await this.indexedRow(rowid))
      }
    }
    return positions
  }
}
