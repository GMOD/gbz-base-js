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

