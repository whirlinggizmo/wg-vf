# wg-vf Conformance Test Plan

**Status:** Draft 0.1 · **Companion to:** Architecture Part I (Contracts) Draft 0.1
**Convention:** Test IDs are `AREA-NN` and reference the contract clause they verify. Each ID is intended to become one test (or one tightly-scoped describe block). `MUST`-level assertions are release-blocking; `SHOULD`-level are flagged `[S]`.

---

## 0. Test Infrastructure (prerequisites, not tests)

These must exist before the suite can be written. They are exported from `@whirlinggizmo/wg-vf/testing`.

- **T-CLOCK** — Injectable clock. `BaseVignetteHost` takes a `nowUs()` provider; a `VirtualClock` supports `advance(dtUs)`. The host loop must be manually drivable (`pump()` runs exactly one loop iteration) so no test depends on timers or sleeps.
- **T-PIPE** — `LoopbackBytePipe`: an in-process `BytePeer` pair (`a.send` → `b.onBytes` synchronously or via microtask, configurable). Also the exported single-player transport.
- **T-LOSSY** — `LossyPipe` decorator: configurable drop/reorder/duplicate for Frame-channel testing.
- **T-VIG-ECHO** — Reference vignette `echo`: every `handleMessage(sender, bytes)` emits outbox `(target=sender, bytes)` and a broadcast copy prefixed with sender id.
- **T-VIG-COUNTER** — Reference vignette `counter`: increments a counter per `fixedTick`; publishes a frame each fixedTick containing `(stepIndex, counter, sum-of-received-dtUs)`; emits an outbox event every N steps; records `peerJoined`/`peerLeft` calls into readable state.
- **T-VIG-CHAOS** — Reference vignette `chaos`: command bytes trigger targeted misbehavior — throw in `handleMessage`, throw in `fixedTick`, emit oversized payload, emit to invalid target, busy-loop for X µs (overload induction).
- **T-VIG-PARITY** — `echo` and `counter` implemented twice: TS and C-compiled-to-WASM from `wg_vf.h`. Same sources drive parity tests (§5).
- **T-SCRIPT** — Input script format: ordered list of `(atLoopIteration, action)` where action ∈ {peer connect, Join, App bytes, transport drop, Leave, clock advance}. A script runner drives any host deterministically.
- **T-GOLD** — Golden fixture directory: hex-dump files for every system envelope and edge-case envelope, checked into the repo.

---

## 1. Envelope (contract §1)

### 1.1 Layout & golden bytes (§1.2)

| ID | Assertion |
|---|---|
| ENV-01 | Encoder produces byte-exact output for every golden fixture (all system types, App, Frame, zero-length payload, max-tested payload). |
| ENV-02 | Decoder round-trips every golden fixture to the expected structured form. |
| ENV-03 | Header fields land at specified offsets (0,1,2,3,4,6,8) little-endian; verified by hand-constructed buffers, not by the encoder. |
| ENV-04 | `version ≠ 2` → decode rejects; host responds `Error(UnsupportedVersion)` and does not deliver to vignette. |
| ENV-05 | Nonzero `flags` reserved bits or `reserved` byte → reject (strict v2 parsing). |
| ENV-06 | `channel ∉ {0,1,2}` → reject. |
| ENV-07 | `systemType ≠ 0` on App/Frame channel → reject. |
| ENV-08 | `payloadLen` disagreeing with actual byte length (short and long) → reject without over-read; verified with fenced buffers. |
| ENV-09 | Fuzz: 100k random/mutated buffers into the decoder → no throw escapes the defined error path, no hang, no over-read (run under a memory-checking harness for the WASM decode path). |

### 1.2 clientId semantics (§1.3)

| ID | Assertion |
|---|---|
| ENV-10 | Host stamps inbound `clientId` with the attached peer's id regardless of what the peer wrote (send forged nonzero and forged-zero ids; vignette observes the true sender). |
| ENV-11 | Outbound unicast (`target=k`) is delivered only to peer k (verified with 3 attached peers). |
| ENV-12 | Outbound broadcast (`target=0`) reaches every attached peer exactly once. |
| ENV-13 | Unicast to unattached/retired id is silently dropped — no error emitted, no delivery, sim unaffected. |
| ENV-14 | Host never mints id 0 or 0xFFFF. |

### 1.3 Channel semantics (§1.4)

| ID | Assertion |
|---|---|
| ENV-15 | App messages from one peer are delivered to the vignette in send order (script interleaves 100 messages from 3 peers; per-peer order preserved). |
| ENV-16 | Peer-bound App messages arrive at each peer in emission order. |
| ENV-17 | Frame payloads begin with framework-owned `frameSeq:u32, sourceTick:u32`; receiver discards non-newer `frameSeq` (inject stale and duplicate frames via LossyPipe). |
| ENV-18 | `frameSeq` comparison is modular: sequence 0xFFFFFFFE → 0x00000001 is accepted as newer across wrap. |
| ENV-19 | [S] WebSocket-style single-stream host coalesces frames: with a stalled pipe, buffered unsent frame is replaced, not queued (observe: peer receives latest frame only after unstall). |
| ENV-20 | System/App traffic is never dropped by frame coalescing (interleave frames with App messages under stall; all App messages arrive, in order). |

### 1.4 System messages (§1.5)

| ID | Assertion |
|---|---|
| ENV-21 | `Ready` payload contains resolved vignetteId, version, assigned clientId, and `fixedStepUs` matching the manifest entry. |
| ENV-22 | `Error` payload carries the specified `code:u16`; each defined code is produced by its triggering scenario (cross-referenced from SES tests). |
| ENV-23 | `Ping` → `Pong` echoes sequence and sentAtMs; bridge `ping()` computes rtt ≥ 0 under virtual clock. |
| ENV-24 | Peer-originated `Shutdown` behaves as Leave: that peer detaches, session survives, other peers uninterrupted (see SES-13). |

---

## 2. ABI & Host Guarantees (contract §2)

### 2.1 Call discipline (§2.2) — run against every host implementation via the harness

| ID | Assertion |
|---|---|
| ABI-01 | No vignette operation is invoked before `init` resolves (instrumented vignette with delayed-resolve init; assert no `tick`/`fixedTick`/`handleMessage` during the delay). |
| ABI-02 | No operation is invoked after `shutdown` begins (queue messages during shutdown; assert zero deliveries). |
| ABI-03 | Operations are strictly serialized: instrumented vignette asserts no reentrancy/overlap even when ops return pending promises. |
| ABI-04 | Outbox is drained after each of: `init`, `tick`, each `fixedTick`, `handleMessage`, `peerJoined`, `peerLeft` (vignette enqueues one marked message inside each op; host emits it before invoking the next op). |
| ABI-05 | `peerJoined(k)` precedes first `handleMessage(k,…)`; no `handleMessage(k,…)` after `peerLeft(k,…)` (script races a message against join/leave). |
| ABI-06 | `outboxPop` targeting: `(target, payload)` tuples route per ENV-11/12/13 from the vignette's perspective. |

### 2.2 Fixed-step contract (§2.3) — the determinism core; virtual clock throughout

| ID | Assertion |
|---|---|
| ABI-07 | `fixedTick` always receives exactly manifest `stepUs` (counter vignette records every stepUs argument; advance clock by awkward primes; assert all equal). |
| ABI-08 | `stepIndex` increments by exactly 1 per call, no gaps/repeats, across ≥ 1M steps (fast-forwarded). |
| ABI-09 | Accumulator: advancing by `k·stepUs + r` (r < stepUs) across varied splits yields exactly k fixedTicks; remainder carries. |
| ABI-10 | Substep clamp: advancing by `(maxSubsteps + 3)·stepUs` in one pump yields exactly `maxSubsteps` fixedTicks. |
| ABI-11 | **Drop-time policy:** after ABI-10's pump, accumulator < stepUs (next pump with dt=0 produces zero fixedTicks; next pump with dt=stepUs produces exactly one). Debt does not carry. |
| ABI-12 | Wraparound: with clock seeded near 2³² µs, dt computation, stepIndex, and frameId remain correct across the wrap; counter vignette's dt-sum matches advanced time. |
| ABI-13 | Loop ordering: within one pump — one `tick`, then the fixedTick burst; vignette records call sequence. |
| ABI-14 | Message timing: App messages are delivered between pumps, never between substeps of one pump (script delivers during a multi-substep pump; vignette asserts `handleMessage` never lands between two fixedTicks of the same burst, and its stepIndex-at-delivery is deterministic). |

### 2.3 Error containment (§2.4)

| ID | Assertion |
|---|---|
| ABI-15 | JS vignette throw in `handleMessage(k,…)` → `Error(PeerFault)` unicast to k; k detached; vignette receives `peerLeft(k, Fault)`; other peers receive nothing; sim continues ticking (counter still advances). |
| ABI-16 | JS vignette throw in `tick` / `fixedTick` / `peerJoined` / `peerLeft` → broadcast `Error`, vignette `shutdown` invoked, host reaches CLOSED. One test per op via chaos vignette. |
| ABI-17 | Throw in `init` → `Error` to provisioning peer; host does not reach READY; subsequent Join → `Error(NotProvisioned)`. |
| ABI-18 | WASM trap in `vf_handle_message` → **sim-fatal** (contrast with ABI-15): broadcast Error + shutdown. |
| ABI-19 | After any sim-fatal path, no further vignette op is invoked and no further outbox/frame bytes are emitted (memory-untrustworthy rule). |

### 2.4 Frame publication (§2.1/§1.4 host side)

| ID | Assertion |
|---|---|
| ABI-20 | Host snapshots the frame at a defined point (post-fixedTick-burst) and forwards with correct `frameSeq`/`sourceTick`; counter vignette's frame contents match its recorded state at that stepIndex. |
| ABI-21 | Vignette mutating its frame buffer after publication does not alter bytes already forwarded (host copies or the binding contract makes mutation impossible — whichever the binding specifies, test it). |

---

## 3. Provisioning & Session (contract §3)

### 3.1 Manifest & resolution (§3.1–3.2)

| ID | Assertion |
|---|---|
| SES-01 | Provision with known id resolves manifest entry; vignette instantiated from manifest `module`/`type`; `Ready` echoes id+version (ties to ENV-21). |
| SES-02 | Unknown id → `Error(UnknownVignette)`; host remains IDLE; a subsequent valid Provision succeeds. |
| SES-03 | Manifest `fixedStepUs`/`maxSubsteps` are the values the stepping contract honors (re-run ABI-07/10 with a nonstandard manifest entry, e.g. 20000µs/2). |
| SES-04 | With `allowClientModuleUrls: false` (default), v1-style URL provision payload → rejected (`Error(UnknownVignette)`); no module fetch is attempted (instrument the loader). |
| SES-05 | With `allowClientModuleUrls: true`, URL provision loads; all other contracts (identity, stepping, containment) hold identically — run a slice of the harness in this mode. |
| SES-06 | LocalVignetteHost consumes the same manifest format and passes SES-01..03 (provisioning symmetry). |

### 3.2 Verbs & state machine (§3.3)

| ID | Assertion |
|---|---|
| SES-07 | Provision valid only from IDLE: second Provision on READY host → error, session undisturbed. |
| SES-08 | Join on READY with matching id: minted clientId is unique, ≥1; `peerJoined` then unicast `Ready`; existing peers' traffic uninterrupted. |
| SES-09 | Join before Provision → `Error(NotProvisioned)`. |
| SES-10 | Join with mismatched id → `Error(UnknownVignette)`. |
| SES-11 | Join at `maxPeers` → `Error(SessionFull)`; a slot freed by Leave permits the next Join. |
| SES-12 | Leave → `peerLeft(id, Left)`; id retired; retired id never re-minted within the session (join/leave churn loop asserts strictly increasing ids). |
| SES-13 | Peer-originated Shutdown ≡ Leave (ENV-24 from the session side). |
| SES-14 | Reconnect: transport drop → no immediate `peerLeft`; re-Join with valid `resumeToken` inside `reconnectGraceMs` re-binds same clientId, zero `peerLeft`/`peerJoined` to the vignette; queued unicasts to that id during the gap follow the documented buffering policy (buffer-or-drop — pin it in the doc, then test it). |
| SES-15 | Reconnect after grace expiry: `peerLeft(id, TimedOut)` fired at expiry (virtual clock); stale token rejected; new Join gets fresh id. |
| SES-16 | Forged/other-peer's resumeToken → rejected, no re-bind (trust: token is bearer-proof per session). |

### 3.3 Lifetime (§3.5)

| ID | Assertion |
|---|---|
| SES-17 | Founding peer disconnect does not shut the session down: peer B continues, sim ticks on (the anti-pattern in today's example server, inverted). |
| SES-18 | Empty state (no peers, no pending reconnects) starts `emptyGraceMs`; a Join inside the window cancels teardown; expiry → broadcast `Shutdown` + vignette `shutdown`. |
| SES-19 | `emptyGraceMs: 0` → immediate teardown on last detach. |
| SES-20 | Pending reconnect suppresses empty-state (single peer drops: session not "empty" until reconnect grace expires; only then does empty grace begin). |

### 3.4 Trust (§3.6)

| ID | Assertion |
|---|---|
| SES-21 | Peer-originated Init on a READY session cannot re-provision (SES-07 with hostile framing: payload names a *different* vignette id — rejected, running sim unchanged). |
| SES-22 | Envelope-level impersonation attempts (ENV-10) shown end-to-end: echo vignette's reply routes to the true sender, not the forged id. |

---

## 4. Cross-Host Determinism (the crown jewel)

Same vignette + same T-SCRIPT ⇒ byte-identical observable behavior across hosts.

| ID | Assertion |
|---|---|
| DET-01 | `counter` (TS) under LocalVignetteHost, driven by script S1 (3 peers, join/leave churn, 10k steps, message bursts): record full outbox stream (target, bytes), frame stream (seq, tick, bytes), and stepIndex trace. |
| DET-02 | Same vignette + S1 under RemoteVignetteHost over LoopbackBytePipe → all three traces byte-identical to DET-01. |
| DET-03 | `counter` (WASM) replaces TS under both hosts → traces byte-identical to DET-01 (this is the ABI-parity + determinism composite; requires the vignette to be written deterministically — no float ambience, fixed iteration orders). |
| DET-04 | Frame-channel loss (LossyPipe, 30% drop + reorder) changes *received* frames only: outbox/App traces and sim state remain identical to DET-01 (loss-tolerance of the frame channel does not feed back into the sim). |
| DET-05 | [S] Determinism under overload: script includes chaos busy-loop segments; drop-time policy yields identical stepIndex↔wall-time mapping across hosts under virtual clock. |

## 5. Binding Parity (contract §2.5)

| ID | Assertion |
|---|---|
| PAR-01 | Shared test-vector file (JSON/binary) drives `echo`-TS and `echo`-WASM directly at the binding layer (no host): identical outbox tuples per vector. |
| PAR-02 | Same for `counter` including frame buffer bytes and `vf_frame_seq` progression. |
| PAR-03 | WASM staging paths: both `vf_mem_alloc`/`free` and inbox-staging-window vignettes pass PAR-01 vectors; allocation failure surfaces as the binding's documented error, not memory corruption. |
| PAR-04 | Oversized inbound payload vs staging capacity → documented rejection (host-side), vignette memory untouched. |
| PAR-05 | `wg_vf.h` compiles clean (−Wall −Wextra, C11) for both wasm32 and host-native targets from one source; the native build passes PAR-01/02 vectors via a minimal native harness (pre-work for the future native host — cheap now, priceless later). |

---

## 6. Suite Organization & Gates

- **Harness entry:** `runHostConformance(makeHost: (manifest) => VignetteHost, opts)` executes ENV-10..24, ABI-01..21, SES-01..22 against any host. New hosts get the full battery for the cost of one factory function.
- **CI gates:** all MUST tests green on: LocalVignetteHost(js), LocalVignetteHost(wasm), RemoteVignetteHost(loopback). DET-01..04 green. ENV-09 fuzz runs nightly with a fixed seed corpus + fresh seeds; failures check in the reproducing seed.
- **Version discipline:** golden fixtures and test vectors are versioned with the contract doc; a change to any golden byte requires a doc delta in the same PR (envelope changes can never be silent).
- **Definition of done for the standalone phase** (per the extraction timebox): full battery green on the three host configurations + DET suite green + PAR-05 native build green. Then Rest Easy's walking-skeleton sim becomes conformance consumer #4, and further framework work requires a Rest Easy-driven need.

## Appendix: Doc gaps surfaced while enumerating — RESOLVED

Writing the assertions exposed three points Part I originally left unpinned. All three are now folded into Part I Draft 0.1 and are normative; the tests below are written against these decisions:

1. **SES-14 (unicast buffering during a reconnect gap):** **Drop, not buffer** — Part I §1.3 / §3.3. A reconnecting peer's `clientId` stays live (no `peerLeft`), but peer-bound bytes targeting it during the gap are discarded; no per-peer resend queue. SES-14 asserts the drop behavior and zero `peerLeft`/`peerJoined`.
2. **ABI-20 (frame snapshot point + zero-step publication):** **Post-burst snapshot; silent when zero `fixedTick`s ran** — Part I §1.4. `frameSeq`/`sourceTick` advance iff `stepIndex` advanced. ABI-20 asserts snapshot point; add ABI-22 (below) for the silence rule.
3. **ENV-08 / PAR-04 (maximum payload length):** **1 MiB default, `maxPayloadBytes` manifest-overridable** — Part I §1.6 / §3.2. Hosts reject over-cap envelopes with `Error(Generic)` before allocation. See ENV-25 and PAR-04 (below).

New/updated assertions implied by the resolutions:

| ID | Assertion |
|---|---|
| ABI-22 | A pump that runs zero `fixedTick`s publishes no frame and does not advance `frameSeq` (advance clock by `< stepUs`; assert frame stream silent, `frameSeq` unchanged; then complete a step and assert exactly one new frame with incremented `frameSeq`). |
| ENV-25 | Envelope with `payloadLen` > configured cap (default 1 MiB; and a manifest-overridden nonstandard cap) → rejected with `Error(Generic)` before the payload body is read/allocated (fenced buffer: bytes past the header are never touched); applies on System, App, and Frame channels; sim state unchanged. |
