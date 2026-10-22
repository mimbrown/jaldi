# Bundling probe (software-factory #754)

A branch, not a merge. The question: which engine bundles the runtime's
own flat ESM graph with tree-shaking: rolldown's crates, or a linker of
our own over oxc. Nothing here touches `contract/`.

## What is here

- `probe/linker`: the linker over oxc 0.155 (`lib.rs`, ~450 lines of
  logic). Resolve the graph from the entry (relative imports under the
  entry's directory; bare specifiers stay imports; `import()` untouched),
  order it as ESM evaluates it, give every top-level binding one name
  unique across the bundle and clear of every global any module reads,
  point each import binding at what it resolves to, rename a nested
  binding a rename would capture, strip `import`/`export`, concatenate,
  and hand the whole thing to oxc's minifier as one module.
- `probe/rolldown`: rolldown 1.2.15 from crates.io as a library (one ESM
  chunk, bare specifiers external).
- `cli`: features `probe-linker` / `probe-rolldown` add a hidden
  `jaldi probe-bundle <entry> <out.js>`, so the cold build of the tool
  itself measures what each engine adds. Off by default.
- `probe/bundle/corpus/fixture`: the correctness fixture. `node entry.js`
  prints `expected.txt`; each bundle must print the same. It covers name
  collisions across modules, `import { a as b }`, an anonymous default,
  a namespace import, a re-export, a cycle, a live `let` binding, an
  external dynamic import, side effects at evaluation, and unused
  exports and private functions that must disappear.
- `probe/bundle/corpus/runtime`: no stage 4 branch existed when this
  started, so `progressive.js` (software-factory `main`, 2026-10-22) is
  cut into nine modules along its own section comments by a throwaway
  splitter, plus the eleven patterns unchanged. Hand fixes: `live.js`
  gets setters for the two `let`s `navigation.js` assigns; the four
  calls `applyFills` made into windows, keys and tallies become an
  `afterFills` hook list each module registers on (otherwise `core`
  imports them and no app can leave them out); patterns are registered
  statically from a generated `app-patterns*.js` that the entry imports
  before `enhancements.js`. `entry.js` is an app using everything;
  `entry-small.js` has no scroll windows, tallies or state form, and
  three patterns.

## Results (x86_64-linux, 4 cores, 15 GB)

Correctness: both engines print the fixture's expected output, minified
and not, and every `UNUSED_MARKER` is gone from both. In headless
Chromium 1194 the original `progressive.js`, the unbundled modules and
both bundles leave the same event listeners on `window` and `document`
(type and count) and the same pattern errors, for both entries.

Size (bytes; the unbundled baseline is every module minified alone by
the same oxc minifier, as stage 4 would serve them):

| | raw | gzip -9 | brotli 11 |
|---|---:|---:|---:|
| today: `progressive.js` + 11 patterns, unminified | 187,864 | 62,722 | 53,993 |
| full app, 23 modules each minified | 72,359 | 29,476 | 25,584 |
| full app, linker bundle | 69,986 | 21,892 | 19,539 |
| full app, rolldown bundle | 70,506 | 21,937 | 19,582 |
| small app, 12 modules each minified | 41,281 | 16,367 | 14,280 |
| small app, linker bundle | 39,500 | 12,573 | 11,337 |
| small app, rolldown bundle | 39,814 | 12,606 | 11,373 |

Bundle time (release `jaldi probe-bundle`, ten runs, process start
~4 ms): linker 20–27 ms full, 12–17 ms small; rolldown 29–39 ms full,
19–28 ms small.

Cost to jaldi (one cold build each, fresh target, `--offline`):

| | crates | cold release (fat LTO) | cold dev | release binary |
|---|---:|---:|---:|---:|
| jaldi today | 211 | 333 s | 68 s | 24.5 MB |
| + linker | 215 (+4: oxc_minifier, oxc_mangler, lazy-regex ×2) | 344 s (+3%) | 73 s | 25.3 MB |
| + rolldown | 327 (+116) | 448 s (+34%) | 98 s | 33.0 MB |

Glue: the rolldown side is 64 lines against `rolldown`'s exported
`Bundler`/`BundlerOptions`, plus `rolldown_common::Output` (published,
but not re-exported by `rolldown`). Nothing private, but the Rust API is
undocumented and released weekly (1.2.8 to 1.2.15 in six weeks), and it
pins oxc, so jaldi's oxc bumps would wait on a matching rolldown
release. The linker uses only oxc's public parser, semantic, codegen,
minifier and mangler, which jaldi already pins.

What the linker does not do yet: source maps (each module's map from
codegen, concatenated, then composed with the minifier's map: rolldown
has this already), `export *`, a namespace import over a re-export, and
its refusals exit the process instead of answering diagnostics.

`probe/bundle/scripts`: `split.mjs` (the splitter, needs `acorn` and
`acorn-walk`), `smoke.mjs` (the Chromium check, needs `playwright-core`;
`ORIGINAL=<progressive.js>` adds the original shim, `ENTRY=entry-small`
picks the entry), `sizes.mjs` (raw, gzip, brotli of a set of files).
