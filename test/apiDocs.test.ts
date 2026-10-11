import fs from 'node:fs'

import ts from 'typescript'
import { expect, test } from 'vitest'

const api = fs.readFileSync('docs/api.md', 'utf8')

const undocumented: Record<string, Record<string, string>> = {
  GBZBase: {
    sqlite: 'the graph database reader, which Subgraph and tests read',
    index: 'the haplotype index reader, which tests read',
    prefetchRecords: 'Subgraph prefetches node rows with it',
    getRecord: 'Subgraph and chosenPaths read node records with it',
    getPath: 'Subgraph reads one path row with it',
    pathsByHandle: 'Subgraph and chosenPaths look paths up by handle',
    findPath: 'Subgraph finds the fragment covering an offset',
    pathLength: 'getPathFragments measures each fragment with it',
    haplotypeSampleInterval: 'chosenPaths reads the index sample interval',
    haplotypeSampleGap: 'identifyPaths reads the index sample gap',
    haplotypeAnchorSpacing: 'chosenPaths reads the index anchor spacing',
    haplotypeStrayOptions: 'chosenPaths reads the index stray settings',
    haplotypeBinData: 'chosenPaths reads index bins with it',
    haplotypeAnchorsBetween: 'chosenPaths reads index anchors with it',
    haplotypeAnchor: 'tests read one index anchor with it',
    haplotypeSamplesAtNode: 'tests read index samples with it',
    haplotypeSamplesInRange: 'identifyPaths reads index samples with it',
    haplotypeSampleAt: 'identifyPaths reads one index sample with it',
    haplotypeLength: 'pathLength reads the index path length with it',
    indexedPosition: 'Subgraph reads the random-access index with it',
    indexedPositionsBetween: 'Subgraph reads the random-access index with it',
  },
  GbzPath: {
    fwStart: 'GBWT start of the forward path, read by tests',
    revStart: 'GBWT start of the reverse path, read by tests',
  },
  Subgraph: {
    stats: 'request and identification counters for tests and tools',
    create: 'the query functions in query.ts build subgraphs with it',
    pathPosition: 'a step of the query functions in query.ts',
    aroundPosition: 'a step of the query functions in query.ts',
    prefetchReferenceWalk: 'a step of the query functions in query.ts',
    aroundInterval: 'a step of the query functions in query.ts',
    referenceWalkedBp: 'query.ts fills SubgraphLimitError from it',
    aroundNodes: 'a step of the query functions in query.ts',
    betweenNodes: 'a step of the query functions in query.ts',
    extractSnarls: 'a step of the query functions in query.ts',
    extractPaths: 'a step of the query functions in query.ts',
    extractChosenPaths: 'a step of the query functions in query.ts',
    alignToRef: 'the outputs compute each walk CIGAR with it',
  },
}

function source(file: string) {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
}

function publicNames(members: ts.NodeArray<ts.ClassElement | ts.TypeElement>) {
  const names: string[] = []
  for (const member of members) {
    const hidden = (
      ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : []
    ).some(
      m =>
        m.kind === ts.SyntaxKind.PrivateKeyword ||
        m.kind === ts.SyntaxKind.ProtectedKeyword,
    )
    const name = member.name?.getText()
    if (
      name &&
      !hidden &&
      !name.startsWith('_') &&
      !ts.isConstructorDeclaration(member)
    ) {
      names.push(name)
    }
  }
  return names
}

// a class's members, plus the keys of its constructor's inline options type
function publicMembers(file: string, name: string) {
  const decl = source(file).statements.find(
    (s): s is ts.ClassDeclaration | ts.InterfaceDeclaration =>
      (ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s)) &&
      s.name?.text === name,
  )
  if (!decl) {
    throw new Error(`no ${name} in ${file}`)
  }
  const names = publicNames(decl.members)
  if (ts.isClassDeclaration(decl)) {
    const options = decl.members.find(ts.isConstructorDeclaration)
      ?.parameters[0]?.type
    if (options && ts.isTypeLiteralNode(options)) {
      names.push(...publicNames(options.members))
    }
  }
  return [...new Set(names)]
}

function inDocs(name: string) {
  return new RegExp(`\`([\\w.]*\\.)?${name}\\b`).test(api)
}

test.each([
  ['src/db.ts', 'GBZBase'],
  ['src/db.ts', 'OpenOptions'],
  ['src/db.ts', 'FetchStats'],
  ['src/db.ts', 'PathFragment'],
  ['src/db.ts', 'GbzPath'],
  ['src/db.ts', 'AlignmentQuery'],
  ['src/db.ts', 'OverviewQuery'],
  ['src/db.ts', 'HaplotypeOverview'],
  ['src/db.ts', 'OverviewBin'],
  ['src/db.ts', 'UnknownPathError'],
  ['src/db.ts', 'ForwardOnlyIndexError'],
  ['src/db.ts', 'SchemaVersionError'],
  ['src/query.ts', 'QueryOptions'],
  ['src/query.ts', 'PathWindow'],
  ['src/query.ts', 'IntervalQuery'],
  ['src/query.ts', 'OffsetQuery'],
  ['src/query.ts', 'NodesQuery'],
  ['src/query.ts', 'BetweenQuery'],
  ['src/subgraph.ts', 'Subgraph'],
  ['src/subgraph.ts', 'SubgraphLimitError'],
  ['src/subgraph.ts', 'SubgraphOutputOptions'],
  ['src/subgraph.ts', 'SubgraphJson'],
  ['src/subgraph.ts', 'SubgraphPath'],
  ['src/subgraph.ts', 'CompactSubgraph'],
  ['src/subgraph.ts', 'CompactPath'],
  ['src/subgraph.ts', 'WalkSpan'],
  ['src/subgraph.ts', 'AlignmentSpan'],
  ['src/subgraph.ts', 'HaplotypeRef'],
  ['src/subgraph.ts', 'PairAlignmentOptions'],
  ['src/subgraph.ts', 'PairAlignment'],
  ['src/pathName.ts', 'PathName'],
  ['src/pathName.ts', 'PathQuery'],
  ['src/graphName.ts', 'GraphName'],
  ['src/filehandle.ts', 'ByteSource'],
  ['src/pairAlignment.ts', 'PairOptions'],
  ['src/pairAlignment.ts', 'PairChain'],
])('docs/api.md covers every public member of %s %s', (file, name) => {
  const skip = undocumented[name] ?? {}
  const members = publicMembers(file, name)
  expect(
    members.filter(m => !(m in skip) && !inDocs(m)),
    'document these in docs/api.md, or list them as undocumented with a reason',
  ).toEqual([])
  expect(
    Object.keys(skip).filter(m => !members.includes(m)),
    'these undocumented entries no longer exist',
  ).toEqual([])
})

test('docs/api.md covers every export', () => {
  const exported: string[] = []
  for (const statement of source('src/index.ts').statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exported.push(element.name.text)
      }
    }
  }
  expect(exported.length).toBeGreaterThan(0)
  expect(exported.filter(name => !inDocs(name))).toEqual([])
})
