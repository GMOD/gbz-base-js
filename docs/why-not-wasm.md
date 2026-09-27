# Why not WebAssembly

The first attempt compiled upstream gbz-base's Rust to wasm. It misread every
file, because gbwt-rs and simple-sds serialize header fields as `usize`: 8 bytes
on the 64-bit machines that write these files, 4 bytes on `wasm32`. The symptom
is a spurious "SDSL format is not supported" error.

[gbwt-rs#14](https://github.com/jltsiren/gbwt-rs/pull/14) proposed `u64` header
fields and closed unmerged. `wasm64` fixes the width, but gbz-base also compiles
SQLite from C, and wasm64 has no libc to build it against.

A TypeScript reader reads 8-byte fields as 8 bytes, and it has other advantages:

- It makes range requests through `generic-filehandle2`, so a query on the 10 GB
  HPRC database fetches a few MB.
- It runs on JBrowse's file access layer, with its authentication and caching.
- It ships as one small npm package, with readable stack traces.
- The [oracle tests](internals.md#tests-against-upstream) fail on any difference
  from upstream's output.

## Hand-written kernels

bgzf-filehandle and bbi-js ship small wasm kernels for inflate. Here the two
candidates, `decodeSequence` and `GbwtRecord.decompressArrays`, take 27 ms of a
400 ms query, spread over 11,886 records, so a kernel could save at most 27 ms.
Switching the output format saved more: 295 ms of structured cloning became 1.9
ms ([api.md](api.md#json-or-compact)).
