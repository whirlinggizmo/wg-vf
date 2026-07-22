# @whirlinggizmo/wg-vf

The **Vignette Framework**: run self-contained simulation modules (**vignettes**)
behind a host boundary, so an unchanged vignette behaves **identically** wherever
and in whatever language it is hosted.

> A JS module in a worker, a WASM module in a worker or a server process, or a
> native library in a service — same vignette, same behavior.

- **One contract, many surfaces:** TypeScript, WASM, and native bindings, over
  local (Web Worker) or remote (WebSocket) transports.
- **Deterministic:** a fixed-step core with a portable ABI — the same vignette in
  TS or WASM produces byte-identical behavior (verified by the conformance suite).
- **Multi-peer sessions:** provisioning, join/leave, reconnect with grace, and
  host-owned lifetime — the framework, not any peer, owns the session.

## Install

```sh
npm install @whirlinggizmo/wg-vf
```

## Write a vignette (TypeScript)

```ts
import { BaseVignette } from "@whirlinggizmo/wg-vf";

export default class MyVignette extends BaseVignette {
  override fixedTick(stepUs: number, stepIndex: number): void {
    // deterministic sim step
  }
  override handleMessage(senderId: number, payload: Uint8Array): void {
    this.broadcast(payload); // App channel; senderId is host-stamped
  }
}
```

Full guide (contract, channels, determinism, non-JS bindings, testing):
**[docs/vignette-author-guide.md](./docs/vignette-author-guide.md)**.

## Host it

```ts
import { runWorkerHost, singleVignetteManifest } from "@whirlinggizmo/wg-vf";

// Inside a Web Worker: a stock host driven by a manifest. The host resolves the
// vignette the app names and loads the module itself — no bespoke glue.
runWorkerHost(self, singleVignetteManifest("my-sim", {
  version: "1.0.0", fixedStepUs: 16666, maxSubsteps: 4, maxPeers: 8,
  type: "js", module: new URL("./my-vignette.js", import.meta.url).href,
}));
```

The same host core runs behind a WebSocket for remote/multiplayer (see
`examples/`).

## Non-JS vignettes (WASM / native)

One source compiles to a worker `.wasm` and a server `.so`, both against the
shipped C ABI:

- **C header:** `@whirlinggizmo/wg-vf/native/wg_vf.h`
- **Nim glue:** `@whirlinggizmo/wg-vf/native/vignette.nim`

(Physically under `node_modules/@whirlinggizmo/wg-vf/dist/native/`.) See the
author guide's native section.

## Package entry points

| Import | What |
|---|---|
| `@whirlinggizmo/wg-vf` | vignettes, hosts, envelope, transports, manifest |
| `@whirlinggizmo/wg-vf/testing` | `VirtualClock`, `HostPeer`, loopback/lossy pipes, reference vignettes, `runHostConformance` |
| `@whirlinggizmo/wg-vf/native/*` | `wg_vf.h`, `vignette.nim` for WASM/native authoring |

## Docs

[docs/](./docs/README.md) — author guide, the normative contract (Architecture
Part I/II), and the conformance test plan.

## License

MIT
