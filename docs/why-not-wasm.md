# Why not WebAssembly

Upstream gbz-base built for wasm misreads every file. gbwt-rs and simple-sds
serialize header fields as `usize`, which varies in size by platform, and wasm
is generally 32-bit. [gbwt-rs#14](https://github.com/jltsiren/gbwt-rs/pull/14)
proposed `u64` fields and closed unmerged.

A TypeScript reader reads the fields at their written width, makes range
requests through `generic-filehandle2`, and runs on JBrowse's file access layer.

A wasm kernel for the decoding loops would save at most 27 ms of a 400 ms query.
