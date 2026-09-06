import { ENDMARKER, nodeId, nodeOrientation } from './gbwt/node.ts'
import { GbwtRecord, decompressEdges } from './gbwt/record.ts'
import { decodeSequence, encodedSequenceLength } from './gbwt/sequence.ts'
import { SqliteDatabase } from './sqlite/database.ts'

import type { ByteSource } from './filehandle.ts'
import type { Pos } from './gbwt/record.ts'
import type { PagerOptions } from './sqlite/pager.ts'
import type { SqlValue } from './sqlite/record.ts'

export interface PathName {
  sample: string
  contig: string
  haplotype: number
  fragment: number
}

export const GENERIC_SAMPLE = '_gbwt_ref'
export const SCHEMA_VERSION = 'GBZ-base version 4'

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

export function formatPathName(name: PathName, end: number) {
  return `${name.sample}#${name.haplotype}#${name.contig}[${name.fragment}-${end}]`
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

export class GBZBase {
  private tagCache: Promise<Map<string, string>> | undefined
  private pathCache: Promise<GbzPath[]> | undefined

  readonly sqlite: SqliteDatabase

  private constructor(sqlite: SqliteDatabase) {
    this.sqlite = sqlite
  }

  static async open(source: ByteSource, opts: PagerOptions = {}) {
    const sqlite = await SqliteDatabase.open(source, opts)
    for (const table of ['Tags', 'Nodes', 'Paths', 'ReferenceIndex']) {
      sqlite.rootPage(table)
    }
    const db = new GBZBase(sqlite)
    const version = await db.tag('version')
    if (version !== SCHEMA_VERSION) {
      throw new SchemaVersionError(version)
    }
    return db
  }

  tags() {
    this.tagCache ??= (async () => {
      const tags = new Map<string, string>()
      for await (const { values } of this.sqlite.scan('Tags')) {
        tags.set(str(values[0], 'Tags.key'), str(values[1], 'Tags.value'))
      }
      return tags
    })()
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

  async hasChainLinks() {
    const links = await this.tag('chain_links')
    return links !== undefined && Number(links) > 0
  }

  get hasHaplotypeIndex() {
    return (
      this.sqlite.has('HaplotypeSamples') && this.sqlite.has('HaplotypeLengths')
    )
  }

  async haplotypeSampleInterval() {
    const value = await this.tag('haplotype_index_interval')
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
    for await (const key of this.sqlite.indexScanFrom('HaplotypeSamples', [
      minHandle,
      0,
    ])) {
      const node = num(key[0], 'HaplotypeSamples.node_handle')
      if (node > maxHandle) {
        break
      }
      const row = await this.sqlite.byRowid(
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
    const key = await this.sqlite.indexSeekLE('HaplotypeSamples', [
      node,
      offset,
    ])
    if (key?.[0] !== node || key[1] !== offset) {
      return undefined
    }
    const row = await this.sqlite.byRowid(
      'HaplotypeSamples',
      num(key[2], 'HaplotypeSamples rowid'),
    )
    return row ? this.sampleFromRow(row) : undefined
  }

  async haplotypeLength(pathHandle: number) {
    const row = await this.sqlite.byRowid('HaplotypeLengths', pathHandle)
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
