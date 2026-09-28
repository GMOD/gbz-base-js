# Handoff, 2026-09-28 (2): the genome-wide keep sweep on 4.1.0

Follows `2026-09-28-keep-route-completeness.md`, which defines the omission
modes and the plan this measures. 4.1.0 ships the `keep-fixes` and `join-pieces`
branches from that handoff; the graphgenomeviewer session knows.

## Setup

The sweep ran on `ada` against local copies of the hosted files, so it read
nothing from S3 or jbrowse.org. Both copies match their hosted multipart ETags:
`hprc-v2.1-mc-grch38.gbz.db` (10.05 GB, `eaf5aa05…-1199`) and the anchored index
(7.87 GB, `2e1ca780…-939`, 131 kb anchors). Code: a clone of `v4.1.0` in
`~/keep-sweep/gbz-base-js`.

Windows follow the review's design (`~/keep-route-lab/review2/REPORT.md` section
4): 1,500 windows in seven strata, contexts (100, none) and (1000, contained),
and three keep sets per window: one haplotype, one sample, and the eight of the
hosted pilot. In the `noanchor` and `multivisit` strata the haplotype and sample
are those of the target path. That makes 9,000 queries, 34 minutes on 12
workers. The `keep = all` pass on the segdup windows has not run.

## Results

| stratum     | windows | wrong windows | queries | keep route | wrong | dropped pieces |
| ----------- | ------: | ------------: | ------: | ---------: | ----: | -------------: |
| random      |     600 |             0 |   3,600 |      3,278 |     0 |              0 |
| segdup      |     300 |             0 |   1,800 |      1,056 |     0 |              0 |
| chm13       |     100 |             0 |     600 |        579 |     0 |              0 |
| acrocentric |      50 |             0 |     300 |         63 |     0 |              0 |
| end         |      50 |             1 |     300 |        197 |     3 |             11 |
| multivisit  |     100 |             2 |     600 |        259 |     4 |              6 |
| noanchor    |     300 |            52 |   1,800 |      1,072 |   145 |            568 |

`unresolved` is 0 in every query, so the oracle held. Every fallback matched.
Wrong queries by keep set: one haplotype 60 of 3,000, one sample 76, the
eight 16. Medians on local disk, keep against sampled: 144 and 157 ms on the
random windows, 657 and 1,529 ms on the noanchor ones. The segdup fallbacks are
310 "two copies", 206 with no chosen path at the anchors or on the window, 54
with no anchor after the window, 33 far samples, and fragment and one-sided
rules.

Ten queries have a keep-only record, all beside an omission: with pieces of a
detour missing, `alignments()` joins the two ends the keep route did find into
one record, which the sampled route splits around the pieces between them. No
keep-only piece occurs.

Of the 585 dropped pieces:

- **Mode 3, 510.** The chosen haplotype's unplaced contig, such as the 53 kb
  `HG00140#1#JBHDVY010000085.1`, lies in the window with no anchor row and no
  sample there, while another contig of the same haplotype passes the anchors.
  The fragment rule in 4.1.0 matches only fragments of one contig, and these are
  separate contigs.
- **The other 75** lie in three places. At chr9:98,374 (subtelomere,
  context 100) every chosen haplotype drops a 220 bp pass through two
  non-reference nodes, about 96 kb along its contig from its anchor visit. In
  five windows around chr21:8.45 Mb (p-arm) chosen contigs pass the
  non-reference nodes of a repeat array several times each. Two lie in PAR1.

## An end section, at `after@2599637`

The one chr22 query the first handoff left undebugged (`idx-s32k-grch38.db`,
`keep = all`) drops `HG00126#1#JBHIKU010000055.1[232]` hap 927-4,070. That
contig's first 4 kb pass the window forward, then it jumps into an inverted
copy, which is where it visits the anchors (57,529 and 83,803). The interval
walk runs 32 kb past its stop, to offset 24,763, and the contig ends 24.7 kb
further on. No sample lands on the 3 kb pass. A path's end section, from its end
to its first anchor visit, is walked only as far as CHAIN_BOUND reaches.

## A stray-section table

Measured on the hosted index with `~/keep-sweep/targets/src/bin/sections.rs` (5
minutes, 20 threads): split every non-reference path at its visits to GRCh38
anchors, and list the GRCh38 nodes of each section that no keep walk reaches. A
walk reaches a node inside the reference span of its section's two visits, when
the visits are two or fewer multiples apart, and a node within 32 kb along the
path of a visit, when the node lies within one anchor spacing of that visit on
the reference. GRCh38 visits no node twice in the whole graph, so each node has
one position.

| section                                  |   reached | strays |
| ---------------------------------------- | --------: | -----: |
| interior                                 | 9,850,615 |  4,342 |
| path end                                 |    41,371 | 57,271 |
| between visits 3 or more multiples apart |       321 |  4,199 |
| between visits on two contigs            |        22 |     18 |
| path with no anchor visit                |     1,694 |  1,843 |

The strays cluster into 70,974 rows (reference path, extent, path, and the path
offsets of the run), about 3 MB; table A in the first handoff was 250-558 MB. A
query would read the rows overlapping its anchors ±32 kb and walk each chosen
path's run, or fall back when the run is long.

Tested against the sweep (`~/keep-route-lab/sweep/catch.py`), a row reaches 433
of the 585 dropped pieces: 299 on paths with no anchor visit, 132 in end
sections, 2 interior. The other 152 sit in the chr21 p-arm windows (137),
chr9:98,374 (11), PAR1 (2) and one more window (2). Every missed walk checked at
chr9 and chr21 passes non-reference nodes only, such as HG01975#1's five pieces
of 5-46 nodes that recur in four of its contigs, so it has no GRCh38 position to
place. Those need a locus for each non-reference node from the passes through
it, the multi-locus part of table A restricted to non-reference nodes, which is
unmeasured. Mode 1 is also outside the table: its far stretch lies in ordinary
sections at their own locus.

For table B alone: 1,958 paths under 262 kb visit no anchor on the hosted index.
914 share GRCh38 nodes; of the 1,044 that share none, following other walks
outward reaches GRCh38 from both ends for 637 (within 1 Mb, one contig), from
one end for 235, and from neither for 172 (median 13.7 kb walked, max 553 kb).

## Whole walks (section E)

The plugin's pair and graph routes already cut with `snarls: 'contained'`, which
holds the GSTM1 detour. Only `getAlignmentsForRange` split it, and 4.1.0 fixed
that. Whole walks matter only for a detour that leaves every contained snarl.

## Decisions pending

- An index table for omissions: the stray-section table plus loci for
  non-reference nodes, or tables A and B as first proposed; and a hosted
  rebuild.
- Whole walks for `keep`, now a narrower case.

## Where things are

- Ada: `~/keep-sweep` (`rows.json`, `runs/v4.1.0/`, `analysis-v4.1.0.txt`,
  `sections3-summary.txt`, `sections3.tsv` with the 70,974 rows), local copies
  in `~/hprc-gbz`. Scripts, with results mirrored, in `~/keep-route-lab/sweep`:
  `gen.py` (windows), `sweep.ts`, `run.sh NAME [unlimited-segdup]`,
  `analyze.py NAME`, `catch.py NAME TABLE`, `ids.ts` (one haplotype's walks in a
  window), and the Rust crate `targets/`.
- `~/keep-route-lab/debug-src` is a copy of `src/` with tracing for one path
  (`KEEP_DEBUG_PATH`), run by `debug-one.ts`.
- `ri/libparity-fixes.ts` and `review2/parity-fixes.ts` now import the primary
  checkout's `src/`; the `keep-fixes` worktree is gone.
