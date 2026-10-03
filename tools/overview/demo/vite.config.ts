import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const repo = fileURLToPath(new URL('../../..', import.meta.url))

// Builds the overview page into dist-demo at the repo root, with the vite
// that vitest brings:
//   node_modules/.bin/vite build --config tools/overview/demo/vite.config.ts
export default {
  root,
  base: './',
  build: { outDir: `${repo}/dist-demo`, emptyOutDir: true, target: 'es2022' },
  server: { fs: { allow: [repo] } },
}
