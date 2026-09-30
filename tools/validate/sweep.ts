// Parity of the keep route against the sampled route narrowed by
// keepHaplotypes, one JSON line per query. Argument: a JSON file of
// {graph, index, unlimited?, rows: [{stratum, label, sample, contig, start,
// end, combos: [[context, snarls]], keepSets: [[name, [entries]]]}]}, where an
// entry is "sample", "sample#hap" or "all".
//
// GBZ_SRC names the library's src/ under test. With TRUTH_PREFIX set, each
// window and combo also writes its subgraph's nodes to
// <prefix>.nodes.tsv and the sampled route's pieces to <prefix>.pieces.tsv,
// for gbz-truth and truth-compare.py.
import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const src = process.env.GBZ_SRC ?? path.join(import.meta.dirname, '../../src')
const { LocalFile } = await import('generic-filehandle2')
const { keepTuning } = await import(`${src}/chosenPaths.ts`)
const { GBZBase } = await import(`${src}/db.ts`)
const { subgraphForHaplotypes, subgraphInInterval } = await import(
  `${src}/query.ts`
)

interface Name {
  sample: string
  haplotype: number
  contig: string
  fragment: number
}
interface Record {
  resolved: boolean
  name: Name
  strand: string
  hapStart: number
  hapEnd: number
  refStart: number
  refEnd: number
}
interface Walk {
  path: number[]
  identity?: { pathHandle: number; hapStart: number; hapEnd: number }
}
type Snarls = 'none' | 'contained' | 'overlapping'

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  graph: string
  index: string
  unlimited?: boolean
  rows: {
    stratum: string
    label: string
    sample: string
    contig: string
    start: number
    end: number
    combos: [number, Snarls][]
    keepSets: [string, string[]][]
  }[]
}
if (config.unlimited) {
  keepTuning.mostChosenPaths = Number.POSITIVE_INFINITY
}
const db = await GBZBase.open(new LocalFile(config.graph), {
  haplotypeIndex: new LocalFile(process.env.INDEX ?? config.index),
})
const prefix = process.env.TRUTH_PREFIX
const nodesOut = prefix ? createWriteStream(`${prefix}.nodes.tsv`) : undefined
const piecesOut = prefix ? createWriteStream(`${prefix}.pieces.tsv`) : undefined
const key = (a: Record) =>
  a.resolved
    ? `${a.name.sample}#${a.name.haplotype}#${a.name.contig}[${a.name.fragment}] ${a.strand} hap ${a.hapStart}-${a.hapEnd} ref ${a.refStart}-${a.refEnd}`
    : 'unresolved'
for (const [index, w] of config.rows.entries()) {
  const query = { sample: w.sample, contig: w.contig }
  for (const [context, snarls] of w.combos) {
    let dumped = false
    for (const [setName, list] of w.keepSets) {
      const keep = (name: Name) =>
        list.includes('all') ||
        list.includes(`${name.sample}#${name.haplotype}`) ||
        list.includes(name.sample)
      const row: { [field: string]: unknown } = {
        stratum: w.stratum,
        label: w.label,
        sample: w.sample,
        contig: w.contig,
        start: w.start,
        end: w.end,
        context,
        snarls,
        set: setName,
        keepList: list,
      }
      try {
        const t0 = performance.now()
        const kept = await subgraphForHaplotypes(db, query, w.start, w.end, {
          context,
          snarls,
          keep,
        })
        const t1 = performance.now()
        const sampled = await subgraphInInterval(db, query, w.start, w.end, {
          context,
          snarls,
        })
        await sampled.identifyPaths()
        const walks = sampled.paths as Walk[]
        row.walksAll = walks.length - 1
        row.unresolved = walks.filter(
          (walk, i) => i !== sampled.refId && walk.identity === undefined,
        ).length
        if (nodesOut && piecesOut && !dumped) {
          dumped = true
          const id = `${path.basename(process.argv[2]!)}:${index}:${context}:${snarls}`
          const nodes = [
            ...new Set(
              [...(sampled.records as Map<number, unknown>).keys()].map(
                handle => handle >> 1,
              ),
            ),
          ].sort((a, b) => a - b)
          nodesOut.write(`${id}\t${nodes.join(',')}\n`)
          for (const walk of walks) {
            const identity = walk.identity
            piecesOut.write(
              `${id}\t${identity?.pathHandle ?? -1}\t${identity?.hapStart ?? -1}\t${identity?.hapEnd ?? -1}\n`,
            )
          }
        }
        if (row.unresolved === 0) {
          sampled.keepHaplotypes(keep)
        }
        const t2 = performance.now()
        const a = (kept.alignments() as Record[]).map(key)
        const b = (sampled.alignments() as Record[]).map(key)
        row.route = kept.stats.keep?.fallback ?? 'keep'
        row.records = b.length
        row.gfaEqual =
          (await kept.toGFA({ names: 'resolved' })) ===
          (await sampled.toGFA({ names: 'resolved' }))
        row.alignmentsEqual =
          JSON.stringify(kept.alignments()) ===
          JSON.stringify(sampled.alignments())
        row.keepOnly = a.filter(x => !b.includes(x))
        row.sampledOnly = b.filter(x => !a.includes(x))
        row.msKeep = Math.round(t1 - t0)
        row.msSampled = Math.round(t2 - t1)
        row.chosenPaths = kept.stats.keep?.chosenPaths
        row.walks = kept.stats.keep?.walks
        row.strays = kept.stats.keep?.strays
      } catch (error) {
        row.error = String(
          error instanceof Error ? error.message : error,
        ).slice(0, 300)
      }
      console.log(JSON.stringify(row))
    }
  }
}
await Promise.all(
  [nodesOut, piecesOut].map(
    out => out && new Promise(resolve => out.end(resolve)),
  ),
)
