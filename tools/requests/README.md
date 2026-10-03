# HTTP requests per view

How many range requests, and how many bytes, one cold window query costs when
JBrowse reads the HPRC v2.1 GRCh38 graph and its haplotype index over HTTPS.
The metrics follow the request-shape counts in
[jb2bench](https://github.com/cmdcolin/jb2bench): requests per view, bytes per
view, cold cache.

- **Requests** count every HTTP request `RemoteFile` sends, through a `fetch`
  wrapper that `query.ts` hands it, split between the graph database and the
  haplotype index. Each one is a single `Range` GET answered with 206. The
  pager's own `fetches` counter agreed with the wrapper on every query.
- **Bytes** sum the `Content-Length` of those responses.
- **Cold** means a fresh node process per query, so the pager cache, the Paths
  table and the b-tree interiors start empty. The tables split out the
  window-only cost (the `extract`, `identify` and `gfa` phases), which is what
  a pan costs a browser session that already holds the Paths table.

## Files

- `query.ts` runs one query and prints one JSON line: requests and bytes per
  file and per phase, phase milliseconds, node and path counts, the
  identification counters (`companionSeeks`, `graphLookups`) and the keep
  route's stats.
- `windows.py` writes the window sets: `windows.json` (small windows) and
  `windows-large.json` (`windows.py large`).
- `run.py` runs `query.ts` once per window, route and prefetch setting, in
  parallel, each in its own process under `timeout` and `/usr/bin/time -v`.
- `summarize.py` writes the CSVs and prints the tables below.
- `results.csv`, `results.jsonl`, `large.csv` and `large.jsonl` are the raw
  per-query results this README reports; `probe-maxblocks.jsonl` is one 3 Mb
  query rerun with a 1024-block cache.
- `windows-random.json` is `windows.json` cut to the random strata, for the
  prefetch-off pass.

## Settings

`query.ts` cuts a window the way the GraphTrack's `GbzBaseSyntenyAdapter`
does (`cutWindowGFA` in jbrowse-plugin-graphgenomeviewer's
`packages/core/src/gbzWindow.ts`):

| setting | value | source |
| --- | --- | --- |
| `context` | 1000 bp | `GBZ_CUT_DEFAULTS` |
| `snarls` | `contained` | `GBZ_CUT_DEFAULTS` |
| `limit` | 100,000 nodes (small windows); none (large windows) | `GBZ_CUT_DEFAULTS` |
| `haplotypes` | `all` | `cutWindowGFA` |
| block size | 64 KiB | library default; the adapter sets none |
| pager cache | 256 blocks (16 MiB) per file | library default |

Phases, in order:

1. `open`: the SQLite header, schema and `Tags` of both files.
2. `paths`: `db.paths()` (the whole `Paths` table) and the window's path
   fragments, as the adapter does before its first cut.
3. `extract`: `subgraphInInterval`, with the `keep` predicate on the keep
   routes.
4. `identify`: `identifyPaths()`, which the adapter calls on the sampled route
   when a haplotype index is present.
5. `gfa`: `toGFA()`.

Routes:

- `sampled`: no `keep`; extracts every walk and identifies each from the
  haplotype index.
- `keep1`: `keep` for sample HG002 (both haplotypes).
- `keep8`: `keep` for the eight haplotypes the library's tests use
  (`HG00097#1`, `HG00099#1`, `HG00128#1`, `HG00133#1`, `HG01109#1`,
  `HG01123#1`, `HG01960#1`, `HG02055#1`).

The library has no switch for prefetch, so `query.ts` turns it off by
replacing `BTree.prefetchRowidRanges` with a no-op and making
`Pager.prefetchLeading` claim one page at a time. With prefetch off, the
reference-walk prefetch, the `ReferenceIndex` range prefetch and the leaf
read-ahead in table scans are gone, and every page is read on demand.

## Commands

From the checkout root, with `node_modules` installed:

```sh
python3 tools/requests/windows.py > tools/requests/windows.json
python3 tools/requests/windows.py large > tools/requests/windows-large.json
python3 -c "import json; w = json.load(open('tools/requests/windows.json')); json.dump([x for x in w if x['stratum'].startswith('random')], open('tools/requests/windows-random.json', 'w'))"

PREFETCH=on python3 tools/requests/run.py tools/requests/windows.json tools/requests/results.jsonl 14
PREFETCH=off python3 tools/requests/run.py tools/requests/windows-random.json tools/requests/results.jsonl 14
ROUTES=sampled,keep1 PREFETCH=on LIMIT=none HEAP=5000 TIMEOUT=600 \
  python3 tools/requests/run.py tools/requests/windows-large.json tools/requests/large.jsonl 3

python3 tools/requests/summarize.py tools/requests/results.jsonl tools/requests/results.csv \
  tools/requests/large.jsonl tools/requests/large.csv
```

`GRAPH` and `INDEX` point `query.ts` at other copies (any http(s) URL);
`CONTEXT`, `SNARLS`, `LIMIT`, `BLOCK_SIZE` and `MAX_BLOCKS` change the query
settings.

## Run of 2026-10-03

@gmod/gbz-base 6.0.1 at 0d32289, against the hosted HPRC v2.1 GRCh38 graph
(`https://s3-us-west-2.amazonaws.com/human-pangenomics/pangenomes/freeze/release2/minigraph-cactus/v2.1/hprc-v2.1-mc-grch38/hprc-v2.1-mc-grch38.gbz.db`)
and the hosted anchored haplotype index
(`https://jbrowse.org/demos/hprc/hprc-v2.1-mc-grch38.haplotype-index.anchored.db`).
The machine holds no local copy of either file.

Windows per cell: 14 random (10 on chr6, 2 on chr1, 2 on chr17), 4 segmental
duplications (AMY1, LPA KIV-2, SMN1/SMN2, C4A/C4B, centered), 3 unplaced
contigs (`chr1_KI270706v1_random`, `chrUn_GL000220v1`,
`chr14_GL000225v1_random`, from offset 20 kb). Prefetch off ran on the random
windows only. All 637 small-window queries succeeded and no keep query fell
back to identifying every walk.

### Median per cold view, random windows, prefetch on

| route | window | requests (graph + index) | MB (graph + index) | window-only requests | window-only MB | nodes | ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sampled | 300 | 20 (13 + 7.5) | 3.80 (3.34 + 0.49) | 12 | 0.79 | 98 | 4,699 |
| sampled | 1,000 | 21 (13 + 8) | 3.87 (3.34 + 0.52) | 13 | 0.85 | 118 | 4,795 |
| sampled | 3,000 | 20 (12 + 7.5) | 3.80 (3.28 + 0.49) | 12 | 0.79 | 196 | 4,520 |
| sampled | 10,000 | 20 (13 + 7) | 3.80 (3.34 + 0.46) | 12 | 0.79 | 436 | 4,390 |
| sampled | 30,000 | 22 (13 + 8.5) | 3.93 (3.41 + 0.56) | 14 | 0.92 | 1,321 | 4,392 |
| sampled | 100,000 | 25 (14 + 12) | 4.33 (3.60 + 0.79) | 17 | 1.31 | 4,292 | 4,906 |
| keep1 | 300 | 37 (15 + 22) | 5.34 (3.93 + 1.44) | 29 | 2.33 | 68 | 4,367 |
| keep1 | 1,000 | 36.5 (15 + 21.5) | 5.41 (4.00 + 1.41) | 28.5 | 2.39 | 84 | 4,794 |
| keep1 | 3,000 | 38 (15 + 22) | 5.41 (3.96 + 1.44) | 30 | 2.39 | 140 | 5,236 |
| keep1 | 10,000 | 38 (16 + 21.5) | 5.37 (3.96 + 1.41) | 30 | 2.36 | 315 | 5,030 |
| keep1 | 30,000 | 40.5 (16 + 24) | 5.54 (3.93 + 1.57) | 32.5 | 2.52 | 942 | 4,970 |
| keep1 | 100,000 | 43 (17 + 26) | 5.93 (4.26 + 1.70) | 35 | 2.92 | 2,987 | 5,363 |
| keep8 | 300 | 37 (15 + 22) | 5.34 (3.93 + 1.44) | 29 | 2.33 | 68 | 4,309 |
| keep8 | 1,000 | 36.5 (15 + 21.5) | 5.44 (4.00 + 1.41) | 28.5 | 2.42 | 87 | 4,942 |
| keep8 | 3,000 | 38 (15 + 22) | 5.41 (3.96 + 1.44) | 30 | 2.39 | 145 | 5,554 |
| keep8 | 10,000 | 38 (16 + 21.5) | 5.37 (3.96 + 1.41) | 30 | 2.36 | 322 | 5,016 |
| keep8 | 30,000 | 40.5 (16 + 24) | 5.54 (3.93 + 1.57) | 32.5 | 2.52 | 984 | 4,986 |
| keep8 | 100,000 | 43 (17 + 26) | 5.93 (4.26 + 1.70) | 35 | 2.92 | 3,152 | 5,362 |

### Median per cold view, random windows, prefetch off

| route | window | requests (graph + index) | MB (graph + index) | window-only requests | ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| sampled | 300 | 58 (51 + 7.5) | 3.80 (3.34 + 0.49) | 12 | 8,702 |
| sampled | 1,000 | 59 (51 + 8) | 3.87 (3.34 + 0.52) | 13 | 8,276 |
| sampled | 3,000 | 58 (50 + 7.5) | 3.80 (3.28 + 0.49) | 12 | 8,192 |
| sampled | 10,000 | 58 (51 + 7) | 3.80 (3.34 + 0.46) | 12 | 8,042 |
| sampled | 30,000 | 60 (52 + 8.5) | 3.93 (3.41 + 0.56) | 14 | 8,125 |
| sampled | 100,000 | 66 (55 + 12) | 4.33 (3.60 + 0.79) | 20 | 9,646 |
| keep1 | 300 | 81.5 (60 + 22) | 5.34 (3.93 + 1.44) | 35.5 | 9,352 |
| keep1 | 1,000 | 82.5 (61 + 21.5) | 5.41 (4.00 + 1.41) | 36.5 | 9,556 |
| keep1 | 3,000 | 82.5 (60.5 + 22) | 5.41 (3.96 + 1.44) | 36.5 | 9,732 |
| keep1 | 10,000 | 82 (60.5 + 21.5) | 5.37 (3.96 + 1.41) | 36 | 9,479 |
| keep1 | 30,000 | 84.5 (60 + 24) | 5.54 (3.93 + 1.57) | 38.5 | 9,566 |
| keep1 | 100,000 | 90.5 (65 + 26) | 5.93 (4.26 + 1.70) | 44.5 | 10,892 |
| keep8 | 300 | 81.5 (60 + 22) | 5.34 (3.93 + 1.44) | 35.5 | 9,296 |
| keep8 | 1,000 | 83 (61 + 21.5) | 5.44 (4.00 + 1.41) | 37 | 9,594 |
| keep8 | 3,000 | 82.5 (60.5 + 22) | 5.41 (3.96 + 1.44) | 36.5 | 9,803 |
| keep8 | 10,000 | 82 (60.5 + 21.5) | 5.37 (3.96 + 1.41) | 36 | 9,696 |
| keep8 | 30,000 | 84.5 (60 + 24) | 5.54 (3.93 + 1.57) | 38.5 | 9,390 |
| keep8 | 100,000 | 90.5 (65 + 26) | 5.93 (4.26 + 1.70) | 44.5 | 11,072 |

Prefetch cuts a cold view's requests 2.6 to 2.9 times on the sampled route and
2.1 to 2.2 times with keep, and roughly halves its time; bytes stay the same.
Most of the saving is the `Paths` table scan: 5 graph requests and 1.9 s with
prefetch, 43 and 6.0 s without. The window itself changes less: extraction
takes 6 graph requests either way on the sampled route at 300 bp, and 9 against
16 with keep. Index reads never coalesce, so prefetch leaves index requests
alone.

### Segmental duplications and unplaced contigs, prefetch on

| stratum | route | 300 bp | 3 kb | 10 kb | 30 kb | 100 kb |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| segdup | sampled | 21 / 3.87 MB | 22 / 3.93 MB | 28.5 / 4.36 MB | 25 / 4.72 MB | 29.5 / 5.21 MB |
| segdup | keep1 | 39 / 5.90 MB | 40.5 / 5.96 MB | 42 / 6.00 MB | 41 / 6.32 MB | 46 / 6.82 MB |
| segdup | keep8 | 39 / 5.96 MB | 40.5 / 5.96 MB | 43.5 / 6.13 MB | 42 / 6.46 MB | 46.5 / 6.85 MB |
| unplaced | sampled | 17 / 3.60 MB | 17 / 3.60 MB | 18 / 3.67 MB | 19 / 3.74 MB | 21 / 3.87 MB |
| unplaced | keep1 | 26 / 4.19 MB | 26 / 4.19 MB | 26 / 4.19 MB | 26 / 4.19 MB | 29 / 4.39 MB |

Each cell is median requests / median bytes. `summarize.py` prints the full
tables with the graph and index split and the 1 kb column.

### Where the requests go

Median requests (graph + index) and ms per phase, random windows, prefetch on:

| route | window | open | paths | extract | identify | gfa |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| sampled | 300 | 1+1 / 612 ms | 5+1 / 1,922 ms | 6+0 / 862 ms | 0+5.5 / 1,109 ms | 0+0 / 5 ms |
| sampled | 10,000 | 1+1 / 666 ms | 5+1 / 2,177 ms | 7+0 / 979 ms | 0+5 / 425 ms | 0+0 / 20 ms |
| sampled | 100,000 | 1+1 / 642 ms | 5+1 / 2,096 ms | 8+0 / 1,312 ms | 0+10 / 631 ms | 0+0 / 134 ms |
| keep1 | 300 | 1+1 / 614 ms | 5+1 / 1,978 ms | 9+20 / 1,708 ms | 0+0 / 0 ms | 0+0 / 3 ms |
| keep1 | 10,000 | 1+1 / 676 ms | 5+1 / 2,106 ms | 10+19.5 / 2,059 ms | 0+0 / 0 ms | 0+0 / 6 ms |
| keep1 | 100,000 | 1+1 / 644 ms | 5+1 / 2,112 ms | 11+24 / 2,530 ms | 0+0 / 0 ms | 0+0 / 28 ms |

- Opening and the `Paths` table cost the same for every window: 8 requests and
  2.95 MB, about 2.6 s. For a small sampled view that is 8 of 20 requests and
  over three quarters of the bytes. The adapter caches `db.paths()`, so a
  session pays it once.
- Sampled extraction reads only the graph, 6 to 8 requests from 300 bp to
  100 kb, since the reference-walk prefetch fetches a window's node records in
  one or two coalesced reads. Identification reads only the index, 5 to 10
  requests. `companionSeeks` and `graphLookups` stay at 0 on random windows.
- The keep route's extra cost is the index: 20 to 24 single-block (64 KiB)
  index requests during extraction. keep1 and keep8 cost the same, because the
  keep route reads the window's index rows whatever it keeps.

### Large windows on chr6

`LIMIT=none`, 5 GB node heap, 600 s cap, prefetch on. Ranges cover the windows
in each row; `large.csv` has every query and its phase times.

| window | route | status | requests (graph + index) | MB | nodes | paths | total s | peak RSS MB |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 300 kb (3) | sampled | ok | 34-36 (14 + 20-22) | 5.6-5.8 | 12,763-14,566 | 464 | 6.5-7.2 | 523-580 |
| 300 kb (3) | keep1 | ok | 53-54 (17-18 + 35-36) | 7.1-7.6 | 8,782-10,097 | 3 | 6.0-6.5 | 306-315 |
| 1 Mb (3) | sampled | ok | 69-76 (17-21 + 48-55) | 9.9-11.0 | 42,458-69,941 | 464-468 | 14.4-17.2 | 1,111-1,977 |
| 1 Mb (3) | keep1 | ok | 86-92 (22-24 + 64-70) | 11.3-13.3 | 28,954-50,461 | 3 | 9.4-10.6 | 439-510 |
| 3 Mb (2) | sampled | ok | 287 (150 + 137) | 21.3 | 119,116-119,310 | 464-468 | 42.2-44.1 | 2,835-3,584 |
| 3 Mb (2) | keep1 | ok | 309-315 (158-160 + 151-155) | 22.7-23.1 | 83,182-83,595 | 3 | 31.5-36.1 | 761-817 |
| 10 Mb (1) | sampled | error in `toGFA`: Invalid string length | 1,547 (1,098 + 449) | 106.7 | - | - | 216.9 | 7,952 |
| 10 Mb (1) | keep1 | ok | 1,661 (1,110 + 551) | 115.9 | 274,015 | 3 | 173.1 | 1,816 |
| 170.8 Mb (whole chr6) | sampled | timeout in extract | 4,241 (4,239 + 2) | 286.9 | - | - | 600 | 3,834 |
| 170.8 Mb (whole chr6) | keep1 | timeout in extract | 4,132 (4,130 + 2) | 279.7 | - | - | 600 | 3,816 |

Requests grow slowly up to 1 Mb, then graph requests jump from about 21 to 150
between 1 Mb and 3 Mb. The pager lets one prefetch claim at most half its
cache, 128 blocks or 8 MiB; past that, `prefetchRowidRanges` refuses and the
walk reads one block per request. With `MAX_BLOCKS=1024` the same 3 Mb sampled
window took 27 graph requests and 25 s instead of 150 and 44 s
(`probe-maxblocks.jsonl`), while its 137 index requests stayed the same. From
3 Mb on, extraction takes most of the time (28 of 44 s at 3 Mb, 178 of 217 s at
10 Mb), at about 6 to 7 sequential requests a second.

The sampled route breaks at 10 Mb on memory, not on the network. Extraction
and identification finished, then `toGFA()` overran V8's maximum string
length: 464 walks each written as a W line over the window, where the 3 Mb GFA
was already 375 MB. The keep1 route finishes 10 Mb in 173 s with a 30 MB GFA.
Whole chr6 times out inside extraction on both routes after about 4,200
requests and 280 MB, the counts taken from the last 15-second heartbeat;
scaling the 10 Mb read linearly, the chromosome would take about 18,000
requests. Under the plugin's defaults a window stops sooner: the 100,000-node
`limit` counts every node walked, more than the nodes kept, so both 3 Mb
windows would raise `NodeLimitError`.

### Against PIF and Zarr

| format and view | requests | bytes | source |
| --- | ---: | ---: | --- |
| PIF coarse tier, whole-genome hs1 vs mm39 pass | 6 | 1.31 MB | jbrowse-components `agent-docs/measurements/pif-tier-wire-bytes.json` |
| PIF fine tier, same pass | 22 | 64.23 MB | same |
| Zarr, 2,504-sample CNV, chr17 190 kb | 3 | 0.22 MB | jb2bench `ecosystem/zarr.json` |
| 2,504 BigWigs, same window | 15,048 | 48.39 MB | same |
| gbz-base sampled, 300 bp to 100 kb, cold | 20-25 | 3.8-4.3 MB | this run |
| gbz-base keep, 300 bp to 100 kb, cold | 37-43 | 5.3-5.9 MB | this run |
| gbz-base sampled, window only | 12-17 | 0.8-1.3 MB | this run |

jb2bench reports PIF in bytes only; the PIF request counts come from the
jbrowse-components measurement its `docs/benchmarks.md` cites, counted by a
local server. jb2bench transcribes its Zarr figures from jbrowse-components'
`measure_signal_latency.ts`. The views answer different questions on different
data.

### Caveats

- Milliseconds include internet latency to S3 us-west-2 and jbrowse.org, with
  14 queries running at once (3 for large windows). Request and byte counts do
  not depend on either.
- `query.ts` imports `src/` instead of running `gbz-base-query`, since the CLI
  prints no phase times on the sampled route and makes neither the plugin's
  `db.paths()` call nor `toGFA()`.
- Prefetch off is emulated (see Settings); the library has no switch.
- The two 3 Mb sampled windows returned identical request and byte counts with
  different node counts and GFA sizes.
- `results.jsonl` also holds prefetch-off rows for the 300 bp segdup and
  unplaced windows, from an interrupted first pass; the tables leave them out.
