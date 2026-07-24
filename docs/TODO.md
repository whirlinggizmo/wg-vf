# wg-vf — Status & Remaining

See [Architecture Part I](./architecture-part1.md) (contract), [Part II](./architecture-part2.md)
(host scaffolding), and the [Conformance Test Plan](./conformance-test-plan.md)
for the design; this file tracks state.

## Status

The v2 framework is **done and verified**: envelope, fixed-step engine, the
vignette ABI across **TS, WASM, and native**, the host core (provision/join/
leave, reconnect, lifetime), manifest resolution, the reusable conformance
battery, and the determinism suite — with live examples (simple worker/remote,
three.js) over TS, WASM, native, WebSocket, and Worker.

**146 tests green; both projects typecheck; the package is git-installable. No
known correctness gaps.**

## Done (v2 migration — for history)

- **Envelope v2** (`src/envelope/`): 12-byte header, System/App/Frame channels,
  strict decode, binary system payloads, modular `frameSeq`.
- **`FixedStepEngine`** with the debt→drop-time overload change.
- **Vignette ABI**: TS binding (`Vignette`/`BaseVignette`) and the portable **C
  glue** (`src/vignettes/wasm/wg_vf.{h,c}`) — one C source → wasm (emcc) + native
  `.so` (clang). Nim is an interop example only (`examples/three`).
- **Host core** (`src/hosts/`): `VignetteHost` (manifest-driven), `HostLoop`,
  `PeerRegistry`, `SessionManager`, containment (peer-fault vs sim-fatal),
  reconnect + empty-session lifetime.
- **Manifest resolution** (`Manifest.ts` + `loadVignetteModule.ts`): the host
  resolves the peer-named vignette and loads its js/wasm module.
- **Conformance battery** (`hostConformanceCases` / `src/testing/conformance.ts`):
  ENV/ABI/SES cases; parametrized by a host factory. Op discipline is explicit —
  ABI-01 (init-first), ABI-02 (no ops after shutdown), ABI-03 (non-reentrant),
  ABI-04/05, SES-22; PAR-03 alloc-failure has a mock test; PAR-04 is host-side
  (ENV-25). Only the ENV-09 nightly-CI gate remains.
- **Determinism** (DET-01..05): cross-binding (TS vs WASM/native), overload,
  transport invariance, frame-loss tolerance; T-SCRIPT, T-LOSSY, T-GOLD.
- **Transports**: the host seam is `EnvelopePeer` (byte framing via
  `byteEnvelopePeer`, so it can run off the sim thread). Worker path carries
  structured envelopes over `postMessage` (`messagePortEnvelopePeer` +
  `runWorkerHost`, no framing); WebSocket + `ReconnectingWebSocketTransport`;
  the reference server decodes/encodes on the socket thread and runs the sim in a
  worker. See docs/transport-perf.md. Session-keyed reference server
  (`examples/remote-server.ts`).
- **Vignette storage** (`src/storage/`, [FS ABI](./vignette-fs-abi.md)): host-owned,
  jailed filesystem (`VignetteFs` — sync read/write/delete/exists/mkdir/list + async
  `flush` barrier) with `restore` before init and vignette-driven/graceful-shutdown
  flush. Delivered via `Vignette.attachServices`. TS + **wasm** at parity
  (`wg_vf_fs_*` imports); native follows the same ABI with the native host.
  Durable backends: `memoryDurableStore` (tests), `indexedDbDurableStore`
  (browser/worker), `fileDurableStore` (server disk, wired into the reference
  server via `VF_DATA_DIR`).
- **Session resume**: client-side `ResumeCoordinator` + `TokenStore`
  (`webStorageTokenStore`/`memoryTokenStore`) reopens with a resume-`Join` so a
  `clientId` survives a transport drop or page reload; host round-trip covered by
  SES-20 (resume in grace) / SES-21 (post-expiry fallback), demonstrated e2e over
  a real socket via `remote-app.ts` (`VF_SESSION_FILE`).
- **Packaging**: ESM, git-installable, ships `dist` + the C ABI assets under
  `native/`; Docker toolchain (`Dockerfile` + `docker-compose.yml`).
- **Versioning**: four surfaces — `ENVELOPE_VERSION` (wire), `WG_VF_ABI_VERSION`
  (host↔native/wasm ABI, checked on load), manifest `version` (vignette), and
  `VERSION` (package). See `AGENTS.md` + the author guide §11.

## Remaining (none blocking)

- **Dev mode** (`allowClientModuleUrls`, Part I §3.7) — optional. The module form
  already covers real loading; this is the *client-supplied* URL escape hatch (a
  dev convenience + security hole). Likely never wanted in prod.
- **WS conformance driving** — run the deterministic battery through a real
  socket adapter (needs a pump/clock control channel + a data/control ordering
  barrier). High effort, low marginal value — the host is already proven
  in-process and the socket adds only a thin byte adapter. Defer until a real
  consumer needs the remote path regression-tested. *(Server hardening — socket
  size cap, backpressure, `maxSessions` room cap, graceful shutdown — is done:
  `SessionManager.maxSessions` + `examples/remote-server.ts`, covered by SM-05.)*
- **Perf pass** — [transport-perf.md](./transport-perf.md) maps the copies.
  *Done:* the `SendOptions.transferable` ownership hint (worker transfers frames
  zero-copy, loopback skips its defensive copy, DET-guarded); the `EnvelopePeer`
  seam so byte framing runs off the sim thread; the reference server isolates the
  sim in a worker with decode/encode on the socket thread; and the **worker path
  carries structured envelopes** — no framing at all on the local path.
  *Deferred (benchmark-gated):* buffer pooling / return-swap and SharedArrayBuffer
  for the (unavoidable) wasm-staging copy.
- **Native FS binding** — the [FS ABI](./vignette-fs-abi.md) `wg_vf_fs_*` imports
  for native vignettes (TS + wasm are done and parity-tested). Lands with the
  native host, which supplies the symbols (can back them with `wgutils-c/fileio`).
- **`fetch`-to-file capability** — a `VignetteServices.fetch(url → path)` so any
  binding can pull assets and read them later. Model it as fetch-to-file + poll to
  stay JSPI-free; the host owns the network IO.
- **Native C host** — designed in [native-host-design.md](./native-host-design.md);
  build when a no-JS-runtime need is concrete.
- **Phase 8 dogfood** — Rest Easy as conformance consumer #4 (downstream; further
  framework work should be driven by a real Rest Easy need).
