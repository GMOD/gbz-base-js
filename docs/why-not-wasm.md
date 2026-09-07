# Why not compile gbz-base to WebAssembly

The obvious way to read a `.gbz.db` from JavaScript is not to write a reader at
all: upstream [gbz-base](https://github.com/jltsiren/gbz-base) is Rust, Rust
compiles to wasm, so build it for `wasm32-unknown-unknown` and drive it from a
worker. That was tried first. It does not work, for reasons that are in the file
format rather than in the build.

## `usize` is in the serialized format

gbz-base reads GBZ through [gbwt-rs](https://github.com/jltsiren/gbwt-rs), which
sits on [simple-sds](https://github.com/jltsiren/simple-sds). Both write header
and payload fields as `usize`. On the 64-bit hosts every one of these files was
written on, `usize` is 8 bytes; on `wasm32` it is 4. So a wasm build reads the
first header field out of half the bytes it occupies, and every field after it
comes from the wrong offset — which surfaces as a spurious "SDSL format is not
supported", not as a length mismatch you could catch.

[jltsiren/gbwt-rs#14](https://github.com/jltsiren/gbwt-rs/pull/14) proposed the
narrow fix: give the header `Payload` structs explicit `u64` fields so they
serialize the same width everywhere. The maintainer's response was that every
use of `usize` in the crate is a potential bug of the same kind, and that a
32-bit gbz-base handling human-scale graphs would need more than type changes to
be believable. The PR was closed unmerged in May 2026, and the answer is a fair
one: patching the structs one PR encountered would have left a build that reads
the files in the fixtures and misreads the next field someone adds.

The 4 GB address space of `wasm32` is the same objection from the other side.
Nothing here holds a whole graph in memory, but a port whose offsets are all
32-bit has no headroom for the ones that would, and the HPRC v2.1 databases are
5-10 GB on disk.

## wasm64 fixes the width, and then hits SQLite

`wasm64` (memory64) makes `usize` 8 bytes again, which removes the mismatch
outright — for gbwt-rs. It does not carry gbz-base: gbz-base stores its graph in
SQLite through bundled C, and there is no wasm64 libc to compile that C against.
So the target that fixes the serialization cannot build the half of the stack
that opens the database, and the target that builds the database half misreads
every file.

Substituting a wasm SQLite (sql.js, wa-sqlite) does not close the gap either. It
handles the SQL, but the GBWT node records inside the blobs are still decoded by
the Rust that has the `usize` problem, and it adds a second wasm runtime and a
virtual filesystem to feed byte ranges to.

## What a TypeScript reader gets instead

A reader written directly against the two formats has neither problem — it reads
8-byte fields because the format has 8-byte fields, and JS numbers cover the
values these files hold. Beyond dodging the blocker, it buys:

- **Range requests for free.** Queries go through `generic-filehandle2`, so a 10
  GB database on an HTTP server is read as the few hundred KB of pages the query
  touches. A wasm port would need a VFS shim doing the same thing anyway.
- **The host's file access.** It runs in a JBrowse RPC worker on the file access
  layer JBrowse already has, including auth and its own caches, rather than
  needing those threaded through a wasm boundary.
- **One ordinary npm package.** Source, types, one dependency, no wasm blob to
  ship or instantiate, and a stack trace that points into readable code when a
  database is malformed.
- **Upstream stays unmodified.** Databases are built by stock
  `gbz-base construct`, and the
  [oracle tests](internals.md#fidelity-to-upstream) hold the output to
  upstream's byte for byte, so tracking the format is a test failure rather than
  a fork.

The cost is that this is a reimplementation, and format changes have to be
followed by hand. The oracle tests exist to make that a loud failure.
