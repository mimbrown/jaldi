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
segment): `{id}.js` for an enhancement, `{id}.css` for a sheet, the same
with `.map` when source maps are asked for, and `{id}.json` holding the
entry's `Produced` record with the input's hash. The framework commits all
of it beside the sources and reads nothing else.

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
