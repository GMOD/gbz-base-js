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
