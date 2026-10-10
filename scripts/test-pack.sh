#!/usr/bin/env bash
# Packs the package, installs the tarball into a scratch dir, and reads a
# fixture through the ESM entry, the CJS entry and the bin. `pnpm test` runs
# against src/ and cannot see the package's shape.

set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

cd "$PKG_DIR"
TARBALL="$(npm pack --silent --pack-destination "$SCRATCH")"
FIXTURE="$PKG_DIR/test/data/example.gbz.db"

cd "$SCRATCH"
cat >package.json <<'JSON'
{
  "name": "gbz-base-pack-test",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
JSON
npm install --silent --no-audit --no-fund generic-filehandle2 "./$TARBALL" >/dev/null

cat >smoke.mjs <<JS
import { GBZBase } from '@gmod/gbz-base'
import { LocalFile } from 'generic-filehandle2'
const db = await GBZBase.open({ source: new LocalFile('$FIXTURE') })
const paths = await db.paths()
if (paths.length === 0) throw new Error('no paths (ESM)')
console.log(\`esm: \${paths.length} paths ok\`)
JS

cat >smoke.cjs <<JS
const { GBZBase } = require('@gmod/gbz-base')
const { LocalFile } = require('generic-filehandle2')
GBZBase.open({ source: new LocalFile('$FIXTURE') })
  .then(db => db.paths())
  .then(paths => {
    if (paths.length === 0) throw new Error('no paths (CJS)')
    console.log(\`cjs: \${paths.length} paths ok\`)
  })
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
JS

cat >subpaths.mjs <<'JS'
import { pairAlignments, pairCigar } from '@gmod/gbz-base/pairAlignment'
import { weightedLcs } from '@gmod/gbz-base/lcs'
const length = { 5: 24, 7: 40, 8: 40 }
const [chain] = pairAlignments({
  query: [14, 16],
  target: [14, 10, 16],
  sequenceOf: id => 'N'.repeat(length[id]),
  minMatch: 1,
  bases: false,
})
if (pairCigar(chain.edits) !== '40=24D40=') throw new Error('subpath pairAlignments')
if (weightedLcs([14, 16], [14, 10, 16], h => length[h >> 1])[1] !== 80) {
  throw new Error('subpath weightedLcs')
}
console.log('esm subpaths: ok')
JS

cat >subpaths.cjs <<'JS'
const { pairAlignments } = require('@gmod/gbz-base/pairAlignment')
const { weightedLcs } = require('@gmod/gbz-base/lcs')
if (typeof pairAlignments !== 'function' || typeof weightedLcs !== 'function') {
  throw new Error('cjs subpaths')
}
console.log('cjs subpaths: ok')
JS

node smoke.mjs
node smoke.cjs
node subpaths.mjs
node subpaths.cjs
npx --no-install gbz-base-query "$FIXTURE" --node 15 --context 1 >bin.json
node -e "JSON.parse(require('fs').readFileSync('bin.json', 'utf8')).nodes.length || process.exit(1)"
echo 'bin: ok'
