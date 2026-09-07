# Snarls

A `.gbz.db` built by upstream `gbz-base construct` stores the top-level chains
of the snarl decomposition as `next` links on the boundary node records (the
`chains` and `chain_links` tags say how many). The query functions take a
`snarls` option that uses them the way upstream's `--snarls` and
`--extend-snarls` do:

- `contained` adds every top-level snarl whose two boundary nodes are both in
  the subgraph. With `context: 0` an interval query returns only the reference
  walk, and this is what brings the variation back without a bp radius.
- `overlapping` also follows a boundary node whose partner lies outside the
  subgraph, and, when the subgraph holds no chain link at all, walks out to the
  snarl containing it. The subgraph must be connected, so a node query may give
  only one node. A snarl can be far larger than the window (a large deletion, a
  centromere), so set `limit` when using this mode.

`subgraphBetween(db, start, end)` is upstream's `--between`: everything between
two oriented boundary handles of one chain, with no context. On the command line
these are `--snarls`, `--extend-snarls` and `--between 129+:160+`.
