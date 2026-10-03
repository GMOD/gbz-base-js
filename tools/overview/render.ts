// Renders a window of a reference path to a PNG from the haplotype index's
// overview: a track of variant excursions per bin, the share of haplotypes
// in each class, and one row per haplotype coloured by its class. Under
// DETAIL bp it draws every haplotype's alignment from the graph instead, on
// the same rows, with the overview's level 0 behind them. Prints one JSON
// line of what it read.
//
//   node tools/overview/render.ts <graph> <index> <sample#hap#contig> <start> <end> <out.png> [width]
//
// With end at or below start the whole contig is drawn. Graph and index are
// paths or http(s) URLs.
import { writeFileSync } from 'node:fs'

import { LocalFile, RemoteFile } from 'generic-filehandle2'

import { Canvas, text } from './png.ts'
import {
  GBZBase,
  OVERVIEW_ABSENT,
  OVERVIEW_PARTIAL,
  OVERVIEW_REFERENCE,
  OVERVIEW_VARIANT,
} from '../../src/db.ts'

export const DETAIL = 300_000

export const COLORS = {
  absent: [236, 236, 236],
  reference: [205, 222, 245],
  partial: [242, 214, 160],
  variant: [
    [240, 150, 150],
    [224, 92, 92],
    [180, 40, 40],
    [110, 10, 30],
  ],
  forward: [70, 110, 190],
  reverse: [60, 150, 110],
  mismatch: [200, 30, 30],
  insertion: [230, 140, 20],
  deletion: [250, 250, 250],
  ink: [40, 40, 40],
  grid: [215, 215, 215],
}

export function colorOf(cell: number) {
  const klass = cell & 3
  if (klass === OVERVIEW_ABSENT) {
    return COLORS.absent
  }
  if (klass === OVERVIEW_REFERENCE) {
    return COLORS.reference
  }
  if (klass === OVERVIEW_PARTIAL) {
    return COLORS.partial
  }
  return COLORS.variant[cell >> 2]!
}

export function formatBp(bp: number) {
  if (bp >= 1e6) {
    return `${(bp / 1e6).toFixed(bp % 1e6 === 0 ? 0 : 2)} Mb`
  }
  if (bp >= 1e3) {
    return `${(bp / 1e3).toFixed(bp % 1e3 === 0 ? 0 : 1)} kb`
  }
  return `${bp} bp`
}

// Tick spacing of 1, 2 or 5 times a power of ten, at least `pixels` apart.
export function tickStep(bpPerPixel: number, pixels = 120) {
  const least = bpPerPixel * pixels
  const power = 10 ** Math.floor(Math.log10(least))
  for (const m of [1, 2, 5, 10]) {
    if (m * power >= least) {
      return m * power
    }
  }
  return 10 * power
}

export function cigarOps(cigar: string) {
  const ops: [number, string][] = []
  for (const m of cigar.matchAll(/(\d+)([MIDNSHP=X])/g)) {
    ops.push([Number(m[1]), m[2]!])
  }
  return ops
}

const [graphArg, indexArg, pathArg, startArg, endArg, outArg, widthArg] =
  process.argv.slice(2)
if (!outArg) {
  throw new Error(
    'usage: render.ts <graph> <index> <sample#hap#contig> <start> <end> <out.png> [width]',
  )
}
const open = (file: string) =>
  /^https?:\/\//.test(file) ? new RemoteFile(file) : new LocalFile(file)
const width = Number(widthArg ?? 1800)
const [sample, haplotypeText, contig] = pathArg!.split('#')
const path = {
  sample: sample!,
  haplotype: Number(haplotypeText),
  contig: contig!,
}

const started = performance.now()
const db = await GBZBase.open({
  source: open(graphArg!),
  haplotypeIndex: open(indexArg!),
})
await db.paths()
let start = Number(startArg)
let end = Number(endArg)
if (!(end > start)) {
  const [fragment] = await db.getPathFragments({
    path,
    start: 0,
    end: Number.MAX_SAFE_INTEGER,
  })
  start = fragment!.start
  end = fragment!.end
}
const opened = { ...db.fetchStats(), ms: performance.now() - started }
const bpPerPixel = (end - start) / width
const detail = end - start <= DETAIL

const overview = await db.haplotypeOverview({
  path,
  start,
  end,
  bpPerPixel: detail ? 1 : bpPerPixel,
})
if (!overview) {
  throw new Error(`no overview for ${pathArg}`)
}
const alignments = detail
  ? await db.getAlignments({
      path,
      start,
      end,
      context: 1000,
      haplotypes: 'all',
    })
  : []
const fetched = { ...db.fetchStats(), ms: performance.now() - started }

const haplotypes = overview.haplotypes
const rowOf = new Map(
  haplotypes.map((h, i) => [`${h.sample}#${h.haplotype}`, i]),
)
const rowHeight = Math.max(1, Math.min(6, Math.floor(900 / haplotypes.length)))
const top = 30
const densityHeight = 80
const shareHeight = 40
const gap = 8
const heatTop = top + densityHeight + gap + shareHeight + gap
const heatHeight = haplotypes.length * rowHeight
const axisTop = heatTop + heatHeight + gap
const canvas = new Canvas(width, axisTop + 40)
const xOf = (bp: number) => (bp - start) / bpPerPixel

const maxVariants = Math.max(1, ...overview.bins.map(b => b.variants))
const maxExcursions = Math.max(1, ...overview.bins.map(b => b.excursions))
for (const bin of overview.bins) {
  const x0 = xOf(bin.start)
  const x1 = Math.max(xOf(bin.end), x0 + 1)
  const small =
    (densityHeight * Math.log1p(bin.excursions)) / Math.log1p(maxExcursions)
  canvas.fill(
    x0,
    top + densityHeight - small,
    x1,
    top + densityHeight,
    COLORS.grid,
  )
  const sv =
    (densityHeight * Math.log1p(bin.variants)) / Math.log1p(maxVariants)
  canvas.fill(
    x0,
    top + densityHeight - sv,
    x1,
    top + densityHeight,
    COLORS.variant[1]!,
  )
  const shareTop = top + densityHeight + gap
  let y = shareTop
  const order: [number, number[]][] = [
    [bin.classes[OVERVIEW_VARIANT], COLORS.variant[1]!],
    [bin.classes[OVERVIEW_PARTIAL], COLORS.partial],
    [bin.classes[OVERVIEW_REFERENCE], COLORS.reference],
    [bin.classes[OVERVIEW_ABSENT], COLORS.absent],
  ]
  for (const [count, color] of order) {
    const h = (shareHeight * count) / haplotypes.length
    canvas.fill(x0, y, x1, y + h, color)
    y += h
  }
}

overview.bins.forEach((bin, b) => {
  const x0 = xOf(bin.start)
  const x1 = Math.max(xOf(bin.end), x0 + 1)
  for (let row = 0; row < haplotypes.length; row++) {
    const cell = overview.cells[b * haplotypes.length + row]!
    const y = heatTop + row * rowHeight
    canvas.fill(
      x0,
      y,
      x1,
      y + rowHeight,
      detail ? COLORS.absent : colorOf(cell),
    )
  }
})

let drawn = 0
for (const alignment of alignments) {
  if (!alignment.resolved) {
    continue
  }
  const row = rowOf.get(`${alignment.name.sample}#${alignment.name.haplotype}`)
  if (row === undefined) {
    continue
  }
  drawn += 1
  const y = heatTop + row * rowHeight
  const strand = alignment.strand === '+' ? COLORS.forward : COLORS.reverse
  canvas.fill(
    xOf(alignment.refStart),
    y,
    xOf(alignment.refEnd),
    y + rowHeight,
    strand,
  )
  let at = alignment.refStart
  for (const [len, op] of cigarOps(alignment.cigar)) {
    if (op === 'X') {
      canvas.fill(
        xOf(at),
        y,
        Math.max(xOf(at + len), xOf(at) + 1),
        y + rowHeight,
        COLORS.mismatch,
      )
    } else if (op === 'D') {
      canvas.fill(
        xOf(at),
        y,
        Math.max(xOf(at + len), xOf(at) + 1),
        y + rowHeight,
        COLORS.deletion,
      )
    } else if (op === 'I') {
      canvas.fill(xOf(at) - 1, y, xOf(at) + 1, y + rowHeight, COLORS.insertion)
    }
    if (op !== 'I' && op !== 'S' && op !== 'H' && op !== 'P') {
      at += len
    }
  }
}

const step = tickStep(bpPerPixel)
for (let tick = Math.ceil(start / step) * step; tick < end; tick += step) {
  const x = xOf(tick)
  canvas.fill(x, axisTop, x + 1, axisTop + 8, COLORS.ink)
  text(canvas, x + 3, axisTop + 2, formatBp(tick), COLORS.ink, 2)
}
const requests = fetched.graph.fetches + (fetched.haplotypeIndex?.fetches ?? 0)
const bytes =
  fetched.graph.bytesFetched + (fetched.haplotypeIndex?.bytesFetched ?? 0)
text(
  canvas,
  4,
  6,
  `${pathArg} ${formatBp(start)}-${formatBp(end)} (${formatBp(end - start)}) ${
    detail
      ? `${drawn} alignments over level 0 bins of ${overview.bin} bp`
      : `level ${overview.level} bins of ${formatBp(overview.bin)} ${overview.bins.length} bins`
  } ${haplotypes.length} haplotypes ${requests} requests ${(bytes / 1e6).toFixed(1)} MB ${Math.round(fetched.ms)} ms`,
  COLORS.ink,
  2,
)
writeFileSync(outArg, canvas.png())
console.log(
  JSON.stringify({
    path: pathArg,
    start,
    end,
    detail,
    level: overview.level,
    bin: overview.bin,
    bins: overview.bins.length,
    haplotypes: haplotypes.length,
    alignments: drawn,
    open: {
      requests: opened.graph.fetches + (opened.haplotypeIndex?.fetches ?? 0),
      ms: Math.round(opened.ms),
    },
    total: {
      graphRequests: fetched.graph.fetches,
      indexRequests: fetched.haplotypeIndex?.fetches,
      bytes,
      ms: Math.round(fetched.ms),
    },
    out: outArg,
  }),
)
