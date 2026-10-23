# jaldi

*jaldi* (जल्दी, "quickly") lowers a framework's frontend behind a typed
contract: it type-checks TypeScript with the TypeScript 7 checker in
process (tsrs, the Rust port), erases it to JavaScript (oxc), and lowers
and minifies CSS (lightningcss), handing the sheet's rules back as data.
It is built once and downloaded as a binary, so the framework that uses it
never compiles those engines in its own build.

It is this framework's tool, not a general one. What keeps the framework's
semantics out of it is the contract, not a generality rule: the framework
mints every name and generates the manifest from its own registry on every
run; jaldi mints nothing and has no configuration and no plugins.

## The contract

`contract/` is `jaldi-contract`, the one crate both sides compile against.
It holds the manifest in (`Manifest`: entries by kind, each with the Rust
declaration it came from), the answer out
(`Answer`: outputs with content hashes, a sheet's rules as data, and
diagnostics that point at the declaration), and the version (`CONTRACT`,
one integer).

A manifest from another contract is refused, naming both versions, before
anything else is read. An answer's first two fields are `kind` and
`contract` at every version, so a refusal is readable by any framework.

Changing the contract is deliberately slower than regular development:
bump `CONTRACT`, release the tool, bump the framework's pin. Developing
against it is not: the framework points `jaldi-contract` at a checkout with
a `[patch]` and the binary at a local build with an environment variable.

## What it writes

Into the manifest's `out_dir`, named by each entry's id (one path
segment): `{id}.js` for an enhancement, a module or a bundle, `{id}.css` for a
sheet, the same with `.map` when source maps are asked for, and
`{id}.json` holding the entry's `Produced` record with the input's hash.
A declarations entry writes nothing. The framework commits all of it
beside the sources and reads nothing else.

## The kinds

- **enhancement**: a TypeScript module checked against its generated
  header, its default export pinned to the header's `Mount`, then erased.
- **module** (contract 3): a TypeScript module of a program the framework
  owns outright, with no header, importing its siblings. Every module,
  enhancement and declaration file of a manifest is checked as one
  program under one regime (strict, erasable syntax only), then each
  module is erased one-to-one with its imports as written. Since every
  output is `{id}.js` in one directory, a relative import names another
  module as `./{id}.js` and a bare specifier must be declared by a
  declarations entry; anything else, a path outside `root` included, is a
  diagnostic at the import. The modules are produced together or not at
  all.
- **declarations** (contract 3): a `.d.ts` of `declare module "…"` blocks
  typing a module served as built (a vendored bundle) that a module
  imports by a bare specifier. Checked, never written.
- **bundle** (contract 4): one script linked from an entry the framework
  generates (inline, from its registries) over the modules it may reach,
  each listed with its id and source. The entry and the modules are
  checked with the rest of the manifest under the module rules (the
  entry names a module by id, `./{id}.js`), erased, linked with ESM's
  evaluation order and live bindings, and minified as one module: a
  module the entry does not reach is left out, and a top-level binding
  nothing reads is dropped, while every statement that may have an
  effect stays. Bare specifiers stay imports. `export *` and a literal
  `import()` of a bundled module are refused with a diagnostic. The
  record says which modules went in and which bare specifiers the output
  still imports; the source map, when asked, points into the
  TypeScript sources.
- **sheet**: a stylesheet, lowered and minified, its rules back as data.

## Use

```text
jaldi version              the tool's and the contract's versions
jaldi lower <manifest>     read a manifest (a path, or `-` for stdin),
                           write the outputs and the answer
```

Exit status: `0` produced with no errors, `1` produced with error
diagnostics, `2` refused, `3` the manifest or an output could not be read
or written.

## Release

A tag `v*` builds `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`
binaries and attaches them, with a `SHA256SUMS`, to a GitHub release. The
toolchain is pinned (`rust-toolchain.toml`) to the one tsrs builds on;
tsrs is a git dependency pinned by revision, since its crates are not
published.
