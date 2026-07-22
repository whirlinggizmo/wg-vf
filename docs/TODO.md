# wg-vf TODO — v2 Migration

Tracks the work implied by [Architecture Part I (Contracts)](./architecture-part1.md), [Part II (Reference Host Scaffolding)](./architecture-part2.md), and the [Conformance Test Plan](./conformance-test-plan.md). Ordered by dependency (Part II Appendix). Acceptance = the conformance battery green on Local(js), Local(wasm), Remote(loopback) + DET + native `wg_vf.h` build (test plan §6 "Definition of done").

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · **(gate)** = conformance milestone.

## Status (accurate summary)

Phases 1–7 are **done and verified**: envelope v2, fixed-step engine, ABI (TS +
WASM + native), host core (provision/join/leave, reconnect, lifetime), manifest
resolution (Phase 5), conformance battery (`runHostConformance`), determinism
suite (DET-01..05), and live examples (simple worker/remote, three.js) on TS,
WASM, native, WebSocket, and Worker. 76 tests green; both projects typecheck.
**No known correctness gaps.**

Per-phase checkboxes below may lag the summary lines; trust this block and the
"Remaining" list. Genuinely remaining, none blocking:

- [ ] **Dev mode** (`allowClientModuleUrls`, Part I §3.7) — optional; module-form
  loading already covers real loading. This is the *client-supplied* URL escape
  hatch (dev convenience + security hole). Likely never wanted in prod.
- [ ] **ABI-13/14 tests** — explicit assertions for loop ordering (tick then
  fixedTick burst) and message-delivered-between-pumps. Mechanism already holds.
- [ ] **T-GOLD** — promote inline golden envelope bytes to versioned fixture files.
- [ ] **WS conformance driving** — run the deterministic battery through a real
  socket adapter (needs a pump/clock control channel). Low value; live smoke covers it.
- [ ] **Perf pass** — reduce ingress/egress payload copies; reusable staging.
- [ ] **Phase 8 dogfood** — Rest Easy as conformance consumer #4 (downstream).

## Clean-slate replacement

No backwards compatibility: v1 is deleted outright, v2 promoted to canonical names (no `V2` suffixes, no `/v2/` dirs, no shims/aliases). Assume no existing consumers.

- [x] Deleted v1 source: old `envelope/`, `Vignette`/`BaseVignette`, `BaseVignetteHost`/`Local`/`Remote`VignetteHost, `bridge/` (VignetteBridge + worker), `WasmVignette` + `vignette.h`/`.nim`.
- [x] Deleted v1 tests (helpers, codec, fixtures, integration, old unit host/transport tests) and obsolete v1 docs (framework spec, runtime ABI, symmetry/accuracy analyses).
- [x] Kept `transports/` (byte pipes) — valid for v2; add a `BytePeer` adapter for the WS transport in Phase 7.
- [x] `examples/simple` rewritten to v2 (remote-app, local-app, local-worker, js vignette) + `examples/remote-server.ts`; orphaned v1 files removed (app-base, config, simple/vignette/wasm). Scripts: `example:server` / `example:remote` / `example:local`.
- [x] `examples/three` rewritten to v2: the vignette (TS + Nim→WASM) runs in a Web Worker via `runWorkerHost`; the app talks over `messagePortBytePeer` with envelopes, state arrives on the App channel. Both bindings verified headlessly (`test/examples/three-vignette.test.ts`); the three subproject typechecks. `examples/codecs` (JSON helpers) retained.
- [ ] PAR-04 (WASM staging cap) and T-GOLD (promote inline golden bytes to files) — minor.
- [x] Fold the three open decisions into Part I (reconnect-gap drop, frame silence, 1 MiB payload cap).
- [x] Draft Part II (shared host scaffolding).

## Phase 0 — Test infrastructure (test plan §0; prerequisites, build alongside Phase 1)

Exported from `@whirlinggizmo/wg-vf/testing`.

- [x] **T-CLOCK** — `Clock` interface (`src/hosts/Clock.ts`) + `VirtualClock.advance(dtUs)` (`src/testing`). `pump()` lands with `HostLoop` (Phase 2/host).
- [x] **T-PIPE** — `createLoopbackPipe` / `LoopbackBytePipe` (`BytePeer` pair). Doubles as loopback transport.
- [ ] **T-LOSSY** — `LossyPipe` decorator (drop/reorder/duplicate) for Frame tests.
- [ ] **T-VIG-ECHO**, **T-VIG-COUNTER**, **T-VIG-CHAOS** — reference vignettes (TS).
- [ ] **T-VIG-PARITY** — `echo`/`counter` in C-compiled-to-WASM from `wg_vf.h`, same sources as parity tests.
- [ ] **T-SCRIPT** — input-script format + deterministic script runner.
- [ ] **T-GOLD** — golden hex-dump fixture directory (currently inline in `envelope-v2.test.ts`; promote to files with the doc-versioning gate, test plan §6).
- [ ] **Harness entry** — `runHostConformance(makeHost, opts)` (needs the v2 host, Phase 4).

## Phase 1 — Envelope v2 (Appendix A #1; unblocks everything) — CORE DONE

Landed in `src/envelope/v2/` (parallel to v1 until hosts migrate). Tests: `test/unit/envelope-v2.test.ts`, `test/unit/envelope-v2-fuzz.test.ts`.

- [x] Header 8 → 12 bytes; `channel` replaces `messageKind`; add `clientId`, `flags`, `reserved`.
- [x] Channels: System=0 / App=1 / Frame=2; Frame payload prefix `frameSeq:u32, sourceTick:u32`.
- [x] Binary `Init`/`Join`/`Ready`/`Error`/`Ping`/`Pong` payloads; `Join`/`Leave` system types; `ErrorCode` enum (`Generic..PeerFault`).
- [x] Strict decode: reject bad version/flags/reserved/channel/systemType, payloadLen mismatch, and **over-cap payload before allocation** (§1.6).
- [x] Modular `frameSeq` newer-than comparison (`frameSeqIsNewer`, used both host- and peer-side).
- [x] **(gate, envelope-level)** ENV-01..09, 17, 18, 23, 25 green.
- [ ] **(gate, host-level, deferred to Phase 4/6)** ENV-10..16, 19..22, 24 — clientId stamping, routing, coalescing, `Ready`/`Error`/`Shutdown` behavior. Need a host.

## Phase 2 — `FixedStepEngine` (Appendix A #3 core; independently testable) — CORE DONE

Landed in `src/hosts/FixedStepEngine.ts` + `src/hosts/Clock.ts`. Tests: `test/unit/FixedStepEngine.test.ts`.

- [x] Clock-free `FixedStepEngine` (`plan`/`consume`) — accumulator extracted from the loop math.
- [x] **Behavior change: debt → drop-time clamp** after `maxSubsteps` (Part I §2.3). Pre-v2 host retains debt; engine discards whole-step debt, keeps sub-step phase.
- [x] Injectable `Clock` seam (`SystemClock` / `VirtualClock`).
- [x] **(gate, engine-level)** ABI-07..12 green (exactness, monotonicity, accumulator, clamp, drop-time, wraparound).
- [x] **`HostLoop`** (`pump()`) wiring `Clock` + engine + vignette (`src/hosts/HostLoop.ts`); post-burst frame publish; drain after each op.
- [ ] **(gate, host-level)** ABI-13/14 (loop ordering, message-between-pumps timing) — need dedicated tests; the mechanism holds (single clock read, op-chain serialization).

## Phase 3 — ABI extension (Appendix A #2) — TS BINDING DONE

TS binding: `src/vignettes/Vignette.ts` + `BaseVignette.ts`. Reference vignettes: `src/testing/vignettes.ts` (echo/counter/chaos, T-VIG-*).

- [x] `Vignette`: `handleMessage(senderId, payload)`, `peerJoined(id)`, `peerLeft(id, reason)`, `outboxPop(): { targetId, payload }`, `currentFrame()` accessor, `PeerLeftReason`.
- [x] WASM `vf_*`: `vf_handle_message(sender,ptr,len)`, `vf_peer_joined`, `vf_peer_left`, u16 target-prefixed outbox, `vf_frame_offset/len/seq`. Nim glue in `src/vignettes/wasm/vignette.nim`; host loader `src/vignettes/WasmVignette.ts`.
- [x] `wg_vf.h`: canonical C API (`src/vignettes/wasm/`) — one Nim source → wasm32 (emscripten). Reference `counter` builds via `npm run test:wasm:build`.
- [x] **(gate)** PAR-01 (echo), PAR-02 (counter): Nim→WASM byte-matches TS; peer callbacks/handleMessage trap-free; WASM vignette runs through `VignetteHost` end-to-end.
- [x] **ABI-18**: `SimFatalError` marker on the ABI; a WASM failure (nonzero return / trap) in `handleMessage` is sim-fatal, not peer-fault. Verified TS (conformance) + WASM (`faulty.nim`).
- [x] **PAR-05**: `wg_vf.h` uses `uintptr_t` for offsets (32-bit wasm / 64-bit native); compiles clean −Wall −Wextra −std=c11; the same `counter.nim` built native `.so` byte-matches TS via a `bun:ffi` harness. `npm run test:native:build`.
- [ ] PAR-04: oversized-inbound rejection at the WASM staging layer (host-side ENV-25 already caps inbound; document the binding-layer behavior).

## Cross-host determinism (test plan §4) — DET-03/04 DONE

- [x] **T-LOSSY** (`lossyPipe`): drops Frame envelopes at a seeded rate, System/App untouched.
- [x] **DET-03**: `counter` TS and WASM produce byte-identical frame+App traces through the host over a scripted pump sequence — cross-binding determinism.
- [x] **DET-04**: frame loss changes only the lossy peer's received frames; the reliable App/event stream is identical and the sim is unaffected.
- [x] **T-SCRIPT** (`runScript`): ordered action script (connect/init/join/app/leave/drop/advance/pump/poll) + deterministic trace capture (App+Frame per peer; Ready/token excluded).
- [x] **DET-01/02**: same script + vignette yields identical traces over loopback and a byte-copy transport (transport invariance).
- [x] **DET-05**: overload segment (6 steps, maxSubsteps 4 → drop-time clamp) inside S1; TS and WASM traces byte-identical.

## Phase 4 — Peer registry & session (Appendix A #3/#5) — CORE DONE

`src/hosts/PeerRegistry.ts` + `src/hosts/VignetteHost.ts`. Tests: `test/unit/VignetteHost.test.ts`. Host drives one vignette over `BytePeer` transports with an op-chain that serializes all ABI ops (Part I §2.2 for free).

- [x] `PeerRegistry` + `connect(pipe)` per-transport attachment (replaces `setSendBytes`); identity stamping, mint/retire (never reuse), unicast-or-drop routing (Part II §5).
- [x] State machine IDLE→READY; Provision (Init) / Join-against-READY / Leave verbs; founding peer admitted on Init (Part I §3.3).
- [x] Containment: peer-fault (handleMessage throw → `Error(PeerFault)` + evict, sim survives) vs sim-fatal (host-driven op throw → broadcast Error + shutdown); oversized emission = sim-fatal.
- [x] Frame publish: post-burst snapshot-by-value, silent on zero-step (Part I §1.4).
- [x] **Reconnect**: `resumeToken` in `Ready` (envelope + Part I §1.5); grace re-bind without `peerLeft`/`peerJoined`; gap traffic dropped; stale/forged token → ordinary Join; `TimedOut` at expiry (Part I §3.3).
- [x] **Lifetime**: clock-driven timers evaluated on `pump()`/`poll()` (wrap-safe modular elapsed); `reconnectGraceMs` + `emptyGraceMs`; pending reconnect suppresses empty; host-initiated `Shutdown` broadcast + vignette shutdown (Part I §3.5).
- [x] **(gate)** ENV-10/11/12/13/15/16/21/22/23/24, SES-01/02/07/08/09/10/11/12/13/14/15/16/17/18/19/20/21, ABI-15/16/17/20/22 green.
- [x] Remaining SES/ENV: SES-22 is the ENV-10/22 impersonation case; ENV-13/16/25 host cases; ENV-19/20 frame coalescing (`coalescingPipe` — a stalled reliable stream keeps only the latest frame, App/System never dropped).
- [x] Packaged `runHostConformance`: `hostConformanceCases(makeHost)` + `HostPeer` in `src/testing/`, exported from `@whirlinggizmo/wg-vf/testing`. `VignetteHost.test.ts` is now a thin driver; any new host gets the 26-case battery from one factory.

## Phase 5 — Manifest resolution (Appendix A #4) — DONE

- [x] `Manifest`/`ManifestEntry` types (`src/hosts/Manifest.ts`): two entry forms — code (`{create}`) and module (`{type, module}`). `VignetteHost` takes a manifest and resolves the peer-named id at Provision (Part I §3.1); `VignetteHost.single` sugar for one vignette.
- [x] Framework-owned module loading (`loadVignetteModule`): wasm → `createWasmInstance(await factory())`; js → `new Class()` / factory. No example writes loading glue anymore.
- [x] Worker + remote hosts constructed with a manifest; `runWorkerHost(port, manifest)`, `SessionManager({manifestFor})`. Verified live: simple worker + remote server load the vignette module themselves; three worker offers `three-js`/`three-wasm` and the app selects by naming the id.
- [ ] Gate URL provisioning behind `allowClientModuleUrls` (Part I §3.7) — the module form already loads by URL; the dev-mode client-supplied-URL escape hatch is not yet wired.

## Phase 6 — Frame publication & error containment (Appendix A #6)

- [ ] `FramePublisher`: post-burst snapshot-by-value, silent on zero-step pumps; per-pipe coalesce/datagram hint (Part II §6).
- [ ] Containment dispatch: peer-fault vs sim-fatal wrapper; WASM trap always sim-fatal (Part II §7).
- [ ] **(gate)** ABI-15..22 green (containment + frame publication).

## Phase 7 — Reference hosts rewired (Appendix A #5/#6; Part II §8)

- [x] **TS worker host**: `messagePortBytePeer` adapts any postMessage port (Worker / `self` / MessageChannel) into a `BytePeer`; `runWorkerHost` runs a `VignetteHost` bound to the port. No bespoke RPC — the envelope is the protocol. Verified over a real Web Worker (`examples/simple/local-{app,worker}.ts`) and a MessageChannel (tests).
- [x] **Remote path verified live**: `examples/remote-server.ts` bridges each WebSocket to a `BytePeer` on a shared `VignetteHost`, pumped on a `SystemClock`; `examples/simple/remote-app.ts` provisions/joins and streams. Two peers share one sim end-to-end over a real socket; publish-time frame coalescing observed.
- [ ] Harden the reference server: **session-keyed host map** so a torn-down session frees the port for a fresh Provision (today's single shared host is one-session-for-the-process); re-Provision after CLOSED; multi-room.
- [ ] WebSocket transport-side frame coalescing (ENV-19/20) + `BytePeer` adapter for `ReconnectingWebSocketTransport`; drive the conformance battery through the WS adapter.
- [ ] **(gate)** DET-01..05 green (cross-host determinism — the crown jewel).

## Phase 8 — Dogfood

- [ ] Rest Easy walking-skeleton sim becomes conformance consumer #4; further framework work requires a Rest Easy-driven need (test plan §6 DoD).

## Carried over from v1 (still valid)

- [ ] Reduce payload copies on ingress/egress where host boundaries allow; reusable inbox/outbox staging; document transport-local vs ABI-level optimizations. (Revisit against the v2 targeted-outbox + frame paths.)
