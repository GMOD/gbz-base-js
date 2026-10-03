// A page that draws a reference path's haplotype overview from a graph and
// its haplotype index over HTTP, and the alignments of every haplotype under
// 300 kb, with the requests and bytes each view cost.
import { RemoteFile } from 'generic-filehandle2'

import {
  GBZBase,
  OVERVIEW_ABSENT,
  OVERVIEW_PARTIAL,
  OVERVIEW_REFERENCE,
  OVERVIEW_VARIANT,
} from '../../../src/db.ts'

import type { GbzPath } from '../../../src/db.ts'
import type { HaplotypeAlignment } from '../../../src/subgraph.ts'

const DETAIL = 300_000
const CSS = {
  absent: '#ececec',
  reference: '#cddef5',
  partial: '#f2d6a0',
  variant: ['#f09696', '#e05c5c', '#b42828', '#6e0a1e'],
  forward: '#466ebe',
  reverse: '#3c966e',
  mismatch: '#c81e1e',
  insertion: '#e68c14',
  deletion: '#fafafa',
  ink: '#282828',
  grid: '#d7d7d7',
}

function colorOf(cell: number) {
  const klass = cell & 3
  if (klass === OVERVIEW_ABSENT) {
    return CSS.absent
  }
  if (klass === OVERVIEW_REFERENCE) {
    return CSS.reference
  }
  if (klass === OVERVIEW_PARTIAL) {
    return CSS.partial
  }
  return CSS.variant[cell >> 2]!
}

function formatBp(bp: number) {
  if (bp >= 1e6) {
    return `${(bp / 1e6).toFixed(bp % 1e6 === 0 ? 0 : 2)} Mb`
  }
  if (bp >= 1e3) {
    return `${(bp / 1e3).toFixed(bp % 1e3 === 0 ? 0 : 1)} kb`
  }
  return `${bp} bp`
}

function tickStep(bpPerPixel: number, pixels = 120) {
  const least = bpPerPixel * pixels
  const power = 10 ** Math.floor(Math.log10(least))
  for (const m of [1, 2, 5, 10]) {
    if (m * power >= least) {
      return m * power
    }
  }
  return 10 * power
}

function cigarOps(cigar: string) {
  const ops: [number, string][] = []
  for (const m of cigar.matchAll(/(\d+)([MIDNSHP=X])/g)) {
    ops.push([Number(m[1]), m[2]!])
  }
  return ops
}

const form = document.getElementById('controls') as HTMLFormElement
const status = document.getElementById('status')!
const canvas = document.getElementById('canvas') as HTMLCanvasElement
const tip = document.getElementById('tip')!
const field = (name: string) =>
  form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement
const params = new URLSearchParams(location.search)
for (const name of ['graph', 'index', 'start', 'end']) {
  const value = params.get(name)
  if (value !== null) {
    field(name).value = value
  }
}

interface Session {
  graph: string
  index: string
  db: GBZBase
  paths: GbzPath[]
}
let session: Session | undefined
let drawing = Promise.resolve()
let hover:
  | {
      heatTop: number
      rowHeight: number
      xOf: (bp: number) => number
      start: number
      bpPerPixel: number
      names: string[]
      cells: Uint8Array | undefined
      bins: { start: number; end: number }[]
    }
  | undefined

async function openSession() {
  const graph = field('graph').value.trim()
  const index = field('index').value.trim()
  if (session && session.graph === graph && session.index === index) {
    return session
  }
  const db = await GBZBase.open({
    source: new RemoteFile(graph),
    haplotypeIndex: new RemoteFile(index),
  })
  const paths = (await db.paths()).filter(p => p.isIndexed)
  const select = field('path') as HTMLSelectElement
  const chosen = params.get('path') ?? select.value
  select.replaceChildren()
  const seen = new Set<string>()
  for (const p of paths) {
    const name = `${p.name.sample}#${p.name.haplotype}#${p.name.contig}`
    if (!seen.has(name)) {
      seen.add(name)
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      select.append(option)
    }
  }
  if (chosen && seen.has(chosen)) {
    select.value = chosen
  }
  session = { graph, index, db, paths }
  return session
}

function pathRef() {
  const [sample, haplotype, contig] = (
    field('path') as HTMLSelectElement
  ).value.split('#')
  return { sample: sample!, haplotype: Number(haplotype), contig: contig! }
}

async function wholeContig(db: GBZBase) {
  const [fragment] = await db.getPathFragments({
    path: pathRef(),
    start: 0,
    end: Number.MAX_SAFE_INTEGER,
  })
  return fragment ? [fragment.start, fragment.end] : [0, 1]
}

async function draw() {
  const started = performance.now()
  const { db } = await openSession()
  const path = pathRef()
  let start = Number(field('start').value)
  let end = Number(field('end').value)
  if (!(end > start)) {
    ;[start, end] = (await wholeContig(db)) as [number, number]
    field('start').value = String(start)
    field('end').value = String(end)
  }
  const width = canvas.width
  const bpPerPixel = (end - start) / width
  const detail = end - start <= DETAIL
  const before = db.fetchStats()
  const overview = await db.haplotypeOverview({
    path,
    start,
    end,
    bpPerPixel: detail ? 1 : bpPerPixel,
  })
  if (!overview) {
    status.textContent = `${field('path').value} has no overview in this index`
    return
  }
  const alignments: HaplotypeAlignment[] = detail
    ? await db.getAlignments({
        path,
        start,
        end,
        context: 1000,
        haplotypes: 'all',
      })
    : []
  const after = db.fetchStats()
  const requests =
    after.graph.fetches -
    before.graph.fetches +
    ((after.haplotypeIndex?.fetches ?? 0) -
      (before.haplotypeIndex?.fetches ?? 0))
  const bytes =
    after.graph.bytesFetched -
    before.graph.bytesFetched +
    ((after.haplotypeIndex?.bytesFetched ?? 0) -
      (before.haplotypeIndex?.bytesFetched ?? 0))
  const fetchedMs = performance.now() - started

  const haplotypes = overview.haplotypes
  const names = haplotypes.map(h => `${h.sample}#${h.haplotype}`)
  const rowOf = new Map(names.map((n, i) => [n, i]))
  const rowHeight = Math.max(
    1,
    Math.min(6, Math.floor(900 / haplotypes.length)),
  )
  const top = 4
  const densityHeight = 80
  const shareHeight = 40
  const gap = 8
  const heatTop = top + densityHeight + gap + shareHeight + gap
  const heatHeight = haplotypes.length * rowHeight
  const axisTop = heatTop + heatHeight + gap
  canvas.height = axisTop + 24
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, canvas.height)
  const xOf = (bp: number) => (bp - start) / bpPerPixel
  const rect = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
  ) => {
    ctx.fillStyle = color
    ctx.fillRect(
      Math.floor(x0),
      Math.floor(y0),
      Math.max(1, Math.ceil(x1) - Math.floor(x0)),
      Math.max(1, Math.ceil(y1) - Math.floor(y0)),
    )
  }

  const maxVariants = Math.max(1, ...overview.bins.map(b => b.variants))
  const maxExcursions = Math.max(1, ...overview.bins.map(b => b.excursions))
  for (const bin of overview.bins) {
    const x0 = xOf(bin.start)
    const x1 = Math.max(xOf(bin.end), x0 + 1)
    const small =
      (densityHeight * Math.log1p(bin.excursions)) / Math.log1p(maxExcursions)
    rect(x0, top + densityHeight - small, x1, top + densityHeight, CSS.grid)
    const sv =
      (densityHeight * Math.log1p(bin.variants)) / Math.log1p(maxVariants)
    rect(x0, top + densityHeight - sv, x1, top + densityHeight, CSS.variant[1]!)
    let y = top + densityHeight + gap
    const order: [number, string][] = [
      [bin.classes[OVERVIEW_VARIANT], CSS.variant[1]!],
      [bin.classes[OVERVIEW_PARTIAL], CSS.partial],
      [bin.classes[OVERVIEW_REFERENCE], CSS.reference],
      [bin.classes[OVERVIEW_ABSENT], CSS.absent],
    ]
    for (const [count, color] of order) {
      const h = (shareHeight * count) / haplotypes.length
      if (h > 0) {
        rect(x0, y, x1, y + h, color)
      }
      y += h
    }
  }
  overview.bins.forEach((bin, b) => {
    const x0 = xOf(bin.start)
    const x1 = Math.max(xOf(bin.end), x0 + 1)
    for (let row = 0; row < haplotypes.length; row++) {
      const y = heatTop + row * rowHeight
      rect(
        x0,
        y,
        x1,
        y + rowHeight,
        detail
          ? CSS.absent
          : colorOf(overview.cells[b * haplotypes.length + row]!),
      )
    }
  })
  let drawn = 0
  for (const alignment of alignments) {
    if (!alignment.resolved) {
      continue
    }
    const row = rowOf.get(
      `${alignment.name.sample}#${alignment.name.haplotype}`,
    )
    if (row === undefined) {
      continue
    }
    drawn += 1
    const y = heatTop + row * rowHeight
    rect(
      xOf(alignment.refStart),
      y,
      xOf(alignment.refEnd),
      y + rowHeight,
      alignment.strand === '+' ? CSS.forward : CSS.reverse,
    )
    let at = alignment.refStart
    for (const [len, op] of cigarOps(alignment.cigar)) {
      if (op === 'X') {
        rect(xOf(at), y, xOf(at + len), y + rowHeight, CSS.mismatch)
      } else if (op === 'D') {
        rect(xOf(at), y, xOf(at + len), y + rowHeight, CSS.deletion)
      } else if (op === 'I') {
        rect(xOf(at) - 1, y, xOf(at) + 1, y + rowHeight, CSS.insertion)
      }
      if (op !== 'I' && op !== 'S' && op !== 'H' && op !== 'P') {
        at += len
      }
    }
  }
  ctx.fillStyle = CSS.ink
  ctx.font = '12px system-ui, sans-serif'
  const step = tickStep(bpPerPixel)
  for (let tick = Math.ceil(start / step) * step; tick < end; tick += step) {
    const x = Math.floor(xOf(tick))
    ctx.fillRect(x, axisTop, 1, 8)
    ctx.fillText(formatBp(tick), x + 3, axisTop + 18)
  }
  const drawMs = performance.now() - started - fetchedMs
  status.textContent =
    `${field('path').value} ${formatBp(start)}-${formatBp(end)} (${formatBp(end - start)}): ` +
    (detail
      ? `${drawn} alignments of ${haplotypes.length} haplotypes over level 0 bins of ${overview.bin} bp`
      : `level ${overview.level}, ${overview.bins.length} bins of ${formatBp(overview.bin)}, ${haplotypes.length} haplotypes`) +
    `; this view ${requests} requests, ${(bytes / 1e6).toFixed(2)} MB, ${Math.round(fetchedMs)} ms fetch + ${Math.round(drawMs)} ms draw` +
    `; session ${after.graph.fetches + (after.haplotypeIndex?.fetches ?? 0)} requests, ${((after.graph.bytesFetched + (after.haplotypeIndex?.bytesFetched ?? 0)) / 1e6).toFixed(2)} MB`
  hover = {
    heatTop,
    rowHeight,
    xOf,
    start,
    bpPerPixel,
    names,
    cells: detail ? undefined : overview.cells,
    bins: overview.bins,
  }
  const url = new URL(location.href)
  for (const [k, v] of Object.entries({
    graph: field('graph').value,
    index: field('index').value,
    path: field('path').value,
    start,
    end,
  })) {
    url.searchParams.set(k, String(v))
  }
  history.replaceState(null, '', url)
}

function schedule() {
  drawing = drawing.then(draw).catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error)
  })
}

form.addEventListener('submit', event => {
  event.preventDefault()
  schedule()
})
form.addEventListener('click', event => {
  const act = (event.target as HTMLElement).dataset.act
  if (!act) {
    return
  }
  const start = Number(field('start').value)
  const end = Number(field('end').value)
  const span = end - start
  const mid = (start + end) / 2
  const set = (a: number, b: number) => {
    field('start').value = String(Math.max(0, Math.round(a)))
    field('end').value = String(Math.round(b))
  }
  if (act === 'whole') {
    set(0, 0)
  } else if (act === 'in') {
    set(mid - span / 4, mid + span / 4)
  } else if (act === 'out') {
    set(mid - span, mid + span)
  } else if (act === 'left') {
    set(start - span / 2, end - span / 2)
  } else if (act === 'right') {
    set(start + span / 2, end + span / 2)
  }
  schedule()
})
canvas.addEventListener('mousemove', event => {
  if (!hover) {
    return
  }
  const bounds = canvas.getBoundingClientRect()
  const scale = canvas.width / bounds.width
  const x = (event.clientX - bounds.left) * scale
  const y = (event.clientY - bounds.top) * scale
  const row = Math.floor((y - hover.heatTop) / hover.rowHeight)
  const bp = hover.start + x * hover.bpPerPixel
  if (row < 0 || row >= hover.names.length) {
    tip.style.display = 'none'
    return
  }
  const b = hover.bins.findIndex(bin => bin.start <= bp && bp < bin.end)
  const cell =
    hover.cells && b >= 0
      ? hover.cells[b * hover.names.length + row]!
      : undefined
  const klass =
    cell === undefined
      ? ''
      : [
          ' absent',
          ' reference',
          ' partial',
          ` variant (${['1', '2-3', '4-15', '16+'][cell >> 2]} marks)`,
        ][cell & 3]
  tip.textContent = `${hover.names[row]} at ${formatBp(Math.round(bp))}${klass}`
  tip.style.left = `${event.clientX - bounds.left + 12}px`
  tip.style.top = `${event.clientY - bounds.top + 12}px`
  tip.style.display = 'block'
})
canvas.addEventListener('mouseleave', () => {
  tip.style.display = 'none'
})
if (field('graph').value && field('index').value) {
  schedule()
}
