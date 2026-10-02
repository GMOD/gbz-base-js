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

node smoke.mjs
node smoke.cjs
npx --no-install gbz-base-query "$FIXTURE" --node 15 --context 1 >bin.json
node -e "JSON.parse(require('fs').readFileSync('bin.json', 'utf8')).nodes.length || process.exit(1)"
echo 'bin: ok'
