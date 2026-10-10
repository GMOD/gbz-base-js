## [7.4.0](https://github.com/GMOD/gbz-base-js/compare/v7.3.0...v7.4.0) (2026-10-10)

### Other Changes

- PairAlignment and lcs are subpath exports, so a bundle can leave the database reader out ([ce037e3](https://github.com/GMOD/gbz-base-js/commit/ce037e3d9208b5c6c916e50575a42a7e3f10622c))

## [7.3.0](https://github.com/GMOD/gbz-base-js/compare/v7.2.0...v7.3.0) (2026-10-09)

### Other Changes

- Export weightedLcs, the heaviest common subsequence of two walks ([3f2bb5a](https://github.com/GMOD/gbz-base-js/commit/3f2bb5a987527cca63ec7f559a0a3e357c920f38))

## [7.2.0](https://github.com/GMOD/gbz-base-js/compare/v7.1.0...v7.2.0) (2026-10-09)

### Other Changes

- Triage agent-docs to the ideas/handoffs convention, add agent-docs/CLAUDE.md ([cb83841](https://github.com/GMOD/gbz-base-js/commit/cb83841610f9888fea898aa2b335d3196c3aaf87))
- Export pairAlignments and pairCigar, which align two walks from node lengths alone ([ddada98](https://github.com/GMOD/gbz-base-js/commit/ddada980725d44b28348fb81ee64f624d02ee8ec))

## [7.1.0](https://github.com/GMOD/gbz-base-js/compare/v7.0.0...v7.1.0) (2026-10-05)

### Other Changes

- HaplotypeOverview takes an abort signal ([0a869b7](https://github.com/GMOD/gbz-base-js/commit/0a869b70a8d3f7428487706b166b69620ecdb0c1))
- The keep threshold stays at 32: on HPRC v2.1 its crossover moves with the window ([5cefee1](https://github.com/GMOD/gbz-base-js/commit/5cefee1a3f184ef066f63020054a0ceb5e7ce610))
- Each named walk the cut holds and its span on its own path ([486ff07](https://github.com/GMOD/gbz-base-js/commit/486ff07b7f6b5e309471632d48c3688d45a8aece))

## [7.0.0](https://github.com/GMOD/gbz-base-js/compare/v6.0.1...v7.0.0) (2026-10-03)

### Other Changes

- The fuzzer's keep route calls subgraphInInterval with keep ([7fa3c2d](https://github.com/GMOD/gbz-base-js/commit/7fa3c2d37fd2139059e21ab9213e839c2ba52644))
- A hairpin walk two haplotypes share counts once ([e972f94](https://github.com/GMOD/gbz-base-js/commit/e972f942686a6493110ae952ca7e813faf36fd68))
- SubgraphInInterval rejects a reversed or NaN interval ([d233fe5](https://github.com/GMOD/gbz-base-js/commit/d233fe5213c75ea67ae3e8e12ffcd18e7ef6cf2e))
- Distinct output no longer depends on whether a haplotype index is attached ([0633500](https://github.com/GMOD/gbz-base-js/commit/063350041d53ac6eaff8a11d48ed7327c1b1298b))
- Keep stats count the reference among the pieces ([df30429](https://github.com/GMOD/gbz-base-js/commit/df30429f1c14a52a5c8ffe22e04f86471990bf91))
- Overlapping snarls: count distinct node ids, as upstream does ([b25ecee](https://github.com/GMOD/gbz-base-js/commit/b25ecee2b9125c37b2e173617d895273d7ba3588))
- Range-check a shared run's predecessor before looking up its seed ([aeda927](https://github.com/GMOD/gbz-base-js/commit/aeda927549c05fc18a29340e225a5077c44356a2))
- Chain toward the best chain that matches minMatch, not just the best chain ([f4dab73](https://github.com/GMOD/gbz-base-js/commit/f4dab7367441468d82ce00bc8c3378722b141270))
- Harden the pager: no unhandled prefetch rejections, no self-evicting prefetch ([a691810](https://github.com/GMOD/gbz-base-js/commit/a69181062f61467b96983e5ba263a9e4cb1211a9))
- Retry the path cache after a failure; check the schema version first ([043f24a](https://github.com/GMOD/gbz-base-js/commit/043f24a3b921d03bf0b4aa661b9ba1c63eac6640))
- Validate CLI arguments; exit quietly on a closed pipe ([4ddf283](https://github.com/GMOD/gbz-base-js/commit/4ddf283b7054cf46dca09a6bee52e006a8384927))
- Hash GFA names without crypto.subtle on insecure pages ([2db167b](https://github.com/GMOD/gbz-base-js/commit/2db167be16142ce41d51ac6c4c39479a3d0fd165))
- Limit caps the nodes in the subgraph, not per fragment ([472729c](https://github.com/GMOD/gbz-base-js/commit/472729c53582734256683ad98f02aedd42726258))
- Ship dual ESM/CJS like the other gmod parsers ([e929013](https://github.com/GMOD/gbz-base-js/commit/e9290130baa4ccee5ab72228b5fa6757ac3f16df))
- GetPathFragments throws on a NaN window instead of returning [] ([1a6f4bc](https://github.com/GMOD/gbz-base-js/commit/1a6f4bc0913fd0dd183abb8ecf64698b4c03099c))
- The 6.0.1 bug review and its fixes ([f6315e9](https://github.com/GMOD/gbz-base-js/commit/f6315e98dc1a7b5778812f58c9f52d454d002bb4))
- MergeDistinct and alignToRef settle deferred twins instead of merging them for good ([e5ef545](https://github.com/GMOD/gbz-base-js/commit/e5ef545f88ba2fd2517af08923050e4f3d9304d2))
- Queries reject offsets, context, limit and node ids that are not whole numbers ([13342e1](https://github.com/GMOD/gbz-base-js/commit/13342e13d0050b8d7e6cbdf236df95e083c36d07))
- The second Fable review and its fixes ([c3fe56e](https://github.com/GMOD/gbz-base-js/commit/c3fe56e216c48abeba6d2508509bb3e55a70438f))
- Budget a walk's prefetch runs together; prefetch only leaves in a scan ([1261e4d](https://github.com/GMOD/gbz-base-js/commit/1261e4dc04f1430206ea4e9b4eec5c709b3f7561))
- The CLI takes whole numbers; handoff records the prefetch fixes ([0d32289](https://github.com/GMOD/gbz-base-js/commit/0d3228930feeffe6969aa1ae6ce853aa2780e76d))
- Request study: harness and interim results for HTTP cost per view ([d13d509](https://github.com/GMOD/gbz-base-js/commit/d13d509c0eb66c479022fd110bacc51c748deebd))
- Request study: full sweep, large windows, prefetch on and off ([625d740](https://github.com/GMOD/gbz-base-js/commit/625d7408ec70cbf0ed1805c05308d730c3e8ecdd))
- Read haplotype index format 3, and fetch the keep route's rows in parallel with read-ahead ([2fef7a2](https://github.com/GMOD/gbz-base-js/commit/2fef7a2e2af9106e7be486c8252b6364db67b7a6))
- Test that formats 2 and 3 answer alike; a per-request breakdown tool ([8154a14](https://github.com/GMOD/gbz-base-js/commit/8154a1426f9ef07fa1e669a41eeaa2a912961c13))
- Keep route: read the subgraph's samples while the walks run ([54503d0](https://github.com/GMOD/gbz-base-js/commit/54503d05bf720e0d4e88764110097286917d310d))
- Request study: chr22 before and after format 3, with the local Range server and windows ([e631f29](https://github.com/GMOD/gbz-base-js/commit/e631f29427ce5955640b2fd710d3a109747f9379))
- Read the haplotype index's overview: every haplotype classed per bin at the level the zoom asks for ([c05730a](https://github.com/GMOD/gbz-base-js/commit/c05730a6c27ff0ede8853e5ae3840648794843aa))
- The overview query and flag; the study's final chr22 numbers ([5390b45](https://github.com/GMOD/gbz-base-js/commit/5390b457c930d770f14a31a943c30cce6344b467))
- Clamp the level, return undefined for a path without one; fixtures rebuilt with the corrected overview ([b4585a6](https://github.com/GMOD/gbz-base-js/commit/b4585a6d90dc2d1edcab3da6bbd1684f5a852a09))
- Overview renderers: a PNG from Node and a page in the browser, with the requests each view costs ([e25017d](https://github.com/GMOD/gbz-base-js/commit/e25017d6e86059f273c55c51df09f97fb4d4a0bd))
- Point the overview section at the renderers ([6eff627](https://github.com/GMOD/gbz-base-js/commit/6eff627bb91448406c538b4e8f4f91f53c280a70))
- Overview renderers: whole-genome costs with the hosted graph ([4814a29](https://github.com/GMOD/gbz-base-js/commit/4814a29e266f1bd247849716e89023ffe19903ce))
- Overview renderers: costs from local disk with the production index ([438c692](https://github.com/GMOD/gbz-base-js/commit/438c692863c4702aaa02bbea8a4a218271fd68c4))
- Validation sweep: open and query through the current API ([fcdae2c](https://github.com/GMOD/gbz-base-js/commit/fcdae2c18c1450d3e2263f3046eaa269191ae676))
- Read format 3 alone ([39fe18b](https://github.com/GMOD/gbz-base-js/commit/39fe18b7a62ac19a4926c6fa94729a823758b764))
- CI fuzz installs gbz-haplotype-index 0.3.0, which writes format 3 ([310e350](https://github.com/GMOD/gbz-base-js/commit/310e350d5b7a5bac63208a412ad84d920f4ba7e4))
- Export the overview's types and class constants from the package entry ([4e7498c](https://github.com/GMOD/gbz-base-js/commit/4e7498cc6c9d678a4245d256e6f84ebeb4944cff))
- HPRC tests and request tools read the hosted format 3 index ([5663b5e](https://github.com/GMOD/gbz-base-js/commit/5663b5ebd5debe04cb2b9a1aaa78b62a9dc2fb12))
- ESLint skips the overview page's build output ([7df06f1](https://github.com/GMOD/gbz-base-js/commit/7df06f1ae53340bf3855c87b65145be043785666))
- Prettier on the files that missed it ([1392647](https://github.com/GMOD/gbz-base-js/commit/1392647116a9e530346baf434becd2f4a2ea4608))

## [6.0.1](https://github.com/GMOD/gbz-base-js/compare/v6.0.0...v6.0.1) (2026-10-02)

### Other Changes

- Close the holes a review of 6.0.0 found ([89acd08](https://github.com/GMOD/gbz-base-js/commit/89acd085899f65daa1eb7f9342cf3837b165bcb6))
- The data-flow diagram names the 6.0 methods; only interval queries set the limit error's window fields ([a6f55b1](https://github.com/GMOD/gbz-base-js/commit/a6f55b15f0b96c525e891b5177a5eee2d638ae9a))

## [6.0.0](https://github.com/GMOD/gbz-base-js/compare/v5.0.0...v6.0.0) (2026-10-02)

### Other Changes

- Released, and the hosted index carries stray rows ([f126008](https://github.com/GMOD/gbz-base-js/commit/f12600852764df7e2ec24b9461f8bcfa12d1bb45))
- Move the indexer crate and the haplotype index docs to GMOD/gbz-haplotype-index ([ebf8c19](https://github.com/GMOD/gbz-base-js/commit/ebf8c192c8780a1f87002d68a79494c26996fe6a))
- Keep-bounds fixture puts anchors and visits on each walk boundary ([d5316b6](https://github.com/GMOD/gbz-base-js/commit/d5316b6b34d7bccf6b8535ecca53e09dedbed089))
- Every reader boundary mutant is killed but the equivalent one ([9b91f25](https://github.com/GMOD/gbz-base-js/commit/9b91f2587fdbd0c8c0e5abc3738f001c4759e9aa))
- Update README.md ([f5530bc](https://github.com/GMOD/gbz-base-js/commit/f5530bc3424b1649bc7bd680112ac611a2362f5f))
- Take one options object everywhere, and read the file size from the SQLite header ([4e1d1ef](https://github.com/GMOD/gbz-base-js/commit/4e1d1ef7f3d1ceab0fba4419350f910edbf2323e))
- The options-object API ([e0d6909](https://github.com/GMOD/gbz-base-js/commit/e0d6909ae80015f7f0875b5939122a1a13a450ec))

## [5.0.0](https://github.com/GMOD/gbz-base-js/compare/v4.1.0...v5.0.0) (2026-10-01)

### Other Changes

- Genome-wide keep sweep on 4.1.0, and a stray-section table measured ([9a9099d](https://github.com/GMOD/gbz-base-js/commit/9a9099dad08ec490bf7967568f59cb925cf29a9e))
- Keep route: walk adjacent anchor sections and stray rows when the index lists them ([bfa1c05](https://github.com/GMOD/gbz-base-js/commit/bfa1c058a9f19636d153def74634c4cf1c739485))
- Store stray rows WITHOUT ROWID, route diagram for the stray route, --stats line ([12d3b64](https://github.com/GMOD/gbz-base-js/commit/12d3b64eaa190feb0261d6e7069e9a242fc4e787))
- Stray rows: keep loci within 4 kb of one another as one, and test the 4 kb around each ([43f9a45](https://github.com/GMOD/gbz-base-js/commit/43f9a45a1ee182a61aec5501f4d4702d5f49e709))
- Fixture for a contig with no anchor visit and no sample in the window ([1e3012e](https://github.com/GMOD/gbz-base-js/commit/1e3012ec50dd49b49cb7da1c82d163a765b3c239))
- Stray rows by reference bin, checked against the nodes the haplotype index lists per bin ([cfd462f](https://github.com/GMOD/gbz-base-js/commit/cfd462fd9a23f4d1d9925b34c298f906489b54e7))
- Keep with distinct walks merges after choosing, and keepHaplotypes refuses unnamed or merged walks ([2209c00](https://github.com/GMOD/gbz-base-js/commit/2209c0078fd4dea55f7f9afd3534fa33beae239d))
- One keep route: a haplotype index without stray rows identifies every walk ([72fa932](https://github.com/GMOD/gbz-base-js/commit/72fa932cead6e4b4c225de34eb5e991217201e98))
- Twins from reverse samples in the window, crate 0.2.0, fixture rebuild script ([29798dd](https://github.com/GMOD/gbz-base-js/commit/29798dd0399a6306f2b78b561f5c4d4bbf999833))
- Bins, stray rows and the keep route's checks ([fc5cfde](https://github.com/GMOD/gbz-base-js/commit/fc5cfde5d9f55fb81f77fc0a5e6cf3171338574b))
- Run the sampled route once per window and narrow a copy per keep set ([8a35d4d](https://github.com/GMOD/gbz-base-js/commit/8a35d4d8e7326eaf16c75411417f7ba41b369daa))
- Fixes from the fuzzer: a walked stretch ends before the next node, and a reference walk on a reverse handle ([9eb3436](https://github.com/GMOD/gbz-base-js/commit/9eb3436b0318aa699050452b606f6f005f798145))
- Export the stray row types, hosted-index test for both index formats, handoff draft ([c15666b](https://github.com/GMOD/gbz-base-js/commit/c15666b492dbe45835b9c7659f39f9d7bffb9fbf))
- What the sweeps, the GBZ truth and the fuzzer measured ([3be4f8c](https://github.com/GMOD/gbz-base-js/commit/3be4f8ceee743dd4831ad96917986f4b01e95ae3))
- Indexer README: give graph.gbz.db with the GBZ ([861ff44](https://github.com/GMOD/gbz-base-js/commit/861ff449a5b7990487ad67ee15d4389a21ec5ea5))
- A filled snarl can add nodes outside the bins ([0d232f7](https://github.com/GMOD/gbz-base-js/commit/0d232f751388572bb25f7799791324524ae9f6ee))
- Keep-all on the targeted windows ([7d54634](https://github.com/GMOD/gbz-base-js/commit/7d546349c16040656f6fbf1cc2e782f854f1ed37))
- GetSubgraphForRange refuses a window that spans several fragments of the path ([e7752ca](https://github.com/GMOD/gbz-base-js/commit/e7752ca7c5df9aa5dca854e97542643b5ed4115b))
- The index to host, the 32 kb-anchor build, and what the plugin session did ([947cb6c](https://github.com/GMOD/gbz-base-js/commit/947cb6c2bc3f9793f4d7a7d4ad010b25e5ab47d1))
- HPRC tests default to the hosted index; AMY1 expects the 1,362 records that joined detours give; README: bump the stray format tag with the rule ([fa083e6](https://github.com/GMOD/gbz-base-js/commit/fa083e6bf9e797c9d08492eeacb8d30570a5ad4c))
- What this session verified on ada, the paper edits, and the audit left running ([e400b78](https://github.com/GMOD/gbz-base-js/commit/e400b78cc2b7ae8dc376136370035e37dbd9bcf0))
- Keep route: read the anchor past one that starts exactly `bound` outside the bins ([4c7f8f8](https://github.com/GMOD/gbz-base-js/commit/4c7f8f8a890c0edd12c4bc4559ae7e6ac391c7ab))
- --edge-windows aims windows at the stray bound around each anchor ([05dc15e](https://github.com/GMOD/gbz-base-js/commit/05dc15e93b9a925d8b7945cdd027253e36781791))
- Handoff and docs: the audit's finding, its fuzz runs on the fixed code, and what remains ([47e6500](https://github.com/GMOD/gbz-base-js/commit/47e65006e5cb96b3f416395083568aabd5d0b4b4))
- The audit paragraph without the colon ([40d45de](https://github.com/GMOD/gbz-base-js/commit/40d45de7742eae2f8d795014108e17c1cd473f23))
- The longest HPRC node is 1,024 bp, not 342; the build's peak memory in the doc's own units; the large stratum ran two settings ([55936ca](https://github.com/GMOD/gbz-base-js/commit/55936ca5836e021f7ca6c2b201caa0ae44feb336))
- Drop a walk's twin once identification shows it is the same stretch read the other way ([d8e36f2](https://github.com/GMOD/gbz-base-js/commit/d8e36f24f3947860cb4ef9ff72957f1d4ff289f2))
- The evening's cross-validation, the twin fix, the plugin and BandageJS state, the chains on ada ([0d9894a](https://github.com/GMOD/gbz-base-js/commit/0d9894a536f5971c35b79878071fdf73be2e37e0))
- List walks in upstream's order, by start handle then offset ([b1f737c](https://github.com/GMOD/gbz-base-js/commit/b1f737c21712a44b99e854ff88e4f7ffa074810e))
- What the GBWT and gbz-base each name, and the terms upstream uses ([aafb2bc](https://github.com/GMOD/gbz-base-js/commit/aafb2bcda504f41c1462a2b15dcc05e24cbd5c1e))
- The review against upstream and the chain on the final main ([eb7ba8c](https://github.com/GMOD/gbz-base-js/commit/eb7ba8cecc65094cdf909c86cd6493e7659f4012))
- Fuzz against GFA truth on every push, so the indexer's stray-row rule and the reader's walks cannot drift apart unnoticed ([a6a46b2](https://github.com/GMOD/gbz-base-js/commit/a6a46b24e21074da2a511d28341a8d2d9d993ccc))
- The CI fuzz job and the plugin's stray-row fixtures ([c187528](https://github.com/GMOD/gbz-base-js/commit/c187528f704626d750cf1cbd711aeaeb085acac9))
- The walk-rows gap run, the 4.0.29 release, BandageJS already fixed on its main ([77afc46](https://github.com/GMOD/gbz-base-js/commit/77afc469fdb9218c2d3a4b029d2749b6ad636959))
- Build every database with chains from a vg distance index, and count the keep queries that fill a snarl ([3ff9d6c](https://github.com/GMOD/gbz-base-js/commit/3ff9d6c35ee2e9c0a82cdaba96aa0d35431c5b27))
- Snarl fills under fuzz, with chains in every database ([255d553](https://github.com/GMOD/gbz-base-js/commit/255d553c0418cd071da27e9eed9b395bb183c549))
- A large scale, 150-400 kb references with 16-40 haplotypes and six sites of each structural kind ([0820dfe](https://github.com/GMOD/gbz-base-js/commit/0820dfec64a75b545cb32ab5db5717b401e7c717))
- The large fuzz scale and its two batches ([c752b0e](https://github.com/GMOD/gbz-base-js/commit/c752b0e18e64afba30b1c03d0d42871b8e14cc05))
- Chains 3 and 4 complete and identical, chain5 under way, two more large fuzz batches ([059b7a3](https://github.com/GMOD/gbz-base-js/commit/059b7a3640b7751192b21a71a46568d313a943f7))
- Handoff closed: chain5 matched on every pass; docs record the rerun and the snarl-fill and large fuzz batches ([20141e5](https://github.com/GMOD/gbz-base-js/commit/20141e5fcca98107c82bf467839163a64234da33))
- Proof that the keep route finds every piece, from the code on both sides ([10f23ab](https://github.com/GMOD/gbz-base-js/commit/10f23abf9ab7f3904e97f65c2ea8ccb44a1d6254))
- Figures for the keep-route proof, the walks that reach a bin and a filled snarl ([0ddb077](https://github.com/GMOD/gbz-base-js/commit/0ddb0775fc7b9b5d307b1ae9e6ed9cd92e11b6af))
- Keep-route proof states the assumptions an adversarial review found unstated ([f83696e](https://github.com/GMOD/gbz-base-js/commit/f83696e22a816d3f176b9374dc63ecd991d7bf02))
- The low anchor loop never moves, so mutating its comparison changes nothing ([fcd347c](https://github.com/GMOD/gbz-base-js/commit/fcd347ce74e61280a37bcdf863f1f23f372b59e9))

## [4.1.0](https://github.com/GMOD/gbz-base-js/compare/v4.0.0...v4.1.0) (2026-09-28)

### Other Changes

- Write the bin path as npm normalizes it ([9e0e975](https://github.com/GMOD/gbz-base-js/commit/9e0e975cf6adf79bdfaf86b1a511deecce07e52b))
- --reference-interval samples the reference paths more densely ([4e9eec4](https://github.com/GMOD/gbz-base-js/commit/4e9eec4f329530e81668fd5510bb83328e881cb1))
- Test the far-sample fallback on a reference stretch the context reaches ([485f9da](https://github.com/GMOD/gbz-base-js/commit/485f9daa34e8f555b82234f3f1a19fee32fc30ab))
- --reference-interval, and what puts a sample far from its anchors ([00e98c3](https://github.com/GMOD/gbz-base-js/commit/00e98c3947652f5ba5341b8dc9b6229163d0b79d))
- The keep route walks as far as its sample check allows, and falls back on two copies ([09c5bd5](https://github.com/GMOD/gbz-base-js/commit/09c5bd59c3484c4533e1cb2cf0604724ab3b40d3))
- Walk a chosen path's extra anchor visit near its pairs, and correct the keep docs ([665e4bb](https://github.com/GMOD/gbz-base-js/commit/665e4bb609e97508e318037229e9b0694426d555))
- Keep-route omission modes, what is fixed, and the plan to close the rest ([3c33200](https://github.com/GMOD/gbz-base-js/commit/3c332002522fd7651d0047a59504e0a0113fbb80))
- Alignment records join a walk that leaves the subgraph and comes back ([4aed986](https://github.com/GMOD/gbz-base-js/commit/4aed98610539e8e8fdd3ad9da484e61bbadc7ced))
- Joined records count aligned bases, and a detour piece joins between two ends ([61f3125](https://github.com/GMOD/gbz-base-js/commit/61f312521b64ac7358b1becd194d4fe605f1702a))

## [4.0.0](https://github.com/GMOD/gbz-base-js/compare/v3.0.0...v4.0.0) (2026-09-28)

### Other Changes

- Say what the two naming routes mean for a query ([574e67e](https://github.com/GMOD/gbz-base-js/commit/574e67efa828976bd36a88ddfbc2ef380ad253fe))
- Pare down haplotype naming, fix writing tropes ([bd185a3](https://github.com/GMOD/gbz-base-js/commit/bd185a37b5b787ba6b2410ef864c396c8328fefb))
- One name for the haplotype index, fix fragments and vague counts ([34f4f20](https://github.com/GMOD/gbz-base-js/commit/34f4f20dcad50ad5ff7b8a893ec8cfa6c42d36c0))
- Explain keep and the two naming routes, add a route diagram ([8b9bcd7](https://github.com/GMOD/gbz-base-js/commit/8b9bcd76025e9bb77fd58aceb4b2f5400e6ced5f))
- Draw where the naming routes walk, tighten the claims ([b6aa8b1](https://github.com/GMOD/gbz-base-js/commit/b6aa8b1a7ab699ec33793815643ea39049a2093b))
- Move the programs table below the examples, drop two columns ([cc30ebe](https://github.com/GMOD/gbz-base-js/commit/cc30ebe010e1ec8eb9b332e662171cde2366a84c))
- Explain what a haplotype sample is and why the index samples ([3734678](https://github.com/GMOD/gbz-base-js/commit/373467874817c96b44ad4afb91c754b075ee04b0))
- Let diagrams take the page width instead of fixed pixel widths ([1f22ec3](https://github.com/GMOD/gbz-base-js/commit/1f22ec3494f63c5e06f7928f967722eb1bc83191))
- Simplify the haplotype index page and its two diagrams ([c969ef6](https://github.com/GMOD/gbz-base-js/commit/c969ef6968120633731ddfd9a0eeff58ddc3edf3))
- Shorten the haplotype index page, fix route details from review ([2c97a0f](https://github.com/GMOD/gbz-base-js/commit/2c97a0faae25f41550e38b92b3105367847146f4))
- Say "identify" and "haplotype index" plainly, introduce keep where used ([1fb7f06](https://github.com/GMOD/gbz-base-js/commit/1fb7f0612248dbaac4ef86b91391b310187eccd3))
- Show where the naming-route diagrams read their data ([ded1914](https://github.com/GMOD/gbz-base-js/commit/ded1914943ecc3a099a45b6bf60a1d07f108ee9f))
- Give the naming-routes flowchart a legend for its data sources ([883a167](https://github.com/GMOD/gbz-base-js/commit/883a1678f4045a0ee904049d1a281af1dd5e7d83))
- Stack the naming-routes legends in a box, top right ([5ab38f5](https://github.com/GMOD/gbz-base-js/commit/5ab38f574877dc8322a2124f3c9686994cba1bf0))
- Redraw the naming-route diagrams, say when keep applies ([f3580b7](https://github.com/GMOD/gbz-base-js/commit/f3580b7495968215d4351d8dfc9a1d1c0ca00f94))
- Name the actor and the file on every page ([97df439](https://github.com/GMOD/gbz-base-js/commit/97df439baf6e1ac0d4f4aa15a423d6edeb0b9914))
- Spell out the keep option in the naming-route diagrams ([4286901](https://github.com/GMOD/gbz-base-js/commit/4286901491f7f4adfb02ba3944b3b8f810ad360d))
- Split the naming-route decision into keep and anchor checks ([3018d09](https://github.com/GMOD/gbz-base-js/commit/3018d0900251dc708c2f04d456bf91add65b7dbf))
- Say "a query that uses the keep option", add docs/CLAUDE.md ([c8e75a2](https://github.com/GMOD/gbz-base-js/commit/c8e75a24a5d62d7c00943f19c0dd1212db7224ae))
- Draw what graph.gbz.db stores and what samples add ([0414c81](https://github.com/GMOD/gbz-base-js/commit/0414c818c954f6e3ff46233cf45305670fc6bc5e))
- Draw where anchors sit on chr6, say why keep starts from one ([c7e675c](https://github.com/GMOD/gbz-base-js/commit/c7e675c0dfc34b028989846fd99f1d70857b999f))
- Index builder: anchor one reference sample, break ties toward the multiple ([4bbfe6c](https://github.com/GMOD/gbz-base-js/commit/4bbfe6cf5aab8cf6232f80b9cda4eb294f56437a))
- The keep route returns the sampled route's walks, found from the index ([3fea39c](https://github.com/GMOD/gbz-base-js/commit/3fea39c6dda670c07fe51fed53c4275c7bf5c2e3))
- The keep route certifies its walks and otherwise identifies every walk ([7e2ce29](https://github.com/GMOD/gbz-base-js/commit/7e2ce29605496e9e565c6c6b28ee7ad8046e4f91))
- The keep route places every path from its anchor visits before it trusts a walk ([8d65000](https://github.com/GMOD/gbz-base-js/commit/8d65000be8410ffdf432f2da20c52a79250d24eb))
- A one-sided walk is trusted when the contig ends, or a wider anchor pairs it ([bd0ed92](https://github.com/GMOD/gbz-base-js/commit/bd0ed9232acbe9971f20362411ab3095afd82817))
- The keep route's checks, its measured limit, and the tutorial timings ([ec2b502](https://github.com/GMOD/gbz-base-js/commit/ec2b502cba914421e0781002b381bac553dd065e))
- The keep route reads two anchors out on each side for every query ([bfab963](https://github.com/GMOD/gbz-base-js/commit/bfab963ce3bf6163bd5829a90703a49d63431c77))
- The keep route reads its anchors in two rounds and falls back when it sees no chosen path ([a195785](https://github.com/GMOD/gbz-base-js/commit/a1957857d9d453c813e04325a5f4a2c2a1564ced))
- Parity and timings for the route that reads six anchors ([0489898](https://github.com/GMOD/gbz-base-js/commit/0489898756c6ed4e5ffa655fa9c05cc446ec276e))

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

