# Why not WebAssembly

Upstream [gbz-base](https://github.com/jltsiren/gbz-base) is Rust, and Rust
compiles to wasm, so the first attempt at reading a `.gbz.db` from JavaScript
built upstream for `wasm32-unknown-unknown` and drove it from a worker. The
attempt failed because of how the file format stores its fields.

## `usize` in the serialized format

gbz-base reads GBZ through [gbwt-rs](https://github.com/jltsiren/gbwt-rs), which
builds on [simple-sds](https://github.com/jltsiren/simple-sds). Both write
header and payload fields as `usize`, which is 8 bytes on the 64-bit hosts that
wrote every one of these files and 4 bytes on `wasm32`. A wasm build therefore
reads the first header field from half its bytes and every later field from the
wrong offset. The symptom is a spurious "SDSL format is not supported" error,
not a length mismatch a caller could catch.

[jltsiren/gbwt-rs#14](https://github.com/jltsiren/gbwt-rs/pull/14) proposed a
narrow fix: explicit `u64` fields in the header `Payload` structs, so they
serialize at the same width everywhere. The maintainer replied that every use of
`usize` in the crate is a potential bug of the same kind, and that a 32-bit
gbz-base handling human-scale graphs would need more than type changes to be
trustworthy. The PR was closed unmerged in May 2026. The objection is fair:
patching the structs that one PR found would give a build that reads the test
fixtures and misreads the next field someone adds.

The 4 GB address space of `wasm32` raises the same concern from the other side.
This reader never holds a whole graph in memory, but a port whose offsets are
all 32-bit has no headroom for anything that would, and the HPRC v2.1 databases
are 5-10 GB on disk.

## wasm64 and SQLite

`wasm64` (memory64) makes `usize` 8 bytes again, which fixes gbwt-rs. It does
not fix gbz-base, which stores its graph in SQLite through bundled C, and there
is no wasm64 libc to compile that C against. A wasm64 build fixes the
serialization but cannot compile the part of the stack that opens the database;
a wasm32 build compiles that part but misreads every file.

Substituting a wasm SQLite such as sql.js or wa-sqlite handles the SQL, but the
Rust code with the `usize` problem still decodes the GBWT node records inside
the blobs. It would also add a second wasm runtime and a virtual filesystem to
feed it byte ranges.

## What a TypeScript reader gives

A reader written against the two formats reads 8-byte fields as 8 bytes, and
JavaScript numbers cover the values these files hold. It also gives:

- **Range requests with no extra code.** Queries go through
  `generic-filehandle2`, so the reader fetches only the few hundred KB of pages
  a query touches from a 10 GB database on an HTTP server. A wasm port would
  need a VFS shim to do the same.
- **The host's file access.** In a JBrowse RPC worker, the reader uses JBrowse's
  existing file access layer, including authentication and caching, with nothing
  passed through a wasm boundary.
- **One ordinary npm package.** Source, types and one dependency, with no wasm
  binary to ship or instantiate, and a stack trace that points into readable
  code when a database is malformed.
- **Unmodified upstream.** Stock `gbz-base construct` builds the databases, and
  the [oracle tests](internals.md#fidelity-to-upstream) hold the output to
  upstream's byte for byte.

The cost is a reimplementation: a change to the upstream format has to be
followed by hand, and the oracle tests fail when one is missed.

## Hand-written wasm kernels

Some GMOD packages, such as bgzf-filehandle and bbi-js, ship a small
hand-written wasm kernel for inflate. The benchmarks here rule that out, because
no routine is large enough to repay the call boundary. The two routines shaped
like a kernel, timed over the 200 kb chr20 window in
[performance.md](performance.md#where-a-windows-time-goes), are `decodeSequence`
at 6.9 ms for 408,976 bases and `GbwtRecord.decompressArrays` at 19.9 ms for
693,986 entries: 27 ms of a ~400 ms query, spread across 11,886 separate
records.

`weightedLcs`, the obvious candidate, never runs on that window: `--stats`
reports 177 ordered and 0 LCS alignments, because `orderedMatches` succeeds. On
the whole HPRC graph only AMY1 reaches the LCS
([optimizations.md](optimizations.md#ordered-matching-first)). The rest of the
time goes to Map lookups, small-object allocation, string building and
`JSON.stringify`, which is already native.

The output format mattered more. Structured-cloning the upstream format takes
295 ms against 1.9 ms for the compact one, a larger saving than any decoding
kernel could give, with no new runtime ([api.md](api.md#json-or-compact)).
