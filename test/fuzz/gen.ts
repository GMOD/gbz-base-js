// A walk is a list of signed node ids: n runs node n forward, -n in reverse.
export type Walk = number[]

export interface GenOptions {
  seed: number
  refBp: [number, number]
  refNodes: [number, number]
  haplotypes: [number, number]
  maxNodeLen: number
  largeInsertionBp: [number, number]
  // the most sites of each structural kind a graph carries
  structural: number
}

export type Scale = 'small' | 'medium'

export const scales: Record<Scale, Omit<GenOptions, 'seed'>> = {
  small: {
    refBp: [4000, 15000],
    refNodes: [30, 120],
    haplotypes: [3, 8],
    maxNodeLen: 1000,
    largeInsertionBp: [300, 3000],
    structural: 2,
  },
  medium: {
    refBp: [20000, 60000],
    refNodes: [100, 400],
    haplotypes: [6, 16],
    maxNodeLen: 1000,
    largeInsertionBp: [1000, 10000],
    structural: 3,
  },
}

export interface GeneratedWalk {
  sample: string
  haplotype: number
  contig: string
  start: number
  end: number
  steps: Walk
}

// Where the generator placed a structure: a run of GRCh38#0#chr1 nodes, which
// that path visits in id order, and the run's coordinates along it.
export interface Feature {
  kind: string
  firstNode: number
  lastNode: number
  refStart: number
  refEnd: number
}

export interface Generated {
  gfa: string
  referenceSamples: string[]
  walks: GeneratedWalk[]
  features: Feature[]
  counts: Record<string, number>
}

type SiteKind =
  | 'snp'
  | 'insertion'
  | 'deletion'
  | 'large-deletion'
  | 'large-insertion'
  | 'inversion'
  | 'tandem-duplication'
  | 'dispersed-duplication'
  | 'hairpin'
  | 'self-loop'

const simpleKinds = new Set<SiteKind>([
  'snp',
  'insertion',
  'deletion',
  'self-loop',
])

// A site replaces reference nodes [a, b) on the haplotypes that carry it.
// `carriers` maps a haplotype to the allele it carries.
interface Site {
  kind: SiteKind
  a: number
  b: number
  carriers: Map<number, number>
  alleles: Walk[]
  copies: number
  source: [number, number]
}

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeRng(seed: number) {
  const next = mulberry32(seed)
  const int = (lo: number, hi: number) =>
    lo + Math.floor(next() * (Math.max(lo, hi) - lo + 1))
  return {
    next,
    int,
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]) => items[int(0, items.length - 1)]!,
  }
}

const reverseComplement = (walk: Walk) => walk.map(step => -step).reverse()

const linkLine = (from: number, to: number) =>
  `L\t${Math.abs(from)}\t${from < 0 ? '-' : '+'}\t${Math.abs(to)}\t${to < 0 ? '-' : '+'}\t0M`

const walkText = (walk: Walk) =>
  walk.map(step => (step < 0 ? `<${-step}` : `>${step}`)).join('')

export function generate(opts: GenOptions): Generated {
  const rng = makeRng(opts.seed)
  const { int, chance, pick } = rng

  const lengths = [0]
  const newNode = (len: number) => lengths.push(len) - 1
  const newRun = (count: number, lo: number, hi: number) =>
    Array.from({ length: count }, () => newNode(int(lo, hi)))
  const bp = (walk: Walk) =>
    walk.reduce((sum, step) => sum + lengths[Math.abs(step)]!, 0)

  const longShare = 0.03 + rng.next() * 0.25
  const midShare = rng.next() * 0.3
  const targetBp = int(...opts.refBp)
  let refBp = 0
  while (
    lengths.length - 1 < opts.refNodes[0] ||
    (refBp < targetBp && lengths.length - 1 < opts.refNodes[1])
  ) {
    const r = rng.next()
    const len =
      r < longShare
        ? int(200, opts.maxNodeLen)
        : r < longShare + midShare
          ? int(61, 199)
          : int(1, 60)
    newNode(len)
    refBp += len
  }
  const refCount = lengths.length - 1
  const prefix = [0]
  for (let i = 1; i <= refCount; i++) {
    prefix.push(prefix[i - 1]! + lengths[i]!)
  }
  const isPrivate = (step: number) => Math.abs(step) > refCount

  const sampleHaplotypes: { sample: string; haplotype: number }[] = []
  const haplotypeCount = int(...opts.haplotypes)
  for (let s = 1; sampleHaplotypes.length < haplotypeCount; s++) {
    const sample = `HG${String(s).padStart(3, '0')}`
    const both = chance(0.7)
    for (const haplotype of both ? [1, 2] : [int(1, 2)]) {
      sampleHaplotypes.push({ sample, haplotype })
    }
  }
  const hapCount = sampleHaplotypes.length
  const secondReference = chance(0.4)
  const chm13 = hapCount

  const sites: Site[] = []
  const counts: Record<string, number> = {}
  const features: Feature[] = []
  const feature = (kind: string, a: number, b: number) => {
    const first = Math.min(Math.max(a, 0), refCount - 1)
    const last = Math.min(Math.max(b, first + 1), refCount)
    features.push({
      kind,
      firstNode: first + 1,
      lastNode: last,
      refStart: prefix[first]!,
      refEnd: prefix[last]!,
    })
  }
  const carriersOf = (alleles: number, structural: boolean) => {
    const mode = rng.next()
    const frequency =
      mode < 0.3
        ? 0
        : mode < 0.6
          ? 0.1 + 0.2 * rng.next()
          : 0.3 + 0.6 * rng.next()
    const carriers = new Map<number, number>()
    for (let h = 0; h < hapCount; h++) {
      if (chance(frequency)) {
        carriers.set(h, int(0, alleles - 1))
      }
    }
    if (carriers.size === 0) {
      carriers.set(int(0, hapCount - 1), int(0, alleles - 1))
    }
    if (secondReference && chance(structural ? 0.2 : 0.4)) {
      carriers.set(chm13, int(0, alleles - 1))
    }
    return carriers
  }
  const addSite = (
    kind: SiteKind,
    a: number,
    span: number,
    alleles: Walk[],
    alleleCount: number,
    extra: { copies?: number; source?: [number, number] } = {},
  ) => {
    const b = Math.min(a + span, refCount)
    sites.push({
      kind,
      a,
      b,
      carriers: carriersOf(alleleCount, !simpleKinds.has(kind)),
      alleles,
      copies: extra.copies ?? 1,
      source: extra.source ?? [a, b],
    })
    counts[kind] = (counts[kind] ?? 0) + 1
    feature(kind, a, b)
  }
  const anywhere = () => int(0, refCount - 1)
  const times = (count: number, place: () => void) => {
    for (let i = 0; i < count; i++) {
      place()
    }
  }
  const some = (p: number) => (chance(p) ? int(1, opts.structural) : 0)

  times(int(0, Math.ceil(refCount / 5)), () => {
    const alleles = Array.from({ length: int(1, 3) }, () => [
      newNode(chance(0.7) ? 1 : int(2, 30)),
    ])
    addSite('snp', anywhere(), chance(0.85) ? 1 : 2, alleles, alleles.length)
  })
  times(int(0, Math.ceil(refCount / 12)), () => {
    const alleles = Array.from({ length: int(1, 2) }, () =>
      newRun(int(1, 3), 1, 60),
    )
    addSite('insertion', anywhere(), 1, alleles, alleles.length)
  })
  times(int(0, Math.ceil(refCount / 12)), () => {
    addSite('deletion', anywhere(), int(1, 3), [], 1)
  })
  times(some(0.5), () => {
    const a = anywhere()
    const wanted = refBp * (0.05 + 0.35 * rng.next())
    let b = a + 1
    while (b < refCount && prefix[b]! - prefix[a]! < wanted) {
      b += 1
    }
    addSite('large-deletion', a, b - a, [], 1)
  })
  times(some(0.6), () => {
    const wanted = int(...opts.largeInsertionBp)
    const run: Walk = []
    while (bp(run) < wanted) {
      run.push(newNode(chance(0.2) ? int(1, 60) : int(100, opts.maxNodeLen)))
    }
    addSite('large-insertion', anywhere(), 1, [run], 4)
  })
  times(some(0.5), () => {
    const span = chance(0.5) ? int(1, 3) : int(5, Math.max(5, refCount >> 2))
    addSite('inversion', anywhere(), span, [], 1)
  })
  times(some(0.5), () => {
    addSite('tandem-duplication', anywhere(), int(1, 8), [], 3, {
      copies: int(2, 4),
    })
  })
  times(some(0.5), () => {
    const a = anywhere()
    const far = Math.ceil(refCount / 10)
    const candidates = [int(0, a - far), int(a + far, refCount - 1)].filter(
      c => c >= 0 && c < refCount && Math.abs(c - a) >= far,
    )
    const c = candidates.length > 0 ? pick(candidates) : anywhere()
    const d = Math.min(c + int(1, 12), refCount)
    addSite('dispersed-duplication', a, 1, [], 2, { source: [c, d] })
    feature('dispersed-source', c, d)
  })
  times(some(0.4), () => {
    addSite('hairpin', anywhere(), 1, [], 3, { copies: int(1, 4) })
  })
  times(some(0.4), () => {
    addSite('self-loop', anywhere(), 1, [], 1, { copies: int(2, 6) })
  })

  const startsAt: Site[][] = Array.from({ length: refCount }, () => [])
  for (const site of sites) {
    startsAt[site.a]!.push(site)
  }

  const walkRange = (hap: number, a: number, b: number, simple: boolean) => {
    const walk: Walk = []
    let i = a
    while (i < b) {
      const site = startsAt[i]!.find(
        s =>
          s.carriers.has(hap) &&
          s.b <= b &&
          (!simple || simpleKinds.has(s.kind)),
      )
      if (site) {
        walk.push(...emit(site, hap))
        i = site.b
      } else {
        walk.push(i + 1)
        i += 1
      }
    }
    return walk
  }
  const emit = (site: Site, hap: number): Walk => {
    const allele = site.carriers.get(hap)!
    const inner = () => walkRange(hap, site.a, site.b, true)
    const node = site.a + 1
    switch (site.kind) {
      case 'snp': {
        return site.alleles[allele]!
      }
      case 'insertion': {
        return [node, ...site.alleles[allele]!]
      }
      case 'deletion':
      case 'large-deletion': {
        return []
      }
      case 'large-insertion': {
        const run = site.alleles[0]!
        if (allele === 2 && run.length >= 3) {
          const from = int(1, run.length - 2)
          const to = int(from + 1, run.length - 1)
          return [node, ...run.slice(0, from), ...run.slice(to)]
        }
        return [node, ...(allele === 3 ? reverseComplement(run) : run)]
      }
      case 'inversion': {
        return reverseComplement(inner())
      }
      case 'tandem-duplication': {
        const copy = inner()
        const walk: Walk = []
        for (let k = 0; k < site.copies; k++) {
          walk.push(
            ...(allele === 2 && k === 1 ? reverseComplement(copy) : copy),
          )
        }
        return walk
      }
      case 'dispersed-duplication': {
        const copy = walkRange(hap, site.source[0], site.source[1], true)
        return [node, ...(allele === 1 ? reverseComplement(copy) : copy)]
      }
      case 'hairpin': {
        if (allele === 0) {
          return [node, -node, node]
        }
        if (allele === 1) {
          const depth = Math.min(site.copies, site.a)
          const back: Walk = []
          for (let k = 0; k <= depth; k++) {
            back.push(-(node - k))
          }
          return [node, ...back, ...reverseComplement(back)]
        }
        return [node, -node]
      }
      case 'self-loop': {
        return Array.from({ length: site.copies }, () => node)
      }
    }
  }

  const nearestReference = (walk: Walk, at: number) => {
    for (let d = 0; d < walk.length; d++) {
      for (const i of [at - d, at + d]) {
        const step = walk[i]
        if (step !== undefined && !isPrivate(step)) {
          return Math.abs(step) - 1
        }
      }
    }
    return undefined
  }
  const featureNear = (kind: string, walk: Walk, at: number) => {
    const index = nearestReference(walk, at)
    if (index !== undefined) {
      counts[kind] = (counts[kind] ?? 0) + 1
      feature(kind, index, index + 1)
    }
  }

  // Cuts a contig into fragments with gaps between them, some of no length.
  const fragmentsOf = (walk: Walk) => {
    const inPrivateRun: number[] = []
    for (let i = 1; i < walk.length; i++) {
      if (isPrivate(walk[i]!) && isPrivate(walk[i - 1]!)) {
        inPrivateRun.push(i)
      }
    }
    const cuts: [number, number][] = []
    times(int(1, 4), () => {
      const last = cuts[cuts.length - 1]
      const at =
        last && chance(0.3)
          ? last[0] + last[1] + int(1, 4)
          : inPrivateRun.length > 0 && chance(0.5)
            ? pick(inPrivateRun)
            : int(1, walk.length - 1)
      cuts.push([at, chance(0.25) ? 0 : int(1, 4)])
    })
    cuts.sort((x, y) => x[0] - y[0])
    const fragments: { start: number; steps: Walk }[] = []
    let from = 0
    for (const [cut, gap] of cuts) {
      const at = cut <= from ? from + int(1, 3) : cut
      if (at < walk.length) {
        fragments.push({
          start: bp(walk.slice(0, from)),
          steps: walk.slice(from, at),
        })
        featureNear('fragment-cut', walk, at)
        from = Math.min(at + gap, walk.length)
      }
    }
    if (from < walk.length) {
      fragments.push({
        start: bp(walk.slice(0, from)),
        steps: walk.slice(from),
      })
    }
    return fragments
  }

  const largeInsertions = sites.filter(site => site.kind === 'large-insertion')
  const extraContig = (hap: number): Walk => {
    const kind = int(0, 2)
    const a = anywhere()
    if (kind === 0) {
      counts['partial-contig'] = (counts['partial-contig'] ?? 0) + 1
      const b = Math.min(a + int(1, 30), refCount)
      feature('partial-contig', a, b)
      return walkRange(hap, a, b, true)
    }
    if (kind === 1 && largeInsertions.length > 0) {
      counts['contig-in-insertion'] = (counts['contig-in-insertion'] ?? 0) + 1
      const site = pick(largeInsertions)
      const run = site.alleles[0]!
      const from = int(0, run.length - 1)
      const inside = run.slice(from, int(from + 1, run.length))
      feature('contig-in-insertion', site.a, site.a + 1)
      return chance(0.3) ? [...inside, newNode(int(50, 600))] : inside
    }
    counts['unplaced-contig'] = (counts['unplaced-contig'] ?? 0) + 1
    const b = Math.min(a + int(1, 5), refCount)
    const stretch = walkRange(hap, a, b, true)
    const own = () => newRun(int(1, 3), 50, opts.maxNodeLen)
    feature('unplaced-contig', a, b)
    const shape = int(0, 3)
    if (shape === 0) {
      return [...own(), ...stretch, ...own()]
    }
    if (shape === 1) {
      return [...own(), ...stretch]
    }
    if (shape === 2) {
      return [...stretch, ...own()]
    }
    const c = chance(0.5) ? b : anywhere()
    feature('unplaced-contig', c, c + 1)
    return [
      ...stretch,
      ...own(),
      ...walkRange(hap, c, Math.min(c + int(1, 3), refCount), true),
    ]
  }

  const reverseShare = pick([0, 0.3, 0.5, 0.5, 1])
  const fragmentShare = pick([0, 0.2, 0.5, 0.8])
  const extraShare = pick([0, 0.3, 0.6])
  const truncateShare = pick([0, 0.2, 0.5])
  const splitShare = pick([0, 0.2, 0.4])
  const refWalk = Array.from({ length: refCount }, (_, i) => i + 1)

  const walks: GeneratedWalk[] = [
    {
      sample: 'GRCh38',
      haplotype: 0,
      contig: 'chr1',
      start: 0,
      end: refBp,
      steps: refWalk,
    },
  ]
  const addContig = (
    name: { sample: string; haplotype: number; contig: string },
    contig: Walk,
    reverse: boolean,
    fragment: boolean,
  ) => {
    const walk = reverse ? reverseComplement(contig) : contig
    if (reverse) {
      counts['reverse-contig'] = (counts['reverse-contig'] ?? 0) + 1
    }
    const fragments =
      fragment && walk.length > 1
        ? fragmentsOf(walk)
        : [{ start: 0, steps: walk }]
    if (fragments.length > 1) {
      counts['fragmented-contig'] = (counts['fragmented-contig'] ?? 0) + 1
    }
    for (const { start, steps } of fragments) {
      walks.push({ ...name, start, end: start + bp(steps), steps })
    }
  }
  const nonEmpty = (walk: Walk) => (walk.length > 0 ? walk : refWalk)

  if (secondReference) {
    addContig(
      { sample: 'CHM13', haplotype: 0, contig: 'chr1' },
      nonEmpty(walkRange(chm13, 0, refCount, false)),
      chance(0.25),
      chance(0.25),
    )
  }
  sampleHaplotypes.forEach((name, hap) => {
    let main = nonEmpty(walkRange(hap, 0, refCount, false))
    if (main.length > 2 && chance(truncateShare)) {
      const from = chance(0.6) ? int(0, Math.floor(main.length * 0.45)) : 0
      const to =
        main.length - (chance(0.6) ? int(0, Math.floor(main.length * 0.45)) : 0)
      featureNear('contig-end', main, from)
      featureNear('contig-end', main, to - 1)
      main = main.slice(from, to)
    }
    const contigs: Walk[] = []
    if (main.length >= 4 && chance(splitShare)) {
      const at = int(1, main.length - 2)
      const gap = chance(0.5) ? 0 : int(1, Math.min(10, main.length - 1 - at))
      featureNear('contig-end', main, at)
      contigs.push(main.slice(0, at), main.slice(at + gap))
    } else {
      contigs.push(main)
    }
    if (chance(extraShare)) {
      times(int(1, 3), () => {
        contigs.push(extraContig(hap))
      })
    }
    contigs
      .filter(contig => contig.length > 0)
      .forEach((contig, index) => {
        addContig(
          { ...name, contig: `ctg${index + 1}` },
          contig,
          chance(reverseShare),
          chance(fragmentShare),
        )
      })
  })

  // Nodes no walk visits would be segments without a path, which a GBZ drops.
  const used = new Set<number>()
  for (const walk of walks) {
    for (const step of walk.steps) {
      used.add(Math.abs(step))
    }
  }
  const renumbered = new Map<number, number>()
  for (let id = 1; id < lengths.length; id++) {
    if (used.has(id)) {
      renumbered.set(id, renumbered.size + 1)
    }
  }
  for (const walk of walks) {
    walk.steps = walk.steps.map(
      step => Math.sign(step) * renumbered.get(Math.abs(step))!,
    )
  }
  for (let i = walks.length - 1; i > 0; i--) {
    const j = int(0, i)
    ;[walks[i], walks[j]] = [walks[j]!, walks[i]!]
  }

  const referenceSamples = secondReference ? ['GRCh38', 'CHM13'] : ['GRCh38']
  const lines = [`H\tVN:Z:1.1\tRS:Z:${referenceSamples.join(' ')}`]
  for (const [id, renumberedId] of renumbered) {
    let sequence = ''
    for (let k = 0; k < lengths[id]!; k++) {
      sequence += 'ACGT'[int(0, 3)]
    }
    lines.push(`S\t${renumberedId}\t${sequence}`)
  }
  const edges = new Set<string>()
  for (const { steps } of walks) {
    for (let i = 1; i < steps.length; i++) {
      const from = steps[i - 1]!
      const to = steps[i]!
      const forward = linkLine(from, to)
      const flipped = linkLine(-to, -from)
      edges.add(forward < flipped ? forward : flipped)
    }
  }
  lines.push(...edges)
  for (const walk of walks) {
    lines.push(
      `W\t${walk.sample}\t${walk.haplotype}\t${walk.contig}\t${walk.start}\t${walk.end}\t${walkText(walk.steps)}`,
    )
  }
  return {
    gfa: `${lines.join('\n')}\n`,
    referenceSamples,
    walks,
    features,
    counts,
  }
}
