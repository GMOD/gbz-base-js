import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { LocalFile } from 'generic-filehandle2'

import { generate, makeRng, scales } from './gen.ts'
import { parseGfa, piecesIn } from './truth.ts'

import type { Feature, Scale } from './gen.ts'
import type { Gfa, GfaPath, Piece } from './truth.ts'
import type * as ChosenPaths from '../../src/chosenPaths.ts'
import type * as Db from '../../src/db.ts'
import type { PathName } from '../../src/pathName.ts'
import type * as Query from '../../src/query.ts'
import type { PathIdentity, SnarlOutput, Subgraph } from '../../src/subgraph.ts'

const defaultIndexArgs =
  '--interval 256 --anchor-spacing 2048 --stray-context 100'

const usage = `node test/fuzz/run.ts --seeds 0..200 [options]

  --seeds LIST        seeds to run: 7, 0..200 (200 excluded) or 3,9,40..50
  --scale NAME        small or medium (default small)
  --indexer PATH      gbz-haplotype-index binary (default $GBZ_HAPLOTYPE_INDEX,
                      else gbz-haplotype-index on PATH)
  --index-args ARGS   options for the indexer, replacing the default
                      "${defaultIndexArgs}"
  --src DIR           the library source to test (default this checkout's src/)
  --tmp DIR           where each seed's files go while it runs
  --jobs N            run the seeds in N processes
  --keep-going        continue past the first failing seed
  --dump-dir DIR      keep the GFA, database and index of each failing seed
  --windows N         random windows per seed, shared among its reference paths
                      (default 4)
  --targets N         windows per seed aimed at generated structures (default 6)
  --edge-windows N    windows per seed whose bins end or start exactly the
                      stray bound from an anchor (default 0)
  --combos N          context and snarl settings tried per window, of 8
                      (default 1)
  --keep-sets N       most keep sets per window and setting (default 20)
  --lines N           most failing queries printed per seed (default 50)`

const contexts = [0, 1, 17, 100]
const snarlSettings: SnarlOutput[] = ['none', 'contained']

interface Args {
  seeds: number[]
  scale: Scale
  indexer: string
  indexArgs: string[]
  src: string
  tmp: string
  jobs: number
  keepGoing: boolean
  dumpDir: string | undefined
  windows: number
  targets: number
  edgeWindows: number
  combos: number
  keepSets: number
  lines: number
}

type Library = Pick<typeof ChosenPaths, 'keepTuning'> &
  Pick<typeof Db, 'GBZBase'> &
  Pick<typeof Query, 'subgraphForHaplotypes' | 'subgraphInInterval'>

type GBZBase = Db.GBZBase

async function loadLibrary(src: string): Promise<Library> {
  const load = <T>(file: string) =>
    import(pathToFileURL(path.resolve(src, file)).href) as Promise<T>
  const [chosenPaths, db, query] = await Promise.all([
    load<typeof ChosenPaths>('chosenPaths.ts'),
    load<typeof Db>('db.ts'),
    load<typeof Query>('query.ts'),
  ])
  return {
    keepTuning: chosenPaths.keepTuning,
    GBZBase: db.GBZBase,
    subgraphForHaplotypes: query.subgraphForHaplotypes,
    subgraphInInterval: query.subgraphInInterval,
  }
}

interface Tally {
  seeds: number
  failedSeeds: number[]
  errors: number
  sampled: { queries: number; mismatches: number; unidentified: number }
  keep: {
    queries: number
    answered: number
    fallbacks: number
    mismatches: number
    mismatchesOnFallback: number
    missing: number
    extra: number
    routesDiffer: number
    fallbackReasons: Record<string, number>
  }
  generateMs: number
  buildMs: number
  queryMs: number
  seedMs: number[]
}

function emptyTally(): Tally {
  return {
    seeds: 0,
    failedSeeds: [],
    errors: 0,
    sampled: { queries: 0, mismatches: 0, unidentified: 0 },
    keep: {
      queries: 0,
      answered: 0,
      fallbacks: 0,
      mismatches: 0,
      mismatchesOnFallback: 0,
      missing: 0,
      extra: 0,
      routesDiffer: 0,
      fallbackReasons: {},
    },
    generateMs: 0,
    buildMs: 0,
    queryMs: 0,
    seedMs: [],
  }
}

function merge(into: Tally, from: Tally) {
  into.seeds += from.seeds
  into.failedSeeds.push(...from.failedSeeds)
  into.errors += from.errors
  into.sampled.queries += from.sampled.queries
  into.sampled.mismatches += from.sampled.mismatches
  into.sampled.unidentified += from.sampled.unidentified
  into.keep.queries += from.keep.queries
  into.keep.answered += from.keep.answered
  into.keep.fallbacks += from.keep.fallbacks
  into.keep.mismatches += from.keep.mismatches
  into.keep.mismatchesOnFallback += from.keep.mismatchesOnFallback
  into.keep.missing += from.keep.missing
  into.keep.extra += from.keep.extra
  into.keep.routesDiffer += from.keep.routesDiffer
  for (const [reason, count] of Object.entries(from.keep.fallbackReasons)) {
    into.keep.fallbackReasons[reason] =
      (into.keep.fallbackReasons[reason] ?? 0) + count
  }
  into.generateMs += from.generateMs
  into.buildMs += from.buildMs
  into.queryMs += from.queryMs
  into.seedMs.push(...from.seedMs)
}

function summary(tally: Tally) {
  const { seedMs, generateMs, buildMs, queryMs, failedSeeds, ...counts } = tally
  const sorted = [...seedMs].sort((a, b) => a - b)
  const at = (q: number) =>
    Math.round(
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0,
    )
  const mean = (total: number) => Math.round(total / Math.max(1, tally.seeds))
  const reasons = Object.entries(counts.keep.fallbackReasons).sort(
    (a, b) => b[1] - a[1],
  )
  return {
    summary: true,
    ...counts,
    keep: { ...counts.keep, fallbackReasons: Object.fromEntries(reasons) },
    queries: counts.sampled.queries + counts.keep.queries,
    failedSeeds: failedSeeds.length,
    firstFailedSeeds: [...failedSeeds].sort((a, b) => a - b).slice(0, 20),
    msPerSeed: {
      mean: mean(seedMs.reduce((sum, ms) => sum + ms, 0)),
      median: at(0.5),
      p95: at(0.95),
      max: at(1),
      generate: mean(generateMs),
      build: mean(buildMs),
      query: mean(queryMs),
    },
  }
}

const print = (line: unknown) => {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

function parseSeeds(text: string) {
  return text.split(',').flatMap(part => {
    const range = /^(\d+)\.\.(\d+)$/.exec(part)
    if (range) {
      const from = Number(range[1])
      return Array.from({ length: Number(range[2]) - from }, (_, i) => from + i)
    }
    if (!/^\d+$/.test(part)) {
      throw new Error(`--seeds: cannot read "${part}"`)
    }
    return [Number(part)]
  })
}

const flags = {
  seeds: { type: 'string' },
  scale: { type: 'string' },
  indexer: { type: 'string' },
  'index-args': { type: 'string' },
  src: { type: 'string' },
  tmp: { type: 'string' },
  jobs: { type: 'string' },
  'keep-going': { type: 'boolean' },
  'dump-dir': { type: 'string' },
  windows: { type: 'string' },
  targets: { type: 'string' },
  'edge-windows': { type: 'string' },
  combos: { type: 'string' },
  'keep-sets': { type: 'string' },
  lines: { type: 'string' },
  shard: { type: 'string' },
  help: { type: 'boolean' },
} as const

// parseArgs rejects a separate value that starts with a dash, which the
// indexer's options always do.
function joinIndexArgs(argv: string[]) {
  const joined: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1]
    if (argv[i] === '--index-args' && next !== undefined) {
      joined.push(`--index-args=${next}`)
      i += 1
    } else {
      joined.push(argv[i]!)
    }
  }
  return joined
}

function readArgs() {
  const { values } = parseArgs({
    args: joinIndexArgs(process.argv.slice(2)),
    options: flags,
  })
  if (values.help || values.seeds === undefined) {
    console.error(usage)
    process.exit(values.help ? 0 : 2)
  }
  const scale = values.scale ?? 'small'
  if (scale !== 'small' && scale !== 'medium') {
    throw new Error(`--scale: "${scale}" is neither small nor medium`)
  }
  const count = (flag: keyof typeof values, fallback: number) => {
    const value = values[flag]
    if (value === undefined) {
      return fallback
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw new Error(`--${flag}: "${value}" is not a count`)
    }
    return Number(value)
  }
  const args: Args = {
    seeds: parseSeeds(values.seeds),
    scale,
    indexer:
      values.indexer ??
      process.env.GBZ_HAPLOTYPE_INDEX ??
      'gbz-haplotype-index',
    indexArgs: (values['index-args'] ?? defaultIndexArgs)
      .split(/\s+/)
      .filter(arg => arg !== ''),
    src: values.src ?? path.join(import.meta.dirname, '../../src'),
    tmp: values.tmp ?? path.join(os.tmpdir(), 'gbz-fuzz'),
    jobs: count('jobs', 1),
    keepGoing: values['keep-going'] ?? false,
    dumpDir: values['dump-dir'],
    windows: count('windows', 4),
    targets: count('targets', 6),
    edgeWindows: count('edge-windows', 0),
    combos: count('combos', 1),
    keepSets: count('keep-sets', 20),
    lines: count('lines', 50),
  }
  return { args, shard: values.shard }
}

interface Internals {
  records: Map<number, unknown>
  paths: { path: number[]; identity: PathIdentity | undefined }[]
}

const internals = (subgraph: Subgraph) => subgraph as unknown as Internals

const haplotypeOf = (name: { sample: string; haplotype: number }) =>
  `${name.sample}#${name.haplotype}`

const pathOf = (name: PathName) =>
  `${name.sample}#${name.haplotype}#${name.contig}@${name.fragment}`

const pieceKey = (piece: Piece) =>
  `${pathOf(piece)}:${piece.hapStart}-${piece.hapEnd}`

const clip = (text: string) =>
  text.length > 160 ? `${text.slice(0, 160)}… (${text.length} chars)` : text

function handlesText(handles: number[], reverse: boolean) {
  const steps = handles.map(handle => ({
    id: handle >> 1,
    flipped: (handle % 2 === 1) !== reverse,
  }))
  return (reverse ? steps.reverse() : steps)
    .map(step => `${step.flipped ? '<' : '>'}${step.id}`)
    .join('')
}

const pieceText = (piece: Piece) =>
  piece.nodes.map(([id, flipped]) => `${flipped ? '<' : '>'}${id}`).join('')

// Compares a subgraph's walks with the pieces the GFA gives. A piece may
// appear once in each orientation; anything else out of place is `extra`.
function compare(subgraph: Subgraph, expected: Piece[]) {
  const wanted = new Map(expected.map(piece => [pieceKey(piece), piece]))
  const seen = new Map<string, Set<string>>()
  const extra: string[] = []
  let unidentified = 0
  for (const { path: handles, identity } of internals(subgraph).paths) {
    if (!identity) {
      unidentified += 1
      extra.push(`unidentified ${clip(handlesText(handles, false))}`)
      continue
    }
    const key = `${pathOf(identity.name)}:${identity.hapStart}-${identity.hapEnd}`
    const walk = handlesText(handles, identity.orientation === 'reverse')
    const piece = wanted.get(key)
    const orientations = seen.get(key) ?? new Set<string>()
    if (!piece) {
      extra.push(`${key} ${identity.orientation} ${clip(walk)}`)
    } else if (pieceText(piece) !== walk) {
      extra.push(
        `${key} ${identity.orientation} walks ${clip(walk)} where the GFA has ${clip(pieceText(piece))}`,
      )
    } else if (orientations.has(identity.orientation)) {
      extra.push(`${key} ${identity.orientation} a second time`)
    }
    orientations.add(identity.orientation)
    seen.set(key, orientations)
  }
  const missing = expected
    .filter(piece => !seen.has(pieceKey(piece)))
    .map(piece => `${pieceKey(piece)} ${clip(pieceText(piece))}`)
  return { missing, extra, unidentified }
}

// The sampled route's subgraph narrowed to the kept haplotypes, leaving the
// subgraph itself whole for the next keep set.
function narrowedCopy(sampled: Subgraph, keep: (name: PathName) => boolean) {
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(sampled) as object) as Subgraph,
    sampled,
  )
  const inner = internals(copy)
  inner.records = new Map(inner.records)
  inner.paths = [...inner.paths]
  copy.keepHaplotypes(keep)
  return copy
}

const walkList = (subgraph: Subgraph) =>
  internals(subgraph).paths.map(({ path: handles, identity }) =>
    identity
      ? `${pathOf(identity.name)}:${identity.hapStart}-${identity.hapEnd} ${identity.orientation} ${clip(handlesText(handles, false))}`
      : `unidentified ${clip(handlesText(handles, false))}`,
  )

type Rng = ReturnType<typeof makeRng>

interface Window {
  start: number
  end: number
  target: string | undefined
}

function randomWindows(length: number, count: number, rng: Rng) {
  const windows: Window[] = []
  const size = () => {
    const kind = rng.next()
    return kind < 0.4
      ? rng.int(1, 50)
      : kind < 0.75
        ? rng.int(51, 2000)
        : rng.int(2001, length)
  }
  for (let i = 0; i < count; i++) {
    const span = Math.min(length, rng.chance(0.05) ? length : size())
    const place = rng.next()
    const start =
      place < 0.15 ? 0 : place < 0.3 ? length - span : rng.int(0, length - span)
    windows.push({ start, end: start + span, target: undefined })
  }
  return windows
}

// Where a reference path first visits the generator's reference nodes, by id.
function firstVisits(reference: GfaPath, gfa: Gfa) {
  const visits = new Map<number, [number, number]>()
  reference.ids.forEach((id, i) => {
    if (!visits.has(id)) {
      const start = reference.offsets[i]!
      visits.set(id, [start, start + gfa.nodeLengths.get(id)!])
    }
  })
  return (id: number) => {
    for (let d = 0; d < 50; d++) {
      const visit = visits.get(id + d) ?? visits.get(id - d)
      if (visit) {
        return visit
      }
    }
    return undefined
  }
}

function targetedWindows(
  reference: GfaPath,
  gfa: Gfa,
  features: Feature[],
  count: number,
  rng: Rng,
) {
  const visit = firstVisits(reference, gfa)
  const length = reference.length
  const windows: Window[] = []
  for (let i = 0; i < count && features.length > 0; i++) {
    const feature = rng.pick(features)
    const first = visit(feature.firstNode)
    const last = visit(feature.lastNode)
    if (first && last) {
      const s = Math.min(first[0], last[0])
      const e = Math.max(first[1], last[1])
      const gap = rng.pick([0, 0, 1, rng.int(2, 150)])
      const width = rng.int(1, 300)
      const inside = rng.int(s, e - 1)
      const [start, end] = rng.pick([
        [s, e],
        [s - gap - width, s - gap],
        [e + gap, e + gap + width],
        [s - rng.int(1, 200), s + rng.int(1, 200)],
        [e - rng.int(1, 200), e + rng.int(1, 200)],
        [inside, inside + rng.int(1, 20)],
      ])
      const from = Math.min(Math.max(start, 0), length - 1)
      windows.push({
        start: from,
        end: Math.min(Math.max(end, from + 1), length),
        target: feature.kind,
      })
    }
  }
  return windows
}

// Windows whose bins end exactly `bound` before an anchor's node or start
// exactly `bound` after one, and one bin to either side of that, plus windows
// ending and starting at the anchor itself. These are the edges of the
// indexer's `reached` rule, where an inclusive bound on one side and an
// exclusive one on the other would leave a section unplanned. Only a bin
// boundary can land there, so `--stray-bin 1` reaches every anchor.
async function edgeWindows(
  reference: GfaPath,
  db: GBZBase,
  count: number,
  rng: Rng,
) {
  const spacing = await db.haplotypeAnchorSpacing()
  const strays = await db.haplotypeStrayOptions()
  const handle = (await db.paths()).find(
    p => pathOf(p.name) === pathOf(reference),
  )?.handle
  if (spacing === undefined || strays === undefined || handle === undefined) {
    return []
  }
  const length = reference.length
  const { bin, bound } = strays
  const candidates: Window[] = []
  const endingAt = (hi: number) => {
    if (hi > 0 && hi <= length && hi % bin === 0) {
      const start = Math.max(0, hi - rng.int(1, 300))
      candidates.push({ start, end: hi, target: 'edge' })
    }
  }
  const startingAt = (lo: number) => {
    if (lo >= 0 && lo < length && lo % bin === 0) {
      candidates.push({
        start: lo,
        end: Math.min(length, lo + rng.int(1, 300)),
        target: 'edge',
      })
    }
  }
  for (let k = 1; ; k++) {
    const anchor = await db.haplotypeAnchor(handle, k * spacing)
    if (!anchor) {
      break
    }
    const p = anchor.pathOffset
    for (const d of [-1, 0, 1]) {
      endingAt(p - bound + d)
      endingAt(p - bound + d * bin)
      startingAt(p + bound + d)
      startingAt(p + bound + d * bin)
    }
    endingAt(p)
    startingAt(p)
  }
  const windows: Window[] = []
  while (candidates.length > 0 && windows.length < count) {
    windows.push(candidates.splice(rng.int(0, candidates.length - 1), 1)[0]!)
  }
  return windows
}

// Each haplotype with a piece, each sample with one, a random subset and
// everything. Past `most`, random single haplotypes and samples go.
function keepSetsFor(
  pieces: Piece[],
  haplotypes: string[],
  most: number,
  rng: Rng,
) {
  const present = [...new Set(pieces.map(haplotypeOf))].sort()
  const samples = [...new Set(pieces.map(piece => piece.sample))].sort()
  const chosen = [
    ...present.map(name => [name]),
    ...samples.map(sample =>
      haplotypes.filter(name => name.startsWith(`${sample}#`)),
    ),
  ]
  while (chosen.length > Math.max(0, most - 2)) {
    chosen.splice(rng.int(0, chosen.length - 1), 1)
  }
  chosen.push(
    haplotypes.filter(() => rng.chance(0.5)),
    haplotypes,
  )
  const distinct = new Map(chosen.map(set => [set.join(' '), set]))
  return [...distinct.values()]
}

function build(dir: string, gfaText: string, args: Args) {
  fs.mkdirSync(dir, { recursive: true })
  const file = (name: string) => path.join(dir, name)
  const run = (command: string, options: string[]) =>
    execFileSync(command, options, { stdio: ['ignore', 'pipe', 'pipe'] })
  fs.writeFileSync(file('graph.gfa'), gfaText)
  run('vg', [
    'gbwt',
    '-G',
    file('graph.gfa'),
    '--gbz-format',
    '-g',
    file('graph.gbz'),
    '--translation',
    file('graph.translation'),
  ])
  const translation = fs.readFileSync(file('graph.translation'), 'utf8')
  for (const line of translation.split('\n')) {
    const [type, segment, nodes] = line.split('\t')
    if (type === 'T' && segment !== nodes) {
      throw new Error(
        `vg renumbered segment ${segment} as ${nodes}: the GFA's ids are not the graph's`,
      )
    }
  }
  run('gbz-base', ['construct', file('graph.gbz'), '-o', file('graph.gbz.db')])
  run(args.indexer, [
    ...args.indexArgs,
    file('graph.gbz'),
    file('graph.gbz.db'),
    file('graph.haplotype-index.db'),
  ])
  return {
    graph: file('graph.gbz.db'),
    index: file('graph.haplotype-index.db'),
  }
}

// The database must hold the GFA's nodes under the GFA's ids and its walks
// under the GFA's names, or no comparison below means anything.
async function checkGraph(db: GBZBase, gfa: Gfa) {
  for (const [id, length] of gfa.nodeLengths) {
    const record = await db.getRecord(2 * id)
    if (record?.sequenceLen !== length) {
      throw new Error(
        `node ${id} is ${record?.sequenceLen} bp in the database and ${length} bp in the GFA`,
      )
    }
  }
  const stored = (await db.paths()).map(p => pathOf(p.name)).sort()
  const written = gfa.paths.map(pathOf).sort()
  if (stored.join(' ') !== written.join(' ')) {
    throw new Error(
      `the database names its paths ${stored.join(' ')} and the GFA ${written.join(' ')}`,
    )
  }
}

async function runSeed(
  seed: number,
  args: Args,
  library: Library,
  tally: Tally,
) {
  let failures = 0
  const report = (line: Record<string, unknown>) => {
    failures += 1
    if (failures <= args.lines) {
      print({ seed, scale: args.scale, ...line })
    }
  }
  const started = performance.now()
  const dir = path.join(args.tmp, `seed-${seed}-${process.pid}`)
  const files: LocalFile[] = []
  try {
    const generated = generate({ seed, ...scales[args.scale] })
    const gfa = parseGfa(generated.gfa)
    const generatedAt = performance.now()
    tally.generateMs += generatedAt - started
    const built = build(dir, generated.gfa, args)
    const builtAt = performance.now()
    tally.buildMs += builtAt - generatedAt
    files.push(new LocalFile(built.graph), new LocalFile(built.index))
    const db = await library.GBZBase.open(files[0]!, {
      haplotypeIndex: files[1]!,
    })
    await checkGraph(db, gfa)

    const rng = makeRng(seed ^ 0x5bd1e995)
    const haplotypes = [...new Set(gfa.paths.map(haplotypeOf))].sort()
    const references = gfa.paths.filter(p =>
      gfa.referenceSamples.includes(p.sample),
    )
    const share = (count: number, index: number) =>
      Math.floor(count / references.length) +
      (index < count % references.length ? 1 : 0)
    const windowsOf: Window[][] = []
    for (const [index, reference] of references.entries()) {
      windowsOf.push([
        ...randomWindows(reference.length, share(args.windows, index), rng),
        ...targetedWindows(
          reference,
          gfa,
          generated.features,
          share(args.targets, index),
          rng,
        ),
        ...(await edgeWindows(
          reference,
          db,
          share(args.edgeWindows, index),
          rng,
        )),
      ])
    }
    // Each window draws from its own generator, so what the library answers
    // for one window leaves the queries of the next as they were.
    let windowCount = 0
    for (const [index, reference] of references.entries()) {
      const query = { sample: reference.sample, contig: reference.contig }
      for (const window of windowsOf[index]!) {
        windowCount += 1
        const rng = makeRng((seed ^ 0x5bd1e995) + 0x9e3779b9 * windowCount)
        const start = reference.fragment + window.start
        const end = reference.fragment + window.end
        const windowNodes = new Set(
          reference.ids.filter((id, i) => {
            const offset = reference.offsets[i]!
            return (
              offset < window.end &&
              offset + gfa.nodeLengths.get(id)! > window.start
            )
          }),
        )
        const combos = contexts.flatMap(context =>
          snarlSettings.map(snarls => ({ context, snarls })),
        )
        while (combos.length > Math.max(1, args.combos)) {
          combos.splice(rng.int(0, combos.length - 1), 1)
        }
        for (const opts of combos) {
          const asked = {
            reference: pathOf(reference),
            start,
            end,
            ...opts,
            target: window.target,
          }
          tally.sampled.queries += 1
          let truth: Piece[]
          let sampled: Subgraph
          try {
            sampled = await library.subgraphInInterval(
              db,
              query,
              start,
              end,
              opts,
            )
            const nodes = new Set(
              [...internals(sampled).records.keys()].map(handle => handle >> 1),
            )
            await sampled.identifyPaths()
            truth = piecesIn(gfa, nodes)
            const { missing, extra, unidentified } = compare(sampled, truth)
            const absent = [...windowNodes].filter(id => !nodes.has(id))
            const beyond =
              opts.context === 0 && opts.snarls === 'none'
                ? [...nodes].filter(id => !windowNodes.has(id))
                : []
            tally.sampled.unidentified += unidentified
            if (missing.length + extra.length + absent.length + beyond.length) {
              tally.sampled.mismatches += 1
              report({
                ...asked,
                route: 'sampled',
                missing,
                extra,
                unidentified,
                ...(absent.length + beyond.length > 0
                  ? { windowNodesAbsent: absent, nodesBeyondWindow: beyond }
                  : {}),
              })
            }
          } catch (error) {
            tally.sampled.mismatches += 1
            tally.errors += 1
            report({ ...asked, route: 'sampled', error: String(error) })
            continue
          }
          const ownPiece = truth.find(
            piece =>
              pathOf(piece) === pathOf(reference) &&
              piece.hapStart <= window.start &&
              piece.hapEnd >= window.end,
          )
          if (!ownPiece) {
            throw new Error(
              `${pathOf(reference)}:${start}-${end} lies in no piece of its own path`,
            )
          }
          for (const set of keepSetsFor(
            truth,
            haplotypes,
            args.keepSets,
            rng,
          )) {
            const names = new Set(set)
            const keep = (name: PathName) => names.has(haplotypeOf(name))
            const kept = set.length === haplotypes.length ? 'everything' : set
            tally.keep.queries += 1
            let fallback: string | undefined
            let route = 'keep'
            try {
              const subgraph = await library.subgraphForHaplotypes(
                db,
                query,
                start,
                end,
                { ...opts, keep },
              )
              fallback = subgraph.stats.keep
                ? subgraph.stats.keep.fallback
                : 'no keep statistics'
              if (fallback === undefined) {
                tally.keep.answered += 1
              } else {
                route = 'fallback'
                tally.keep.fallbacks += 1
                const reason = fallback.replace(/\d+/g, 'N').slice(0, 60)
                tally.keep.fallbackReasons[reason] =
                  (tally.keep.fallbackReasons[reason] ?? 0) + 1
              }
              const { missing, extra, unidentified } = compare(
                subgraph,
                truth.filter(
                  piece => piece === ownPiece || names.has(haplotypeOf(piece)),
                ),
              )
              if (missing.length + extra.length > 0) {
                tally.keep.mismatches += 1
                tally.keep.mismatchesOnFallback +=
                  fallback === undefined ? 0 : 1
                tally.keep.missing += missing.length > 0 ? 1 : 0
                tally.keep.extra += extra.length > 0 ? 1 : 0
                report({
                  ...asked,
                  route,
                  keep: kept,
                  fallback,
                  missing,
                  extra,
                  unidentified,
                })
              } else if (fallback === undefined) {
                const narrowed = narrowedCopy(sampled, keep)
                const names = { names: 'resolved' } as const
                if (
                  (await subgraph.toGFA(names)) !==
                    (await narrowed.toGFA(names)) ||
                  JSON.stringify(subgraph.alignments()) !==
                    JSON.stringify(narrowed.alignments())
                ) {
                  tally.keep.mismatches += 1
                  tally.keep.routesDiffer += 1
                  report({
                    ...asked,
                    route,
                    keep: kept,
                    routesDiffer: walkList(subgraph).filter(
                      walk => !walkList(narrowed).includes(walk),
                    ),
                    sampledOnly: walkList(narrowed).filter(
                      walk => !walkList(subgraph).includes(walk),
                    ),
                  })
                }
              }
            } catch (error) {
              tally.keep.mismatches += 1
              tally.errors += 1
              report({
                ...asked,
                route,
                keep: kept,
                fallback,
                error: String(error),
              })
            }
          }
        }
      }
    }
    tally.queryMs += performance.now() - builtAt
  } catch (error) {
    tally.errors += 1
    report({ error: String(error).slice(0, 2000) })
  }
  await Promise.all(files.map(file => file.close()))
  if (failures > 0) {
    tally.failedSeeds.push(seed)
    if (failures > args.lines) {
      print({ seed, scale: args.scale, unprinted: failures - args.lines })
    }
    if (args.dumpDir !== undefined && fs.existsSync(dir)) {
      const kept = path.join(args.dumpDir, `${args.scale}-seed-${seed}`)
      fs.rmSync(kept, { recursive: true, force: true })
      fs.mkdirSync(args.dumpDir, { recursive: true })
      fs.cpSync(dir, kept, { recursive: true })
    }
  }
  fs.rmSync(dir, { recursive: true, force: true })
  tally.seeds += 1
  tally.seedMs.push(performance.now() - started)
  return failures === 0
}

async function runSeeds(seeds: number[], args: Args) {
  const library = await loadLibrary(args.src)
  library.keepTuning.mostChosenPaths = Infinity
  const tally = emptyTally()
  for (const seed of seeds) {
    const passed = await runSeed(seed, args, library, tally)
    if (!passed && !args.keepGoing) {
      break
    }
  }
  return tally
}

async function runJobs(args: Args) {
  const tally = emptyTally()
  const children = Array.from({ length: args.jobs }, (_, shard) =>
    spawn(
      process.execPath,
      [
        import.meta.filename,
        ...process.argv.slice(2),
        '--shard',
        `${shard}/${args.jobs}`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    ),
  )
  let stopping = false
  await Promise.all(
    children.map(
      child =>
        new Promise<void>((resolve, reject) => {
          let reported = false
          readline.createInterface({ input: child.stdout }).on('line', line => {
            if (line.startsWith('{"shard":')) {
              reported = true
              merge(tally, (JSON.parse(line) as { shard: Tally }).shard)
            } else {
              process.stdout.write(`${line}\n`)
            }
          })
          child.on('error', reject)
          child.on('close', code => {
            if (!reported && !stopping) {
              tally.errors += 1
              print({ error: `a job exited with code ${code} and no tally` })
            }
            if (code !== 0 && !args.keepGoing) {
              stopping = true
              for (const other of children) {
                other.kill()
              }
            }
            resolve()
          })
        }),
    ),
  )
  for (const entry of fs.readdirSync(args.tmp)) {
    if (children.some(child => entry.endsWith(`-${child.pid}`))) {
      fs.rmSync(path.join(args.tmp, entry), { recursive: true, force: true })
    }
  }
  return tally
}

const { args, shard } = readArgs()
fs.mkdirSync(args.tmp, { recursive: true })
if (shard === undefined) {
  const tally =
    args.jobs > 1 ? await runJobs(args) : await runSeeds(args.seeds, args)
  print(summary(tally))
  process.exitCode =
    tally.failedSeeds.length > 0 || tally.errors > 0 || tally.seeds === 0
      ? 1
      : 0
} else {
  const [index, of] = shard.split('/').map(Number) as [number, number]
  const tally = await runSeeds(
    args.seeds.filter((_, i) => i % of === index),
    args,
  )
  print({ shard: tally })
  process.exitCode = tally.failedSeeds.length > 0 ? 1 : 0
}
