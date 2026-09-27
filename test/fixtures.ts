import path from 'node:path'

import { LocalFile } from 'generic-filehandle2'

import { GBZBase } from '../src/db.ts'

export const dataDir = path.join(import.meta.dirname, 'data')

const sampledCompanions: Record<string, string> = {
  'micb-kir3dl1.gbz.db': 'micb-kir3dl1.sampled.haplotype-index.db',
  'example.gbz.db': 'example.haplotype-index.db',
  'example-v3.gbz.db': 'example-v3.haplotype-index.db',
}

export function sampledCompanion(graph: string) {
  return path.join(dataDir, sampledCompanions[graph]!)
}

export function openSampled(graph: string) {
  return GBZBase.open(new LocalFile(path.join(dataDir, graph)), {
    haplotypeIndex: new LocalFile(sampledCompanion(graph)),
  })
}
