# wg-vf Architecture — Part II: Reference Host Scaffolding

**Status:** Draft 0.1 · **Non-normative.** · **Companion to:** Architecture Part I (Contracts) Draft 0.1.

Part I specifies *what* every conforming host must do (wire, ABI, session). This document describes the **shared scaffolding** the reference hosts use to do it — the pieces that are not themselves contract but that all three reference hosts (TS worker host, Bun remote host, future native host) implement identically so that "pass the conformance suite" is cheap to reach and cross-host determinism (test plan §4) falls out by construction.

Nothing here constrains a third-party host: a host may implement Part I any way it likes. This is the reference decomposition, and it is the decomposition the conformance harness (`runHostConformance`) is built to drive.

> **Design stance:** the parts of a host whose behavior is *observable to a vignette or peer* are pushed down into shared, transport-agnostic units driven by an injected clock. The parts that differ between hosts — timer source, transport wiring, RPC framing — are pushed out to thin per-host adapters. The observable core is written once; only the adapters are written three times.

---

## 1. The seam map

Current `main` has a single-peer host with three per-host concerns fused into `BaseVignetteHost`: the tick loop (`setTimeout` + `performance.now`), the send path (`setSendBytes`), and init resolution (`resolveInitPayload`). Part I's multi-peer contract pulls each into a shared unit with an injectable adapter:

| Concern | Today (`main`) | Part II shared unit | Per-host adapter |
|---|---|---|---|
| Time & pacing | `nowUs()` via `performance.now`; `setTimeout` loop | `HostLoop` with injected `nowUs()` + explicit `pump()` | timer driver (real interval vs. test `pump()`) |
| Stepping | inline accumulator in the loop | `FixedStepEngine` (determinism core) | none — identical everywhere |
| Send path | `setSendBytes(fn)` (one sink) | `PeerRegistry` + `attachPeer`/`detachPeer` | one `BytePeer` per transport attachment |
| Provisioning | abstract `resolveInitPayload` | `Manifest` + `resolveVignette()` | manifest source (bundled object vs. file) |
| Frame publish | *(absent)* | `FramePublisher` | transport frame mapping (coalesce vs. datagram) |
| Error class | single fatal path | `containment` dispatch (peer-fault vs sim-fatal) | none — identical everywhere |

The rest of this document takes each shared unit in turn.

---

## 2. `HostLoop` — injectable clock, explicit pump

The determinism suite and the entire conformance battery depend on the host loop being **drivable without wall-clock time**. The reference hosts factor the loop body out of any timer:

```ts
interface Clock { nowUs(): number; }              // wraps at 2^32 µs (Part I §2.3)

class HostLoop {
  constructor(clock: Clock, engine: FixedStepEngine, ...);
  // Runs exactly one loop iteration: one tick(), then the fixedTick burst,
  // then the post-burst frame publish. Drains the outbox after each op.
  pump(): void;
}
```

- **Production driver** schedules `pump()` from a `setTimeout`/`setInterval`/`requestAnimationFrame` loop with a `performance.now`-backed clock. Pacing is unspecified by Part I §2.3; the driver is free to choose it.
- **Test driver** is a `VirtualClock` (`advance(dtUs)`) plus manual `pump()` calls (test plan T-CLOCK). No timers, no sleeps — every conformance test is deterministic and instant.

The rule that makes this safe: **`pump()` reads `dtUs` as `(clock.nowUs() − lastUs) >>> 0` at the top of the iteration and nowhere else.** All time entering the sim flows through that one read, so swapping the clock swaps *all* observable timing. `tick`'s `frameId` and the loop's `stepIndex` are host loop state, not clock-derived.

Inbound App messages are delivered **between** `pump()` calls, never inside one (Part I §2.3 ordering). The reference loop therefore has a clear boundary: the driver delivers any queued inbound envelopes, then calls `pump()`.

---

## 3. `FixedStepEngine` — the determinism core

The accumulator is the one piece that *must* be byte-identical across hosts, because a vignette's behavior is a function of the exact `fixedTick` sequence it receives. It is a standalone, clock-free unit:

```ts
class FixedStepEngine {
  constructor(stepUs: number, maxSubsteps: number);
  // Adds dtUs to the accumulator and returns how many fixedTicks to run
  // this iteration, applying the drop-time clamp. Never returns > maxSubsteps.
  plan(dtUs: number): number;      // and internally clamps the remainder
  readonly stepIndex: number;      // ++ per consumed step, mod 2^32
}
```

Two behaviors are pinned by Part I and encoded here, and **both differ from current `main`**:

1. **Drop-time overload (Part I §2.3).** After emitting `maxSubsteps` steps, if the accumulator still holds ≥ `stepUs`, the engine clamps it to `< stepUs` — the excess is discarded, debt never carries. Current `main` subtracts each consumed step but *keeps* the remainder, retaining debt; the reference engine must clamp instead. This is the single most test-covered behavior (ABI-10/11, DET-05).
2. **Exactness & monotonicity.** `fixedTick` always gets exactly `stepUs`; `stepIndex` increments by exactly 1 per step with no gaps/repeats across the vignette lifetime (ABI-07/08).

Because it is clock-free and side-effect-free (it plans; the loop calls the vignette), the same instance drives every host and is unit-testable in isolation.

---

## 4. Manifest & resolution

Part I §3 makes hosts *resolve* named vignettes against a manifest. This replaces the abstract `resolveInitPayload` hook with a shared, declarative path:

```ts
interface VignetteManifestEntry {
  version: string;
  type: 'js' | 'wasm' | 'native';
  module: string;                  // resolved relative to the manifest's base
  fixedStepUs: number;
  maxSubsteps: number;
  maxPeers: number;
  emptyGraceMs: number;
  reconnectGraceMs: number;
  maxPayloadBytes?: number;        // Part I §1.6; default 1 MiB
}
interface Manifest {
  vignettes: Record<string, VignetteManifestEntry>;
  allowClientModuleUrls?: boolean; // default false (Part I §3.7)
}

// Pure, host-agnostic. Throws the mapped Error code on failure.
function resolveVignette(m: Manifest, id: string /* "restEasy" | "restEasy@1.2" */):
  { entry: VignetteManifestEntry; instantiate(): Promise<Vignette> };
```

- **Loading & validation** happen once at host construction. A malformed manifest is a host *startup* failure (fail fast), never a per-session `Error` — the manifest is operator input, not peer input.
- **Resolution is pure and shared.** Unknown id → the error that becomes `Error(UnknownVignette)`; version-mismatch handling lives here so every host agrees.
- **`vignetteFactory` entries are manifest entries in code form.** The existing `vignetteFactory` option becomes an in-memory manifest entry whose `instantiate()` calls the factory — so `LocalVignetteHost` and the remote host consume one format (test plan SES-06), and there is no separate "programmatic" code path to test.
- **Dev-mode URL provisioning** (Part I §3.7) is one branch inside resolution, gated by `allowClientModuleUrls`; it produces an entry with `module = <client URL>` and otherwise flows identically.

The per-host adapter is only *where the manifest object comes from*: bundled with the app (LocalVignetteHost), read from a config file (remote server), or handed in programmatically (tests).

---

## 5. `PeerRegistry` and the byte-pipe seam

Part I §3.4 replaces the single `setSendBytes` sink with a peer set. The reference hosts keep the existing byte-pipe abstraction (`send` / `onBytes`, the `Transport`/`BytePeer` seam) and **multiply** it:

```ts
interface BytePeer { send(bytes: Uint8Array): void; onBytes(cb: (b: Uint8Array) => void): () => void; }

class PeerRegistry {
  attachPeer(clientId: number, pipe: BytePeer): void;   // replaces setSendBytes
  detachPeer(clientId: number): void;                   // transport gone (may be reconnect)
  mint(): number;                                       // next id, 1-based; skips 0 / 0xFFFF; never reuses within session
  retire(clientId: number): void;                       // post-Leave / evict / grace-expiry
  route(targetId: number, bytes: Uint8Array): void;     // 0 = broadcast to attached; else unicast-or-drop
  readonly attachedCount: number;
}
```

Responsibilities the registry centralizes so every host behaves identically:

- **Identity stamping (Part I §1.3).** On inbound App/Frame envelopes, the registry overwrites `clientId` with the true id bound to the receiving pipe. Peers cannot self-assign; the registry, not the wire, is the source of truth.
- **Routing (Part I §1.3).** `route(0, …)` fans out to all *attached* pipes; `route(k, …)` sends to k's pipe or **silently drops** if k is unattached, retired, or mid-reconnect-detached. No per-peer buffering (Part I §3.3).
- **Id lifecycle (Part I §3.4).** Monotonic minting from 1; retired ids are never reused within the session; id exhaustion is sim-fatal.
- **Reconnect rebind (Part I §3.3).** `detachPeer` marks the id detached but keeps it live (no `peerLeft`) while its `reconnectGraceMs` timer runs; a valid resume `attachPeer` on the same id rebinds without a `peerLeft`/`peerJoined` cycle. Grace expiry → `retire` + `peerLeft(id, TimedOut)`.

`attachPeer(clientId, pipe)` / `detachPeer(clientId)` become the new host↔transport interface method pair, superseding `VignetteHost.setSendBytes`. The `Transport` interface itself is unchanged; each transport attachment is surfaced to the registry as one `BytePeer`.

---

## 6. `FramePublisher`

The Frame channel (Part I §1.4) plumbing the reference hosts share:

- After the `fixedTick` burst in `pump()`, the host asks the binding for the current frame view + `frameSeq` and **snapshots by value**. If the burst ran zero steps, it publishes nothing and does not advance `frameSeq` (Part I §1.4 silence rule).
- The framework prepends `frameSeq:u32, sourceTick:u32` and hands the frame envelope to each peer's pipe.
- The **coalescing vs. datagram** decision is the per-host adapter: a single-reliable-stream pipe (WebSocket) replaces an unsent buffered frame rather than queuing (test plan ENV-19); a datagram-capable pipe (WebTransport) sends Frame unreliably. The publisher exposes a `latestOnly` hint per pipe; the pipe adapter honors it.

Receiver-side newer-than comparison (modular `frameSeq`) is shared and lives with the decode path, so both host-side forwarding and peer-side acceptance use one comparison function (ENV-17/18).

---

## 7. Error containment dispatch

Part I §2.4's two-class model is a shared dispatch wrapper around every vignette call, not per-host logic:

- Calls into `handleMessage(senderId, …)` run inside a guard that, on throw/trap, emits `Error(PeerFault)` unicast to `senderId`, evicts it (`peerLeft(senderId, Fault)`), and lets the sim continue.
- Calls into `init`/`tick`/`fixedTick`/`peerJoined`/`peerLeft`/`shutdown` run inside a guard that, on throw/trap, broadcasts `Error` and drives shutdown.
- **WASM traps are always sim-fatal** regardless of which export trapped (memory-untrustworthy rule, §2.4/ABI-18/19). The WASM binding surfaces a trap as a distinct signal the dispatcher treats as fatal even from `vf_handle_message`.

Because the dispatcher is shared, the JS-vs-WASM difference (a JS `handleMessage` throw is peer-fault; a WASM `vf_handle_message` trap is sim-fatal) lives entirely in *how the binding reports the failure*, not in host branching.

---

## 8. What stays per-host

Everything above is written once. The genuinely per-host code is thin and non-observable-by-contract:

- **TS worker host (`LocalVignetteHost` + `VignetteBridgeWorker`):** the worker RPC framing (structured-clone control messages, transferred payload buffers) and the loopback `BytePeer`. The worker/host boundary stays as the TODO notes: worker owns session/RPC, host owns vignette lifecycle.
- **Bun/Node remote host (`RemoteVignetteHost` + reference server):** WebSocket ⇄ `BytePeer` adapter, the session-keyed host map (host lifetime decoupled from socket lifetime, Part I §3.5 / SES-17), and frame coalescing on the socket.
- **Native host (future):** the `wg_vf.h`-driven binding and an OS byte pipe. Shares §2–§7 by linking the same core.

---

## 9. Mapping to the conformance harness

The decomposition exists to make `runHostConformance(makeHost, opts)` (test plan §6) trivial to satisfy:

| Shared unit | Makes these test areas host-agnostic |
|---|---|
| `HostLoop` + `Clock` | all of ABI (virtual clock, `pump()`), the whole battery's determinism |
| `FixedStepEngine` | ABI-07..14 (stepping), DET-05 (overload) |
| `Manifest`/`resolveVignette` | SES-01..06, SES-21 |
| `PeerRegistry` | ENV-10..14, SES-08..16, SES-22 |
| `FramePublisher` | ENV-17..20, ABI-20..22 |
| containment dispatch | ABI-15..19 |

A new host reaches the full battery by supplying: a `Clock`, a manifest source, a `BytePeer` factory for its transport, and a timer driver. Cross-host determinism (DET-01..04) then holds because the observable core — loop, stepping, registry, publisher, containment — is *the same code* under each adapter.

---

## Appendix: relationship to current `main` (implementation order hint)

The Part I Appendix A deltas map onto this decomposition roughly in dependency order:

1. Envelope v2 (standalone; no host changes) — unblocks everything.
2. `FixedStepEngine` extracted from `BaseVignetteHost.startTickLoop`, with the debt→drop-time change and the injectable `Clock`. Independently unit-testable first.
3. ABI extension (`senderId`, `peerJoined`/`peerLeft`, targeted outbox, frame accessors) across `Vignette` + `vf_*` + `wg_vf.h`.
4. `PeerRegistry` replacing `setSendBytes`; `attachPeer`/`detachPeer` on `VignetteHost`.
5. `Manifest`/`resolveVignette` replacing `resolveInitPayload`.
6. `FramePublisher` + containment dispatch.
7. Per-host adapters rewired (§8); remote server host-lifetime decoupling last.
