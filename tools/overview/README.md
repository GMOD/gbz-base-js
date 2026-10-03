# Overview rendering

Two renderers of the haplotype index's overview, to show what a browser can draw
of a large graph over a large region and what it costs. Both draw a track of
excursions per bin (grey) and of variant excursions (red), the share of
haplotypes in each class per bin, and one row per haplotype coloured by its
class: absent grey, reference-like blue, partial sand, variant red, deeper with
more variant marks. Under 300 kb they draw every haplotype's alignment from the
graph instead, on the same rows: forward blue, reverse green, insertions orange,
deletions white.

## PNG from Node

```sh
node tools/overview/render.ts <graph> <index> 'GRCh38#0#chr22' 0 0 chr22.png 1800
```

Graph and index are paths or URLs; an end at or below the start draws the whole
contig. The last argument is the width in pixels; the bins come from the
coarsest level whose bins fit one pixel. One JSON line reports the level, the
bins, the haplotypes, and the requests, bytes and milliseconds of opening the
files and of the whole run. Each run is a fresh process, so the counts are a
cold cache.

## Page in a browser

```sh
node_modules/.bin/vite build --config tools/overview/demo/vite.config.ts
node tools/requests/range-server.mjs <dir with the files and a demo -> dist-demo link> 8765
```

Then open `http://127.0.0.1:8765/demo/?graph=<url>&index=<url>` and choose a
path. The page keeps one session open, so the status line gives the requests and
bytes of the view just drawn beside the session's total; hovering a row names
the haplotype and its class in that bin. Zoom in, zoom out and the arrows move
by halves; a window under 300 kb switches to the alignments.

## chr22, HPRC v2.1, 464 haplotypes, cold cache over local HTTP

| view                      | drawn from                  | requests (graph + index) |  MB |    ms |
| ------------------------- | --------------------------- | -----------------------: | --: | ----: |
| whole chromosome, 50.8 Mb | 3,102 bins of 16 kb         |              14 (3 + 11) | 1.7 |   123 |
| 3 Mb                      | 734 bins of 4 kb            |              14 (3 + 11) | 1.0 |   257 |
| 100 kb                    | 463 alignments over 25 bins |              21 (8 + 13) | 1.8 | 1,737 |

The same 3 Mb window read through the graph alone cost 70 to 307 requests and 17
to 20 MB ([the request study](../requests/README.md)).

## Whole genome, HPRC v2.1, 464 haplotypes, 139.5 M nodes

The graph database hosted on S3 (10 GB) and a format 3 index of the whole graph
served from local disk (4.25 GB, GRCh38 anchors, no stray rows, a 243 MB
overview at 5 levels; built from the GBZ alone in 70 minutes on 14 threads).
Each line is a fresh process, so the cost includes opening both files and the
`Paths` table from S3: 10 requests, 2.9 MB and about 2.4 s of every line, paid
once per browser session.

| view                               | drawn from                    | requests (graph + index) |  MB |    ms |
| ---------------------------------- | ----------------------------- | -----------------------: | --: | ----: |
| whole chr1, 249 Mb                 | 3,799 bins of 65.5 kb         |              21 (6 + 15) | 4.8 | 2,393 |
| whole chr6, 171 Mb                 | 2,607 bins of 65.5 kb         |              20 (6 + 14) | 4.4 | 2,432 |
| whole chrX, 156 Mb                 | 2,381 bins of 65.5 kb         |              20 (6 + 14) | 4.3 | 2,411 |
| chr1 100-103 Mb, 3 Mb              | 733 bins of 4 kb              |              20 (6 + 14) | 4.0 | 2,546 |
| chr6 31.5-32.5 Mb (MHC), 1 Mb      | 245 bins of 4 kb              |              20 (6 + 14) | 3.8 | 2,553 |
| chr1 103.7-103.8 Mb (AMY1), 100 kb | 1,463 alignments over 25 bins |             53 (29 + 24) | 6.9 | 8,089 |

In the page, which keeps the session open, whole chr1 is 11 requests, 1.6 MB and
161 ms of fetching; the 1 Mb MHC window 12 requests, 0.8 MB and 149 ms.

## Whole genome from local disk, production index

The same views from the production format 3 index (5.1 GB, both reference
samples, stray rows, 467 MB overview) with the graph database on the same disk,
on a 24-core machine, each a fresh process:

| view                               | requests (graph + index) |  MB |    ms |
| ---------------------------------- | -----------------------: | --: | ----: |
| whole GRCh38 chr1, 249 Mb          |              21 (6 + 15) | 4.8 |    97 |
| whole GRCh38 chr6, 171 Mb          |              20 (6 + 14) | 4.5 |    90 |
| whole CHM13 chr1 fragment, 122 Mb  |              20 (6 + 14) | 4.3 |    87 |
| chr1 100-103 Mb, 3 Mb              |              20 (6 + 14) | 4.0 |    84 |
| chr6 31.5-32.5 Mb (MHC), 1 Mb      |              19 (6 + 13) | 3.7 |    82 |
| chr1 103.7-103.8 Mb (AMY1), 100 kb |             53 (29 + 24) | 7.0 | 1,496 |

A 10 kb window that keeps HG002 reads 13 index requests and 0.85 MB on the keep
route; a 1 Mb one keeping HG002 returns its 10 pieces from 2 index scans.
