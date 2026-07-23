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

**90 tests green; both projects typecheck; the package is git-installable. No
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
  ENV/ABI/SES cases; parametrized by a host factory.
- **Determinism** (DET-01..05): cross-binding (TS vs WASM/native), overload,
  transport invariance, frame-loss tolerance; T-SCRIPT, T-LOSSY, T-GOLD.
- **Transports**: worker (`messagePortBytePeer` + `runWorkerHost`) and WebSocket;
  session-keyed reference server (`examples/remote-server.ts`).
- **Packaging**: ESM, git-installable, ships `dist` + the C ABI assets under
  `native/`; Docker toolchain (`Dockerfile` + `docker-compose.yml`).
- **Versioning**: four surfaces — `ENVELOPE_VERSION` (wire), `WG_VF_ABI_VERSION`
  (host↔native/wasm ABI, checked on load), manifest `version` (vignette), and
  `VERSION` (package). See `AGENTS.md` + the author guide §11.

## Remaining (none blocking)

- **Dev mode** (`allowClientModuleUrls`, Part I §3.7) — optional. The module form
  already covers real loading; this is the *client-supplied* URL escape hatch (a
  dev convenience + security hole). Likely never wanted in prod.
- **WS conformance driving + server hardening** — run the deterministic battery
  through a real socket adapter (needs a pump/clock control channel); multi-room
  session-keyed server work. Low priority; live smoke covers the path.
- **Perf pass** — reduce ingress/egress payload copies; reusable staging. Do the
  transport-local wins anytime (guarded by DET); defer ABI-level copy-elision
  until the contract is frozen and there's a benchmark.
- **PAR-04** — document oversized-inbound rejection at the WASM staging layer
  (the host already caps inbound via ENV-25).
- **Conformance coverage gaps (remaining)** — ABI-04/05, SES-22 now have explicit
  cases. Still implicit-only: ABI-01/02/03 (init-before-ops, no-ops-after-shutdown,
  reentrancy — held by the op-chain) and PAR-03 (WASM staging paths / alloc-failure).
- **Native C host** — designed in [native-host-design.md](./native-host-design.md);
  build when a no-JS-runtime need is concrete.
- **Phase 8 dogfood** — Rest Easy as conformance consumer #4 (downstream; further
  framework work should be driven by a real Rest Easy need).
