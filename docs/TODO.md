# wg-vf TODO — v2 Migration

Tracks the work implied by [Architecture Part I (Contracts)](./architecture-part1.md), [Part II (Reference Host Scaffolding)](./architecture-part2.md), and the [Conformance Test Plan](./conformance-test-plan.md). Ordered by dependency (Part II Appendix). Acceptance = the conformance battery green on Local(js), Local(wasm), Remote(loopback) + DET + native `wg_vf.h` build (test plan §6 "Definition of done").

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · **(gate)** = conformance milestone.

## Clean-slate replacement

No backwards compatibility: v1 is deleted outright, v2 promoted to canonical names (no `V2` suffixes, no `/v2/` dirs, no shims/aliases). Assume no existing consumers.

- [x] Deleted v1 source: old `envelope/`, `Vignette`/`BaseVignette`, `BaseVignetteHost`/`Local`/`Remote`VignetteHost, `bridge/` (VignetteBridge + worker), `WasmVignette` + `vignette.h`/`.nim`.
- [x] Deleted v1 tests (helpers, codec, fixtures, integration, old unit host/transport tests) and obsolete v1 docs (framework spec, runtime ABI, symmetry/accuracy analyses).
- [x] Kept `transports/` (byte pipes) — valid for v2; add a `BytePeer` adapter for the WS transport in Phase 7.
- [ ] **`examples/` are stale** (consumed the deleted bridge/host API). Not in build/test gates. Rewrite against the v2 host in Phase 7/8 or delete.
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
- [ ] WASM `vf_*`: `vf_handle_message(sender,ptr,len)`, `vf_peer_joined`, `vf_peer_left`, u16 target-prefixed outbox, `vf_frame_offset/len/seq`.
- [ ] `wg_vf.h`: same symbol set as a plain C API (one source → wasm32 + native).
- [ ] **(gate)** PAR-01..05 green (TS↔WASM binding parity; native build compiles clean & passes vectors).

## Phase 4 — Peer registry & session (Appendix A #3/#5) — CORE DONE

`src/hosts/PeerRegistry.ts` + `src/hosts/VignetteHost.ts`. Tests: `test/unit/VignetteHost.test.ts`. Host drives one vignette over `BytePeer` transports with an op-chain that serializes all ABI ops (Part I §2.2 for free).

- [x] `PeerRegistry` + `connect(pipe)` per-transport attachment (replaces `setSendBytes`); identity stamping, mint/retire (never reuse), unicast-or-drop routing (Part II §5).
- [x] State machine IDLE→READY; Provision (Init) / Join-against-READY / Leave verbs; founding peer admitted on Init (Part I §3.3).
- [x] Containment: peer-fault (handleMessage throw → `Error(PeerFault)` + evict, sim survives) vs sim-fatal (host-driven op throw → broadcast Error + shutdown); oversized emission = sim-fatal.
- [x] Frame publish: post-burst snapshot-by-value, silent on zero-step (Part I §1.4).
- [x] **Reconnect**: `resumeToken` in `Ready` (envelope + Part I §1.5); grace re-bind without `peerLeft`/`peerJoined`; gap traffic dropped; stale/forged token → ordinary Join; `TimedOut` at expiry (Part I §3.3).
- [x] **Lifetime**: clock-driven timers evaluated on `pump()`/`poll()` (wrap-safe modular elapsed); `reconnectGraceMs` + `emptyGraceMs`; pending reconnect suppresses empty; host-initiated `Shutdown` broadcast + vignette shutdown (Part I §3.5).
- [x] **(gate)** ENV-10/11/12/13/15/16/21/22/23/24, SES-01/02/07/08/09/10/11/12/13/14/15/16/17/18/19/20/21, ABI-15/16/17/20/22 green.
- [ ] Remaining SES/ENV: SES-22 (end-to-end impersonation — ENV-10 covers the mechanism), ENV-19/20 (frame coalescing — transport-side, Phase 7).
- [x] Packaged `runHostConformance`: `hostConformanceCases(makeHost)` + `HostPeer` in `src/testing/`, exported from `@whirlinggizmo/wg-vf/testing`. `VignetteHost.test.ts` is now a thin driver; any new host gets the 26-case battery from one factory.

## Phase 5 — Manifest resolution (Appendix A #4)

- [ ] `Manifest` type + loader/validator (fail-fast at construction); pure `resolveVignette()` (Part II §4).
- [ ] Reimplement `resolveInitPayload` as manifest resolution; `vignetteFactory` becomes an in-memory manifest entry.
- [ ] Gate URL provisioning behind `allowClientModuleUrls` (Part I §3.7).
- [ ] Hosts (Local + Remote) constructed with a manifest; LocalVignetteHost consumes the same format (SES-06).

## Phase 6 — Frame publication & error containment (Appendix A #6)

- [ ] `FramePublisher`: post-burst snapshot-by-value, silent on zero-step pumps; per-pipe coalesce/datagram hint (Part II §6).
- [ ] Containment dispatch: peer-fault vs sim-fatal wrapper; WASM trap always sim-fatal (Part II §7).
- [ ] **(gate)** ABI-15..22 green (containment + frame publication).

## Phase 7 — Reference hosts rewired (Appendix A #5/#6; Part II §8)

- [ ] TS worker host: worker RPC + loopback `BytePeer`; keep worker(session)/host(lifecycle) boundary.
- [x] **Remote path verified live**: `examples/remote-server.ts` bridges each WebSocket to a `BytePeer` on a shared `VignetteHost`, pumped on a `SystemClock`; `examples/simple/remote-app.ts` provisions/joins and streams. Two peers share one sim end-to-end over a real socket; publish-time frame coalescing observed.
- [ ] Harden the reference server: **session-keyed host map** so a torn-down session frees the port for a fresh Provision (today's single shared host is one-session-for-the-process); re-Provision after CLOSED; multi-room.
- [ ] WebSocket transport-side frame coalescing (ENV-19/20) + `BytePeer` adapter for `ReconnectingWebSocketTransport`; drive the conformance battery through the WS adapter.
- [ ] **(gate)** DET-01..05 green (cross-host determinism — the crown jewel).

## Phase 8 — Dogfood

- [ ] Rest Easy walking-skeleton sim becomes conformance consumer #4; further framework work requires a Rest Easy-driven need (test plan §6 DoD).

## Carried over from v1 (still valid)

- [ ] Reduce payload copies on ingress/egress where host boundaries allow; reusable inbox/outbox staging; document transport-local vs ABI-level optimizations. (Revisit against the v2 targeted-outbox + frame paths.)
