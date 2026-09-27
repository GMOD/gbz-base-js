# Why not WebAssembly

gbz-base compiled to wasm can't read its own files. gbwt-rs stores some header
fields as `usize`, which varies in size by platform, and wasm is generally
32-bit. A TypeScript reader avoids the problem and makes HTTP range requests
through `generic-filehandle2`, like other JBrowse readers.
