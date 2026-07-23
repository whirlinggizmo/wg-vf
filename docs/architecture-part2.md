# wg-vf Architecture — Part II: Reference Host Scaffolding

**Status:** Non-normative · **Companion to:** Architecture Part I (Contracts).

> **As-built note.** This document was written as a decomposition plan. The v2
> reference host is built, and a few units named below live **inline in
> `VignetteHost`** rather than as separate classes: frame publication is in
> `HostLoop.pump()` + `VignetteHost.publishFrame` (there is no `FramePublisher`),
> error containment is inline in `VignetteHost` (no separate `containment`
> dispatch), and manifest resolution is an inline lookup in
> `VignetteHost.handleInit` (no `resolveVignette` function). The real separate
> units are `HostLoop`, `FixedStepEngine`, `Clock`, `PeerRegistry`, `Manifest`/
> `loadVignetteModule`, and `SessionManager`. The "Today (`main`)" columns below
> describe the **removed v1** baseline, kept for historical contrast.

Part I specifies *what* every conforming host must do (wire, ABI, session). This document describes the **shared scaffolding** the reference hosts use to do it — the pieces that are not themselves contract but that all three reference hosts (TS worker host, Bun remote host, future native host) implement identically so that "pass the conformance suite" is cheap to reach and cross-host determinism (test plan §4) falls out by construction.

Nothing here constrains a third-party host: a host may implement Part I any way it likes. This is the reference decomposition, and it is the decomposition the conformance harness (`hostConformanceCases`) is built to drive.

> **Design stance:** the parts of a host whose behavior is *observable to a vignette or peer* are pushed down into shared, transport-agnostic units driven by an injected clock. The parts that differ between hosts — timer source, transport wiring, RPC framing — are pushed out to thin per-host adapters. The observable core is written once; only the adapters are written three times.

---

## 1. The seam map

v1 (removed) had a single-peer host with three concerns fused together: the tick loop, the send path, and init resolution. Part I's multi-peer contract pulled each into a unit with an injectable adapter (some now live inline in `VignetteHost` — see the as-built note):

| Concern | Today (`main`) | Part II shared unit | Per-host adapter |
|---|---|---|---|
| Time & pacing | `nowUs()` via `performance.now`; `setTimeout` loop | `HostLoop` with injected `nowUs()` + explicit `pump()` | timer driver (real interval vs. test `pump()`) |
| Stepping | inline accumulator in the loop | `FixedStepEngine` (determinism core) | none — identical everywhere |
| Send path | `setSendBytes(fn)` (one sink) | `PeerRegistry` (attach/detach) | one `BytePeer` per transport attachment |
| Provisioning | abstract `resolveInitPayload` | `Manifest` + inline resolution | manifest source (bundled object vs. file) |
| Frame publish | *(absent)* | `HostLoop.pump` + `VignetteHost` | transport frame mapping (coalesce vs. datagram) |
| Error class | single fatal path | inline containment (peer-fault vs sim-fatal) | none — identical everywhere |

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

Part I §3 makes hosts *resolve* named vignettes against a manifest. As built (`src/hosts/Manifest.ts`), an entry is config plus a source union — code
form (`create`) or module form (`type`/`module`):

```ts
interface VignetteConfig {
  version: string; fixedStepUs: number; maxSubsteps: number; maxPeers: number;
  reconnectGraceMs?: number; emptyGraceMs?: number; maxPayloadBytes?: number;
}
type VignetteSource =
  | { create(): Vignette | Promise<Vignette> }   // in-process factory (tests, bundled)
  | { type: 'js' | 'wasm'; module: string };      // a module URL the host loads
type ManifestEntry = VignetteConfig & VignetteSource;
interface Manifest { vignettes: Record<string, ManifestEntry>; }
```

- **Resolution is an inline lookup.** `VignetteHost.handleInit` does
  `manifest.vignettes[init.vignetteId]`; unknown id → `Error(UnknownVignette)`.
  There is no separate `resolveVignette` function and no `@version` parsing yet.
- **Module loading is framework-owned:** `loadVignetteModule` imports a module-form
  entry and adapts it (wasm → `createWasmInstance`; js → class/factory). Code-form
  entries call `create()` directly — one format for tests and production (SES-06).
- **Dev-mode URL provisioning** (`allowClientModuleUrls`, Part I §3.7) is not built.

The per-host adapter is only *where the manifest object comes from*: passed to
`runWorkerHost` (worker), returned by `SessionManager`'s `manifestFor` (server),
or handed in by tests.

---

## 5. `PeerRegistry` and the byte-pipe seam

Part I §3.4 gives the host a peer set over the byte-pipe abstraction (`send` /
`onBytes`, the `Transport`/`BytePeer` seam). As built (`src/hosts/PeerRegistry.ts`):

```ts
interface BytePeer { send(bytes: Uint8Array): void; onBytes(cb: (b: Uint8Array) => void): () => void; }

class PeerRegistry {
  mint(): number;                                    // next id, 1-based; skips 0 / 0xFFFF; never reuses within session
  attach(clientId: number, pipe: BytePeer): void;    // bind (or rebind, for reconnect)
  detach(clientId: number): void;                    // transport gone (leave/evict/reconnect gap)
  route(targetId: number, bytes: Uint8Array): void;  // 0 = broadcast to attached; else unicast-or-drop
  isAttached(clientId: number): boolean;
  readonly attachedCount: number;
}
```

- **Identity (Part I §1.3).** The host binds a minted `clientId` to a connection
  (`Conn.clientId` in `VignetteHost`); inbound App delivery uses that bound id as
  the sender and **ignores** the decoded wire `clientId`. So the host, not the
  wire, is the source of identity truth (the "stamping" is host-side, not a step
  inside `PeerRegistry`).
- **Routing (Part I §1.3).** `route(0, …)` fans out to all *attached* pipes;
  `route(k, …)` sends to k's pipe or **silently drops** if k is unattached or
  mid-reconnect-detached. No per-peer buffering (Part I §3.3).
- **Id lifecycle (Part I §3.4).** Monotonic minting from 1; ids are never reused
  within the session (retirement is just `detach` + never re-minting).
- **Reconnect rebind (Part I §3.3).** On a transport drop the host keeps the id
  live (no `peerLeft`) while `reconnectGraceMs` runs; a valid resume Join
  `attach`es the same id without a `peerLeft`/`peerJoined` cycle. Grace expiry →
  `detach` + `peerLeft(id, TimedOut)`.

The host↔transport method is `VignetteHost.connect(pipe): PeerConnection`; each
attachment is one `BytePeer`.

---

## 6. Frame publication (in `HostLoop` / `VignetteHost`)

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

- **TS worker host (`runWorkerHost` + `messagePortBytePeer`):** `runWorkerHost` runs a `VignetteHost` inside a worker and bridges the `postMessage` port as a single loopback `BytePeer`. There is no separate RPC channel — the app on the other end speaks the ordinary envelope protocol (`src/hosts/workerHost.ts`).
- **Bun/Node remote host (`SessionManager` + reference server):** `SessionManager` is the session-keyed host map (host lifetime decoupled from socket lifetime, Part I §3.5 / SES-17); `examples/remote-server.ts` bridges each WebSocket to a `BytePeer`. Frame coalescing exists as a test helper (`CoalescingPipe`), not yet wired into the WS transport.
- **Native host (future):** a C host that `dlopen`s a vignette `.so` and speaks the envelope protocol over a socket, reusing the proven ring/frame ABI. Design pinned in [Native Host — Design Note](./native-host-design.md); build when a no-JS-runtime need is concrete.

---

## 9. Mapping to the conformance harness

The decomposition exists to make `hostConformanceCases(makeHost)` (test plan §6) trivial to satisfy:

| Unit (some inline in `VignetteHost`) | Makes these test areas host-agnostic |
|---|---|
| `HostLoop` + `Clock` | all of ABI (virtual clock, `pump()`), the whole battery's determinism |
| `FixedStepEngine` | ABI-07..14 (stepping), DET-05 (overload) |
| `Manifest` + inline resolution | SES-01..06, SES-21 |
| `PeerRegistry` + host-side identity | ENV-10..14, SES-08..16 |
| frame publish (`HostLoop`/`VignetteHost`) | ENV-17..20, ABI-20..22 |
| containment (inline in `VignetteHost`) | ABI-15..19 |

A new host reaches the full battery by supplying `makeHost` — a factory returning a `ConformanceHost` (`connect`/`pump`/`poll`/`whenIdle`/`getState`). Cross-host determinism (DET-01..04) then holds because the observable core — loop, stepping, registry, frame publish, containment — is *the same code* under each adapter.

---

## Appendix: implementation status (complete)

The v2 build landed all of this:

1. **Envelope v2** — `src/envelope/`.
2. **`FixedStepEngine`** (debt→drop-time) + injectable **`Clock`** — `src/hosts/`.
3. **ABI extension** (`senderId`, `peerJoined`/`peerLeft`, targeted outbox, frame accessors) across `Vignette` + the `vf_*` C ABI (`wg_vf.h`/`wg_vf.c`).
4. **`PeerRegistry`** + `VignetteHost.connect(pipe)` (`attach`/`detach` internally).
5. **Manifest resolution** — inline in `VignetteHost.handleInit` (+ `loadVignetteModule`).
6. **Frame publish + containment** — inline in `HostLoop`/`VignetteHost`.
7. **Per-host adapters** (`runWorkerHost`, `SessionManager`, `examples/remote-server.ts`).

Only open item: the dev-mode `allowClientModuleUrls` client-URL branch (Part I §3.7).
