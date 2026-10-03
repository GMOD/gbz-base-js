import { existsSync } from 'node:fs'

import { LocalFile, RemoteFile } from 'generic-filehandle2'
import { describe, expect, it } from 'vitest'

import { GBZBase } from '../src/db.ts'

import type { PathName } from '../src/pathName.ts'
import type { Subgraph } from '../src/subgraph.ts'

const graphUrl =
  'https://s3-us-west-2.amazonaws.com/human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/v2.1/hprc-v2.1-mc-grch38/hprc-v2.1-mc-grch38.gbz.db'
const anchoredCompanion =
  process.env.GBZ_HPRC_ANCHORED_INDEX ??
  'https://jbrowse.org/demos/hprc/hprc-v2.1-mc-grch38.haplotype-index.f3.db'

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

describe.skipIf(!available(anchoredCompanion))(
  'a query that uses the keep option',
  () => {
    it('writes one W line per haplotype, spanning what its alignment does, as the sampled route does', async () => {
      const db = await GBZBase.open({
        source: new RemoteFile(graphUrl),
        haplotypeIndex: isRemote(anchoredCompanion)
          ? new RemoteFile(anchoredCompanion)
          : new LocalFile(anchoredCompanion),
      })
      const kept = await db.subgraphInInterval({
        path: query,
        start,
        end,
        ...opts,
        keep,
      })
      expect(await walkSpans(kept)).toEqual(alignmentSpans(kept))
      expect(alignmentSpans(kept)).toEqual([
        'HG00099#1 9160',
        'HG00099#2 6363',
        'HG02559#1 11643',
        'HG02559#2 6472',
      ])
      const sampled = await db.subgraphInInterval({
        path: query,
        start,
        end,
        ...opts,
      })
      await sampled.identifyPaths()
      sampled.keepHaplotypes(keep)
      expect(await walkSpans(sampled)).toEqual(alignmentSpans(sampled))
      expect(alignmentSpans(sampled)).toEqual(alignmentSpans(kept))
    }, 300000)

    // HG04199#2 has one contig that ends between the anchor and the window and
    // another that starts after the anchor, so no anchor row leads to its walk
    // through the window; a sample of the second contig in the window does.
    it('keeps a haplotype whose contig starts after the anchor', async () => {
      const db = await GBZBase.open({
        source: new RemoteFile(graphUrl),
        haplotypeIndex: isRemote(anchoredCompanion)
          ? new RemoteFile(anchoredCompanion)
          : new LocalFile(anchoredCompanion),
      })
      const broken = ['HG04199#1', 'HG04199#2']
      const keep = (name: PathName) =>
        broken.includes(`${name.sample}#${name.haplotype}`)
      const kept = await db.subgraphInInterval({
        path: query,
        start,
        end,
        ...opts,
        keep,
      })
      const names = kept
        .alignments()
        .flatMap(a =>
          a.resolved ? [`${a.name.sample}#${a.name.haplotype}`] : [],
        )
        .sort()
      expect(names).toEqual(broken)
      const sampled = await db.subgraphInInterval({
        path: query,
        start,
        end,
        ...opts,
      })
      await sampled.identifyPaths()
      sampled.keepHaplotypes(keep)
      expect(kept.alignments()).toEqual(sampled.alignments())
    }, 300000)
  },
)
