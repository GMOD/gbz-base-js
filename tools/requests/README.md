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
  per-query results this README reports.

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

```sh
git worktree ... # any checkout with node_modules installed
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
`CONTEXT`, `SNARLS`, `LIMIT` and `BLOCK_SIZE` change the query settings.

RESULTS
