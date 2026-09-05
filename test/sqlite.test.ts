import path from 'node:path'
import { LocalFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase, SchemaVersionError } from '../src/db.ts'
import { SqliteDatabase } from '../src/sqlite/database.ts'

const file = path.join(import.meta.dirname, 'data', 'micb-kir3dl1.gbz.db')

describe('sqlite reader', () => {
  it('lists the schema objects', async () => {
    const db = await SqliteDatabase.open(new LocalFile(file))
    expect([...db.objects.keys()].sort()).toEqual(
      [
        'Nodes',
        'Paths',
        'ReferenceIndex',
        'Tags',
        'HaplotypeSamples',
        'HaplotypeLengths',
        'sqlite_autoindex_ReferenceIndex_1',
        'sqlite_autoindex_Tags_1',
        'sqlite_autoindex_HaplotypeSamples_1',
      ].sort(),
    )
  })

  it('scans every node row', async () => {
    const db = await SqliteDatabase.open(new LocalFile(file))
    let count = 0
    let lastRowid = 0
    for await (const { rowid } of db.scan('Nodes')) {
      expect(rowid).toBeGreaterThan(lastRowid)
      lastRowid = rowid
      count += 1
    }
    expect(count).toBe(5782)
  })

  it('refuses a database whose schema it does not understand', async () => {
    const future = path.join(import.meta.dirname, 'data', 'example-future-schema.gbz.db')
    await expect(GBZBase.open(new LocalFile(future))).rejects.toBeInstanceOf(SchemaVersionError)
    await expect(GBZBase.open(new LocalFile(future))).rejects.toThrow('GBZ-base version 99')
  })

  it('reads tags and paths', async () => {
    const db = await GBZBase.open(new LocalFile(file))
    expect(await db.tag('nodes')).toBe('2891')
    expect(await db.tag('gbwt_reference_samples')).toBe('CHM13 GRCh38')
    const paths = await db.paths()
    expect(paths).toHaveLength(169)
    expect(paths.filter(p => p.isIndexed)).toHaveLength(4)
    const chr6 = await db.findPath({ sample: 'GRCh38', contig: 'chr6', haplotype: 0, fragment: 31500000 })
    expect(chr6?.handle).toBe(1)
    expect(chr6?.name.fragment).toBe(31498140)
  })

  it('seeks the reference index', async () => {
    const db = await GBZBase.open(new LocalFile(file))
    expect(await db.indexedPosition(0, 0)).toEqual({ pathOffset: 0, pos: { node: 2, offset: 0 } })
    expect(await db.indexedPosition(0, 1178)).toEqual({ pathOffset: 0, pos: { node: 2, offset: 0 } })
    expect(await db.indexedPosition(0, 1179)).toEqual({ pathOffset: 1179, pos: { node: 198, offset: 1 } })
    expect(await db.indexedPosition(0, 5000)).toEqual({ pathOffset: 4339, pos: { node: 472, offset: 47 } })
    expect(await db.indexedPosition(99, 5000)).toBeUndefined()
  })

  it('decodes a node record', async () => {
    const db = await GBZBase.open(new LocalFile(file))
    const record = await db.getRecord(2)
    expect(record?.id).toBe(1)
    expect(record?.orientation).toBe('forward')
    expect(record?.sequenceLen).toBeGreaterThan(0)
    expect(await db.getRecord(999999)).toBeUndefined()
  })
})
