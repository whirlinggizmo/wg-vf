# AGENTS.md — wg-vf

Orientation for agents/contributors. Start with `docs/README.md` and the
[vignette author guide](./docs/vignette-author-guide.md).

## What this is

The **Vignette Framework**: run self-contained simulation modules (**vignettes**)
behind a host boundary, so an unchanged vignette behaves identically across
**TS, WASM, and native**, over **local (Worker)** or **remote (WebSocket)**
transports.

## Commands

- `bun test` — full suite (TS host, conformance battery, determinism, examples).
- `npm run check` — typecheck (`src`).
- `npm run build` — emit `dist` + copy the C ABI assets to `dist/native`.
- `npm run test:build` — build the C reference vignettes: wasm (emcc) + native
  `.so` (clang). Needs emscripten + clang.
- `npm run test:wasm` — build the above, then run the wasm/native suite.
- Docker (bundles clang/emscripten/nim/bun/node):
  `docker compose run --rm toolchain <cmd>`; `docker compose up server` runs the
  example host on `ws://localhost:8787`.

## Principles (don't violate)

- **The envelope is the protocol.** App and sim exchange `Envelope`s over the
  transport seam (`EnvelopePeer`); byte framing is a transport concern
  (`byteEnvelopePeer`), so it can run off the sim thread (or not at all — the
  worker path carries the envelope object over `postMessage`). The framework never
  interprets App/Frame payload contents.
- **Native core = C.** The glue (`src/vignettes/wasm/wg_vf.{h,c}`) and any future
  native host are C; a vignette may be *any* C-interop language (Nim is only an
  example — `examples/three`).
- **Clients name, hosts resolve.** A peer names a vignette id; the host resolves
  it against a `Manifest` and loads the module. No client-supplied module URLs
  (except the unbuilt dev-mode flag).
- **Determinism.** All sim state changes go in `fixedTick`, driven only by
  `stepUs`/`stepIndex`. The DET suite enforces byte-identical TS/WASM/native
  traces — never add wall-clock or RNG to the host loop.
- **No v1.** v1 (`VignetteBridge`, `LocalVignetteHost`, `RemoteVignetteHost`, …)
  is deleted; don't reintroduce those names.

## Layout

- `src/envelope/` — wire format (v2, 12-byte header).
- `src/hosts/` — `VignetteHost` (manifest-driven), `HostLoop`, `FixedStepEngine`,
  `PeerRegistry`, `SessionManager`, `Manifest`/`loadVignetteModule`, `workerHost`,
  `Clock`.
- `src/vignettes/` — `Vignette`/`BaseVignette` (TS ABI); `wasm/wg_vf.{h,c}`
  (C ABI glue); `WasmVignette.ts` (host loader).
- `src/transports/` — `BytePeer` (bytes) + `EnvelopePeer`/`byteEnvelopePeer` (the
  host seam); `messagePortBytePeer` / `messagePortEnvelopePeer` (worker),
  `WebSocketTransport`.
- `src/testing/` — the conformance battery (`hostConformanceCases`), reference
  vignettes, `VirtualClock`, loopback/lossy/coalescing pipes, `runScript`;
  exported at `@whirlinggizmo/wg-vf/testing`.
- `test/` — `unit/`, `wasm/` (C reference vignettes + parity/determinism),
  `examples/`.
- `examples/` — `simple` (Worker + WebSocket, JS vignette), `three` (Nim-interop
  wasm), `remote-server.ts`.
- `docs/` — contract (Part I/II), conformance plan, author guide, native-host
  design.

## Versioning (four independent surfaces)

| Constant | Seam | Enforcement (at sim **load**) |
|---|---|---|
| `ENVELOPE_VERSION` (2) | host ↔ app **wire** | decode rejects a mismatch → `Error(UnsupportedVersion)` |
| `WG_VF_ABI_VERSION` (1) | host ↔ sim **ABI** | wasm/native: `vf_abi_version()` checked in `createWasmInstance`; dynamically-imported JS: `abiVersion` checked in `loadVignetteModule` (`assertJsVignetteAbi`). In-process `create`-form JS is compile-time-checked instead. |
| manifest `version` | the **vignette** (app semver) | echoed in `Ready`; peers can verify |
| `VERSION` | the **package** (semver) | `src/version.ts` — keep in sync with `package.json` |

`WG_VF_ABI_VERSION` has one source of truth (`src/vignettes/abi.ts`); `wg_vf.h`
mirrors it as a `#define`. Bump **both** on any breaking `vf_*` signature or
outbox/frame layout change. Bump `ENVELOPE_VERSION` on breaking wire changes (and
update `test/fixtures/envelope-golden.json` + Part I §1 in the same PR).

## Gotchas

- **ESM-only** (`type: module`; `exports` expose only `import`). No CJS.
- **Git-installable** (`npm install whirlinggizmo/wg-vf`); `prepare` builds `dist`
  on install (needs Node, not the wasm toolchain).
- The Docker container runs as **root**; if it builds example artifacts (e.g.
  `examples/three` nim wasm) it leaves root-owned files under `out/`/`.nimcache` —
  `chown` them back before rebuilding on the host.
