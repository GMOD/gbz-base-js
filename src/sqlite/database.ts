import { BTree } from './btree.ts'
import { Pager } from './pager.ts'

import type { ByteSource } from '../filehandle.ts'
import type { PagerOptions } from './pager.ts'
import type { SqlValue } from './record.ts'

export interface SqliteObject {
  type: string
  name: string
  tableName: string
  rootPage: number
  sql: string
}

export class SqliteDatabase {
  readonly pager: Pager
  readonly btree: BTree
  readonly objects: Map<string, SqliteObject>

  private constructor(
    pager: Pager,
    btree: BTree,
    objects: Map<string, SqliteObject>,
  ) {
    this.pager = pager
    this.btree = btree
    this.objects = objects
  }

  static async open(source: ByteSource, opts: PagerOptions = {}) {
    const { size } = await source.stat()
    const firstBlock = await source.read(
      Math.min(opts.blockSize ?? 65536, size),
      0,
    )
    const header = firstBlock.subarray(0, 100)
    const magic = new TextDecoder().decode(header.subarray(0, 15))
    if (magic !== 'SQLite format 3') {
      throw new Error('Not a SQLite database')
    }
    const view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    )
    const rawPageSize = view.getUint16(16)
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize
    const reserved = header[20] ?? 0
    const encoding = view.getUint32(56)
    if (encoding !== 1) {
      throw new Error(`SQLite text encoding ${encoding} is not UTF-8`)
    }
    const pager = new Pager(source, pageSize, size, opts)
    pager.seed(0, firstBlock)
    pager.fetches += 1
    pager.bytesFetched += firstBlock.length
    const btree = new BTree(pager, reserved)
    const objects = new Map<string, SqliteObject>()
    for await (const { values } of btree.tableScan(1)) {
      const [type, name, tableName, rootPage, sql] = values
      if (
        typeof type === 'string' &&
        typeof name === 'string' &&
        typeof tableName === 'string' &&
        typeof rootPage === 'number'
      ) {
        objects.set(name, {
          type,
          name,
          tableName,
          rootPage,
          sql: typeof sql === 'string' ? sql : '',
        })
      }
    }
    return new SqliteDatabase(pager, btree, objects)
  }

  rootPage(name: string) {
    const object = this.objects.get(name)
    if (!object) {
      throw new Error(`SQLite database has no object named ${name}`)
    }
    return object.rootPage
  }

  indexOn(tableName: string) {
    const index = [...this.objects.values()].find(
      o => o.type === 'index' && o.tableName === tableName,
    )
    if (!index) {
      throw new Error(`SQLite table ${tableName} has no index`)
    }
    return index.rootPage
  }

  byRowid(table: string, rowid: number) {
    return this.btree.tableRowid(this.rootPage(table), rowid)
  }

  scan(table: string) {
    return this.btree.tableScan(this.rootPage(table))
  }

  indexSeekLE(table: string, key: number[]): Promise<SqlValue[] | undefined> {
    return this.btree.indexSeekLE(this.indexOn(table), key)
  }

  indexScanFrom(table: string, low: number[]) {
    return this.btree.indexScanFrom(this.indexOn(table), low)
  }

  has(name: string) {
    return this.objects.has(name)
  }
}
