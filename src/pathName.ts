export interface PathName {
  sample: string
  contig: string
  haplotype: number
  fragment: number
}

export interface PathQuery {
  sample?: string
  contig: string
  haplotype?: number
}

export type PathRef = string | PathQuery

export const GENERIC_SAMPLE = '_gbwt_ref'

export function formatPathName(name: PathName, end: number) {
  return `${name.sample}#${name.haplotype}#${name.contig}[${name.fragment}-${end}]`
}

const PAN_SN = /^([^#]+)#(\d+)#([^#]+?)(?:\[\d+-\d+\])?$/
const BARE_CONTIG = /^([^#]+?)(?:\[\d+-\d+\])?$/

export function parsePathName(name: string): PathQuery {
  const panSn = PAN_SN.exec(name)
  if (panSn) {
    return {
      sample: panSn[1]!,
      haplotype: Number(panSn[2]),
      contig: panSn[3]!,
    }
  }
  const bare = BARE_CONTIG.exec(name)
  if (bare) {
    return { contig: bare[1]! }
  }
  throw new Error(
    `"${name}" is not a path name; expected "sample#haplotype#contig" or a bare contig`,
  )
}

export function toPathQuery(ref: PathRef) {
  return typeof ref === 'string' ? parsePathName(ref) : ref
}

export function pathNameFor(query: PathQuery, fragment: number): PathName {
  return {
    sample: query.sample ?? GENERIC_SAMPLE,
    contig: query.contig,
    haplotype: query.haplotype ?? 0,
    fragment,
  }
}
