## [3.0.0](https://github.com/GMOD/gbz-base-js/compare/v2.8.0...v3.0.0) (2026-09-27)

### Other Changes

- WASM note ([987b0a7](https://github.com/GMOD/gbz-base-js/commit/987b0a725b329ff203bf7e6a5ef4a000e5d0d7a6))
- Reorganize and tighten the docs ([d17998b](https://github.com/GMOD/gbz-base-js/commit/d17998b2d39905de0b8d03c20123cd02207e48b0))
- Second prose pass, and CONTRIBUTING ([2ac7f26](https://github.com/GMOD/gbz-base-js/commit/2ac7f262ad748d5d812158a10bdc2e161f0bcf8e))
- Cut every page to what a reader needs ([591147c](https://github.com/GMOD/gbz-base-js/commit/591147c17dfaf53693b6da5cb99199c0abfa804a))
- Separate the library from the command line ([f49b74c](https://github.com/GMOD/gbz-base-js/commit/f49b74ccaf3c1c8039ce7d72a23b46c27a7bebdf))
- Second tropes pass; fix truncated --haplotypes error ([6c18d8a](https://github.com/GMOD/gbz-base-js/commit/6c18d8af773b8d90c6dbbd7359d27506b67c620f))
- We withdrew gbwt-rs#14; fix the CHM13 chr20 region and HPRC read size ([070cd1b](https://github.com/GMOD/gbz-base-js/commit/070cd1b039f6da95e304cb3a296a6f37ddac39e2))
- State the gbwt-rs#14 outcome without narrating who said what ([ffcf40a](https://github.com/GMOD/gbz-base-js/commit/ffcf40a3f6063c9d219a1aa87f09500b9e107da4))
- Cut why-not-wasm to the usize problem and the reader's advantages ([51ccf47](https://github.com/GMOD/gbz-base-js/commit/51ccf47fdcbfa94c80af07418d663e21988d4de0))
- Simplify why-not-wasm further ([89e3200](https://github.com/GMOD/gbz-base-js/commit/89e3200c7a97e134d8c36b53d445fa3389bdaf84))
- Fold why-not-wasm into internals ([c66373f](https://github.com/GMOD/gbz-base-js/commit/c66373fa7c00d9114faad82ac47be5ccaee42f9d))
- Wasm misreads files built on 64-bit machines ([b0d33d9](https://github.com/GMOD/gbz-base-js/commit/b0d33d99e60dc36474d8ff9be140046ee556c9af))
- Bump deps ([16c3c40](https://github.com/GMOD/gbz-base-js/commit/16c3c40885c900d748859d43a71eaf634daff05c))
- Upstream names the query path, only the other walks are unknown ([41c13dc](https://github.com/GMOD/gbz-base-js/commit/41c13dcdb007190291ca32939373fd08ff6db521))
- Haplotype index is a companion file only ([069346f](https://github.com/GMOD/gbz-base-js/commit/069346f90fb6ee006ed54b3b09d771b29ba0165b))
- HPRC companion build time and memory ([a5c1dea](https://github.com/GMOD/gbz-base-js/commit/a5c1dea01e6011c3c1bd85f0377d55f23d688334))
- Format the crate README ([a3da15e](https://github.com/GMOD/gbz-base-js/commit/a3da15e912b576ee578e0a9b7241953966ddc31c))

## [2.8.0](https://github.com/GMOD/gbz-base-js/compare/v2.7.0...v2.8.0) (2026-09-26)

### Other Changes

- PairAlignments takes bases: false, and the CLI --no-bases ([b156d9c](https://github.com/GMOD/gbz-base-js/commit/b156d9c7f4066f313fb4f9d493fcb74c93861784))
- An inversion a walk takes through shared nodes comes out once ([c1d85fa](https://github.com/GMOD/gbz-base-js/commit/c1d85fab6081893bd085be077f3ac629ad39f8cb))
- Bases: false and --no-bases, and the pairAlignments options ([fea0769](https://github.com/GMOD/gbz-base-js/commit/fea0769df9c19ddadb976bc1db50b41efa17f60e))

## [2.7.0](https://github.com/GMOD/gbz-base-js/compare/v2.6.6...v2.7.0) (2026-09-21)

### Other Changes

- Haplotype-to-haplotype alignments with the bases compared: Subgraph.pairAlignments, --against and --stack ([eb73f6e](https://github.com/GMOD/gbz-base-js/commit/eb73f6e533700b3bd06f30dec46d6038cf7c2dc9))
- Chain shared stretches collinearly, and let the bases decide inside a repeat ([f64bc26](https://github.com/GMOD/gbz-base-js/commit/f64bc26fdbcc7d935a0c46e8201d75aa59cbd662))
- An inversion survives a flank that runs into it, and a paralog cannot re-claim an earlier record's bases ([1c7d5ff](https://github.com/GMOD/gbz-base-js/commit/1c7d5ffad016314815eed0872029dc0194a32a72))
- A gap fill chains only the one chain it uses, and a jump that cannot win is not priced ([fe6554d](https://github.com/GMOD/gbz-base-js/commit/fe6554dc4f220169d889851fc24f55ae22257fab))
- A base aligns in one record, the one scoring higher over the stretch two records share ([68edf10](https://github.com/GMOD/gbz-base-js/commit/68edf103d32c55d6e3677337de9c049061dea45b))
- The one-alignment-per-base rule, and README points at haplotype-pair alignments ([c1f428b](https://github.com/GMOD/gbz-base-js/commit/c1f428b23c0b915b16906cf319abede972a5bebc))

## [2.6.6](https://github.com/GMOD/gbz-base-js/compare/v2.6.5...v2.6.6) (2026-09-17)

### Other Changes

- Fall back rather than dropping a haplotype the anchor cannot reach ([edc27cf](https://github.com/GMOD/gbz-base-js/commit/edc27cfbbd2eaa2866c8d0ee6c99066e801ab509))
- Format ([d95779b](https://github.com/GMOD/gbz-base-js/commit/d95779b6aa6d206f887111d61007e584f0f0aadf))

## [2.6.5](https://github.com/GMOD/gbz-base-js/compare/v2.6.4...v2.6.5) (2026-09-17)

### Documentation

- What a database answers, beside an rGFA ([16e63ed](https://github.com/GMOD/gbz-base-js/commit/16e63ed04914f8c96fb49456830d944abbba1a13))
- Rename what-it-answers to contents-and-limitations, plain prose ([4562c7f](https://github.com/GMOD/gbz-base-js/commit/4562c7f22f825975328ad990498065789db79e17))
- Fix anti-AI prose tropes (pronoun openings, clefts, "Both"/"So" fragments) ([4c63eee](https://github.com/GMOD/gbz-base-js/commit/4c63eee259dfc9e46bbd3c5f3495c98c1f17fd3b))
- Fix inanimate-subject agency and figures of speech, and correct three changed claims ([ea952d7](https://github.com/GMOD/gbz-base-js/commit/ea952d70180c2e5d178ea70c6980599256649aa5))
- Name the contig-orientation rule and the cache's coverage exactly ([d93bbc0](https://github.com/GMOD/gbz-base-js/commit/d93bbc09f82be8fef940a80e223613dd9a7c4074))

### Other Changes

- Keep a walk's private run however long it is ([fa3fe29](https://github.com/GMOD/gbz-base-js/commit/fa3fe2966023a0dfb6e76a98fe359572e5509591))

## [2.6.4](https://github.com/GMOD/gbz-base-js/compare/v2.6.3...v2.6.4) (2026-09-17)

### Other Changes

- Trim the shared ends of every split in the weighted LCS ([2cf29a0](https://github.com/GMOD/gbz-base-js/commit/2cf29a099bfd5f9faadfa2ea12d679a98f4bd6f0))
- Drop the visited set from the anchored walk ([8f88fd6](https://github.com/GMOD/gbz-base-js/commit/8f88fd62876b0e8adfca23394d1d8a28dde924aa))
- Write down why the alignment and the anchored walk look the way they do ([6b274ca](https://github.com/GMOD/gbz-base-js/commit/6b274ca8f73f791cd55c359fb67443de0e464ef4))

## [2.6.3](https://github.com/GMOD/gbz-base-js/compare/v2.6.2...v2.6.3) (2026-09-17)

### Other Changes

- Let the storage cluster stand alone, and cut the labels back to the names ([1c78480](https://github.com/GMOD/gbz-base-js/commit/1c7848076be98043fc1777083eefaa424ac318a6))
- Draw getSubgraphForRange where it enters ([18293be](https://github.com/GMOD/gbz-base-js/commit/18293bee31191a1896d331a3cbd28d63312fb8ec))
- Stop the prose repeating what the diagram now shows ([9a82b34](https://github.com/GMOD/gbz-base-js/commit/9a82b343dc38ddf432fccc71a5b9c358b9645cbc))
- Align a looping walk in memory linear in the two walks ([54d815d](https://github.com/GMOD/gbz-base-js/commit/54d815deebe954ea9425c012707ec4f2c96c3f58))

## [2.6.2](https://github.com/GMOD/gbz-base-js/compare/v2.6.1...v2.6.2) (2026-09-08)

### Other Changes

- Walk a window's steps through flat arrays, and match one without allocating ([d42e8ec](https://github.com/GMOD/gbz-base-js/commit/d42e8ec0926e5fd56cb921a519a3be7cf94d0ed1))
- Correct the speedup, the keep ratio, and the network claim ([e58306e](https://github.com/GMOD/gbz-base-js/commit/e58306ecccc9e342b64cddc050b6d88472d0faf7))
- A small window is not a cheap one, and a handoff for the session that measured it ([5142b1b](https://github.com/GMOD/gbz-base-js/commit/5142b1ba86e64bedb738fbd3f26cd90c33cb189f))
- The lane-selection fix landed, so the handoff records it rather than proposing it ([33cb912](https://github.com/GMOD/gbz-base-js/commit/33cb9129c6b9ad12681018bd7e940e2ba721a9dc))

## [2.6.1](https://github.com/GMOD/gbz-base-js/compare/v2.6.0...v2.6.1) (2026-09-07)

### Other Changes

- The README is an index, and the details live in docs/ ([b8c9d50](https://github.com/GMOD/gbz-base-js/commit/b8c9d503267849c30963781e6263e0bd3ec2e196))
- A query is drawn, from the call down to the range request ([d8e0880](https://github.com/GMOD/gbz-base-js/commit/d8e0880d8bdc7af937510c799eb88e67c8154a90))
- The errors a caller can catch, and all four haplotype outputs ([aeb6039](https://github.com/GMOD/gbz-base-js/commit/aeb6039e72e61dd2d208772a22dd4d01ebfc6a53))
- A subgraph comes back as typed arrays, and the upstream JSON keeps its shape ([2ad555e](https://github.com/GMOD/gbz-base-js/commit/2ad555e1abc19afa0cf8c24ce961a501705441bd))

## [2.6.0](https://github.com/GMOD/gbz-base-js/compare/v2.5.0...v2.6.0) (2026-09-07)

### Other Changes

- The companion carries reference anchors, and a chosen set of haplotypes is walked from the anchor before the window ([81a1570](https://github.com/GMOD/gbz-base-js/commit/81a1570d33ae411f7e9abddbfebb122df9ab4c3d))

## [2.5.0](https://github.com/GMOD/gbz-base-js/compare/v2.4.0...v2.5.0) (2026-09-06)

### Other Changes

- The range queries take a keep predicate, and a forward-only haplotype index is refused at open ([ba2ea66](https://github.com/GMOD/gbz-base-js/commit/ba2ea665cad681ae8813c282d219563d129a96c1))

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

