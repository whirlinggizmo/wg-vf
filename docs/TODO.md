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

**110 tests green; both projects typecheck; the package is git-installable. No
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
- **Transports**: worker (`messagePortBytePeer` + `runWorkerHost`) and WebSocket
  (plus `ReconnectingWebSocketTransport`); session-keyed reference server
  (`examples/remote-server.ts`).
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
- **Perf pass** — reduce ingress/egress payload copies; reusable staging. Do the
  transport-local wins anytime (guarded by DET); defer ABI-level copy-elision
  until the contract is frozen and there's a benchmark.
- **Native C host** — designed in [native-host-design.md](./native-host-design.md);
  build when a no-JS-runtime need is concrete.
- **Phase 8 dogfood** — Rest Easy as conformance consumer #4 (downstream; further
  framework work should be driven by a real Rest Easy need).
