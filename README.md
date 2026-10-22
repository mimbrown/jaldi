# jaldi

*jaldi* (जल्दी, "quickly") lowers a framework's frontend: it type-checks
and erases TypeScript, lowers and minifies CSS, and will bundle, behind a
typed contract. It is built once and downloaded as a binary, so the
framework that uses it never compiles oxc, lightningcss or rolldown in its
own build.

It is this framework's tool, not a general one. What keeps the framework's
semantics out of it is the contract, not a generality rule: the framework
mints every name and generates the manifest from its own registry on every
run; jaldi mints nothing and has no configuration and no plugins.

## The contract

`contract/` is `jaldi-contract`, the one crate both sides compile against.
It holds the manifest in (`Manifest`: entries by kind, each with the Rust
declaration it came from), the answer out (`Answer`: outputs with content
hashes, sheet rules as data, diagnostics that point at the declaration),
and the version (`CONTRACT`).

A manifest from another contract is refused, naming both versions, before
anything else is read. The answer's first two fields are `contract` and
`kind` at every version, so a refusal is readable by any framework.

Changing the contract is deliberately slower than regular development:
bump `CONTRACT`, release the tool, bump the framework's pin. Developing
against it is not: the framework points `jaldi-contract` at a checkout with
a `[patch]` and the binary at a local build with an environment variable.

## Use

```text
jaldi version              the tool's and the contract's versions
jaldi lower <manifest>     read a manifest (a path, or `-` for stdin),
                           write the answer to stdout
```

Exit status: `0` produced with no errors, `1` produced with error
diagnostics, `2` refused, `3` the manifest or an output could not be read
or written.

## Release

A tag `v*` builds `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`
binaries and attaches them, with a `SHA256SUMS`, to a GitHub release.
