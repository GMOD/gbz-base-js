## [2.4.0](https://github.com/GMOD/gbz-base-js/compare/v2.3.0...v2.4.0) (2026-09-06)

### Other Changes

- Named walks run in the haplotype's direction, and a cut can keep a chosen set of haplotypes ([add1f2f](https://github.com/GMOD/gbz-base-js/commit/add1f2f03a3f5f92e81eedfbc45ec629d4d27ab5))

## [2.3.0](https://github.com/GMOD/gbz-base-js/compare/v2.2.0...v2.3.0) (2026-09-06)

### Other Changes

- A fixture whose reference contig is stored as two fragments ([bca5c1a](https://github.com/GMOD/gbz-base-js/commit/bca5c1a5649933dccf3e865ae5a84b5c551ed15c))
- Identification scans the companion per run of node ids, and --stats reports how each chain ended ([fd91599](https://github.com/GMOD/gbz-base-js/commit/fd9159975f07524f1989a617a8dbec442784363d))
- Walk the subgraph once over typed arrays, skip provable twin walks, and prefetch the reference walk's node records ([ad48851](https://github.com/GMOD/gbz-base-js/commit/ad488514b9c6fa08d5ed3ba5a47c81123a171e4f))
- One alignment record per haplotype: consecutive sibling fragments join through the identified chain ([cf9b8b8](https://github.com/GMOD/gbz-base-js/commit/cf9b8b837cb006a57d47066e36ff08daff444063))
- Context no longer decides the record count, and the README says what it trades instead ([3d9f480](https://github.com/GMOD/gbz-base-js/commit/3d9f480b68cf963106ddc6961c386877c40b24d3))
- The node limit error says how far into the window the reference walk got ([fcbd029](https://github.com/GMOD/gbz-base-js/commit/fcbd029da2d75c9fd289c4454862140bf44d0540))

## [2.2.0](https://github.com/GMOD/gbz-base-js/compare/v2.1.0...v2.2.0) (2026-09-06)

### Other Changes

- GetAlignmentsForRange takes only the options that shape an alignment ([0ec2d7c](https://github.com/GMOD/gbz-base-js/commit/0ec2d7ca8d7dbbe401204867b517304dbd46f8b4))

## [2.1.0](https://github.com/GMOD/gbz-base-js/compare/v2.0.0...v2.1.0) (2026-09-06)

### Other Changes

- Align a haplotype in the orientation that shares more sequence with the reference ([0054fe8](https://github.com/GMOD/gbz-base-js/commit/0054fe856900a991daebb4507d8189c47d91ef6f))
- A companion index records the node count too, and the reader checks it when present ([7d38ca6](https://github.com/GMOD/gbz-base-js/commit/7d38ca6bd3d5e17a71ae9fbe647c5238a52577cb))

## [2.0.0](https://github.com/GMOD/gbz-base-js/compare/v1.1.0...v2.0.0) (2026-09-06)

### Other Changes

- Gbz-haplotype-index reports progress per thread ([fb60239](https://github.com/GMOD/gbz-base-js/commit/fb60239f34a8e8dfd9ae350c402db39c4b4288e1))
- Front-door range API on GBZBase ([462050e](https://github.com/GMOD/gbz-base-js/commit/462050e01ec5cca84ba0c317116d1f72dbcd9580))
- Fragment-aware range API, replacing getFeatures/getGraph ([70b6522](https://github.com/GMOD/gbz-base-js/commit/70b652238df142f9788e98013c0de56f523afddc))
- Measure only the fragments a window can overlap ([b7fad0c](https://github.com/GMOD/gbz-base-js/commit/b7fad0cd499afcff0f0c60c6994e84d5cd83b2cd))
- Cover the fragment cases no fixture reaches ([bbe501a](https://github.com/GMOD/gbz-base-js/commit/bbe501a9bf8b6f61132b22f132da730c396f1249))
- Index seeks reuse decoded cells, and --stats reports the companion pager ([7f42037](https://github.com/GMOD/gbz-base-js/commit/7f42037a100e91d596872cd465aeed618aa871c6))
- Exercise fragment spanning against a real fragmented reference when one is at hand ([8c2a9b7](https://github.com/GMOD/gbz-base-js/commit/8c2a9b79471d74c1bfde59c8f9fb82275a49a10f))

## [1.1.0](https://github.com/GMOD/gbz-base-js/compare/v1.0.0...v1.1.0) (2026-09-06)

### Other Changes

- Snarl extension and between queries, ported from upstream gbz-base ([4d0728b](https://github.com/GMOD/gbz-base-js/commit/4d0728baaad180d2932e92242f3bef75ed572865))
- GFA output matching upstream, and read-ahead for table scans ([ce772e6](https://github.com/GMOD/gbz-base-js/commit/ce772e62563dbc8525eec99b377a8d016e903dae))
- A standalone haplotype index the reader opens beside a published database ([adb4bf2](https://github.com/GMOD/gbz-base-js/commit/adb4bf285a566a302744be9a7117f7157feb678c))
- Binary heap for the context-extension side queue ([27b7a2a](https://github.com/GMOD/gbz-base-js/commit/27b7a2aad6fd32710ad980692e8a1ed4345dcbd4))
- Retry a failed range request, and never cache its failure ([c8a1e81](https://github.com/GMOD/gbz-base-js/commit/c8a1e81dd734df795766aa49e7bad13af9639c63))
- Typed arrays for the successor table behind path extraction ([4b3011c](https://github.com/GMOD/gbz-base-js/commit/4b3011c82afdc468a734254c45851fc5c5585e21))

## [1.0.0](https://github.com/GMOD/gbz-base-js/compare/v0.1.0...v1.0.0) (2026-09-06)

### Other Changes

- A verifier script that checks identifications on a chr20 database by backward walk ([3610b43](https://github.com/GMOD/gbz-base-js/commit/3610b4349f8504ca2e91afd88f58f476ebacdcf6))
- The CLI names an alignment record by the haplotype interval it covers ([66c2e6a](https://github.com/GMOD/gbz-base-js/commit/66c2e6aacde682ab0141e47cdec1aab26f3f2c2f))

## [0.1.0](https://github.com/GMOD/gbz-base-js/compare/v0.1.0...v0.1.0) (2026-09-06)

### Other Changes

- Gbz-base reader in TypeScript: SQLite b-tree reader over range requests, GBWT record decoding, subgraph and CIGAR port, haplotype identification side tables ([780e68d](https://github.com/GMOD/gbz-base-js/commit/780e68de7294b02f7d3967b0eb57cd3e6bc52c11))
- Notes ([6855b4e](https://github.com/GMOD/gbz-base-js/commit/6855b4e6b19ae8c556c5dd82420a4d105a987e12))
- Gbz-haplotype-index --from-db walks the paths through the database's own records ([6b72ef1](https://github.com/GMOD/gbz-base-js/commit/6b72ef15ac9d4c24d65ec2662810153d96b47a98))
- Open with one block read, and count requests in a test ([df8e4f8](https://github.com/GMOD/gbz-base-js/commit/df8e4f87763556b340fca6eb8207d444d8a8a593))
- Gbz-haplotype-index writes to a scratch database while it reads, then merges ([6e47a5e](https://github.com/GMOD/gbz-base-js/commit/6e47a5e05f94df5c8cef46957700448e18fc1860))
- Refuse a database whose schema version the reader does not understand, and resolve for require conditions too ([e10bbfe](https://github.com/GMOD/gbz-base-js/commit/e10bbfe6f2dac0f4b6d7a772f0d6e7b9a74eb32b))
- Add CI and publish GitHub Actions workflows ([66f2b4c](https://github.com/GMOD/gbz-base-js/commit/66f2b4c6a537dd168653095966d5e9d2d5ab2c1d))
- Adopt the shared gmod toolchain config from bam-js ([c854743](https://github.com/GMOD/gbz-base-js/commit/c85474308fc9cee236027ec4d7591932291acf4b))
- Seed an empty CHANGELOG.md so the first pnpm version works ([e277720](https://github.com/GMOD/gbz-base-js/commit/e2777200e178c30b0ca922d9d8aa345dc0ccb50e))

