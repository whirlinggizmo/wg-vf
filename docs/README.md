# wg-vf documentation

The Vignette Framework runs self-contained **vignette** (simulation) modules
behind a host boundary, so an unchanged vignette behaves identically wherever and
in whatever language it is hosted.

## Start here

- **Writing a vignette?** → [Vignette Author Guide](./vignette-author-guide.md) —
  the contract, ABI, channels, determinism rules, and copy-paste examples (TS and
  C — for WASM/native). Self-contained; no framework internals required.

## The contract (normative)

- [Architecture Part I — Contracts](./architecture-part1.md): the wire envelope,
  the vignette ABI + host guarantees, and provisioning/session semantics.
- [Architecture Part II — Reference Host Scaffolding](./architecture-part2.md):
  how the reference hosts are built (non-normative).
- [Native Host — Design Note](./native-host-design.md): the shape of a future
  C native host (`dlopen` a vignette `.so` + socket transport). Design, not built.
- [Conformance Test Plan](./conformance-test-plan.md): the ENV/ABI/SES/DET/PAR
  test battery a host must pass.

## Project state

- [TODO](./TODO.md): current status and the (small) remaining work.

## The `wg_vf.h` C ABI

The single header the WASM and native bindings compile against lives at
[`src/vignettes/wasm/wg_vf.h`](../src/vignettes/wasm/wg_vf.h).
