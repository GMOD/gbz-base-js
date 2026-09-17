import { existsSync } from 'node:fs'

import { LocalFile, RemoteFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'
import { subgraphForHaplotypes, subgraphInInterval } from '../src/query.ts'

import type { PathName } from '../src/pathName.ts'
import type { Subgraph } from '../src/subgraph.ts'

const graphUrl =
  'https://s3-us-west-2.amazonaws.com/human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/v2.1/hprc-v2.1-mc-grch38/hprc-v2.1-mc-grch38.gbz.db'
const anchoredCompanion =
  process.env.GBZ_HPRC_ANCHORED_INDEX ??
  'https://jbrowse.org/demos/hprc/hprc-v2.1-mc-grch38.haplotype-index.anchored.db'

const isRemote = (file: string) => /^https?:\/\//.test(file)
const available = (file: string) => isRemote(file) || existsSync(file)

// The ABCA7 VNTR: HG02559 carries about 5 kb where GRCh38 carries 0.7, so one
// haplotype's private copies are a single off-reference run several times the
// context. Dropping such a run split the walk in two and lost the expansion
// the window is about, in the W lines while the alignment still spanned it.
const query = { sample: 'GRCh38', contig: 'chr19' }
const [start, end] = [1049407, 1050096]
const opts = { context: 1000, snarls: 'contained' as const }
const wanted = ['HG00099#1', 'HG00099#2', 'HG02559#1', 'HG02559#2']
const keep = (name: PathName) =>
  wanted.includes(`${name.sample}#${name.haplotype}`)

function alignmentSpans(subgraph: Subgraph) {
  return subgraph
    .alignments()
    .flatMap(a =>
      a.resolved && keep(a.name)
        ? [`${a.name.sample}#${a.name.haplotype} ${a.hapEnd - a.hapStart}`]
        : [],
    )
    .sort()
}

async function walkSpans(subgraph: Subgraph) {
  const gfa = await subgraph.toGFA({ names: 'resolved' })
  return gfa
    .split('\n')
    .flatMap(line => (line.startsWith('W\t') ? [line.split('\t')] : []))
    .flatMap(f =>
      wanted.includes(`${f[1]}#${f[2]}`)
        ? [`${f[1]}#${f[2]} ${Number(f[5]) - Number(f[4])}`]
        : [],
    )
    .sort()
}

describe.skipIf(!available(anchoredCompanion))('the anchored walk', () => {
  it('writes one W line per haplotype, spanning what its alignment does', async () => {
    const db = await GBZBase.open(new RemoteFile(graphUrl), {
      haplotypeIndex: isRemote(anchoredCompanion)
        ? new RemoteFile(anchoredCompanion)
        : new LocalFile(anchoredCompanion),
    })
    const anchored = await subgraphForHaplotypes(db, query, start, end, {
      ...opts,
      keep,
    })
    expect(await walkSpans(anchored)).toEqual(alignmentSpans(anchored))
    expect(alignmentSpans(anchored)).toEqual([
      'HG00099#1 3183',
      'HG00099#2 388',
      'HG02559#1 5525',
      'HG02559#2 493',
    ])

    const interval = await subgraphInInterval(db, query, start, end, opts)
    await interval.identifyPaths()
    expect(await walkSpans(interval)).toEqual(alignmentSpans(interval))
  }, 300000)
})
