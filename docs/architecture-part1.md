# wg-vf Architecture — Part I: Contracts

**Status:** Draft 0.1 · **Scope:** Chapters 1–3 (normative). Reference host implementations (TS worker host, Bun remote host, native host) are non-normative and covered in [Architecture Part II: Reference Host Scaffolding](./architecture-part2.md).

wg-vf runs self-contained **Vignette** modules behind a host boundary. The app talks to a hosted vignette by exchanging **envelopes** over a transport — carried as bytes on a wire (WebSocket, native pipe, loopback) or as a structured object over `postMessage` (worker); the envelope, not the wire form, is the protocol. The vignette talks to the world exclusively through the contracts in this document. The framework's core promise:

> **An unchanged vignette behaves identically regardless of where and in what language it is hosted** — a JS module in a worker, a WASM module in a worker or a Bun/Node process, or a native library in a standalone service.

That promise holds only if every observable behavior of a host is specified. This document specifies three layers:

1. **Wire envelope** — the byte format on every host↔bridge transport.
2. **Vignette ABI & host guarantees** — the language-neutral operation set and the promises every conforming host makes to the vignette.
3. **Provisioning & session** — how vignettes are selected, how peers attach, and who owns lifetime.

A rule of thumb used throughout: *if two independently written hosts could disagree about a behavior in a way the vignette (or a peer) can observe, that behavior is specified here. Everything else is implementation freedom.*

---

## 1. Wire Envelope

### 1.1 Design goals

- One envelope for all transports — carried as bytes over a wire (WebSocket, WebTransport, native FFI byte pipe, loopback) or as a structured object over `postMessage` (the worker path); the envelope, not the wire form, is the protocol.
- Carry **peer identity** in both directions: sender on host-bound messages, target on peer-bound messages.
- Distinguish two delivery classes at the envelope level so future transports can map them to reliable-ordered vs. unreliable-unordered streams without inspecting payloads:
  - **Message channel** — reliable, ordered, drain-everything semantics (events, commands, system traffic).
  - **Frame channel** — latest-wins, tear-protected, droppable (per-tick state snapshots).
- App payloads remain opaque `Uint8Array` bytes. The framework never interprets them.

### 1.2 Envelope layout (v2)

All integers little-endian. Header is fixed 12 bytes.

| Offset | Field        | Type  | Meaning |
|-------:|--------------|-------|---------|
| 0      | `version`    | u8    | `2` for this layout. Hosts MUST reject unknown versions with `Error(code=UnsupportedVersion)`. |
| 1      | `channel`    | u8    | `0` System · `1` App · `2` Frame |
| 2      | `flags`      | u8    | Bit 0: `COMPRESSED` (reserved, MUST be 0 in v2). Bits 1–7 reserved, MUST be 0. |
| 3      | `reserved`   | u8    | MUST be 0. |
| 4      | `systemType` | u16   | Valid only when `channel = System`; otherwise MUST be 0. |
| 6      | `clientId`   | u16   | See §1.3. |
| 8      | `payloadLen` | u32   | Byte length of payload. See §1.6 for the accepted range. |
| 12     | `payload`    | bytes | Opaque for App/Frame; framework-defined for System. |

Changes from v1: `messageKind` splits into `channel`; `clientId` and `flags` are new; header grows from 8 to 12 bytes and is 4-byte aligned throughout.

### 1.6 Payload length bounds

`payloadLen` is a u32, so the wire format admits payloads up to 4 GiB — far larger than any host wants to allocate against untrusted input. Every host therefore enforces a **maximum payload length**:

- The default cap is **1 MiB** (`1048576` bytes). Hosts MUST reject any envelope whose `payloadLen` exceeds the configured cap **before** allocating or reading the payload body, responding `Error(code=Generic)` unicast to the sender (peer-bound over-cap emissions from a vignette are a sim fault; see §2.4).
- The cap is per-vignette host policy, overridable via `maxPayloadBytes` in the manifest (§3.2). It bounds the payload only; the 12-byte header is always additional.
- The cap applies uniformly to System, App, and Frame channels. A rejected envelope is never delivered to the vignette and never mutates session state.

### 1.3 `clientId` semantics

- `0` is reserved and means **none / broadcast**.
- Direction determines interpretation:
  - **Host-bound** (peer → host): the host *stamps* `clientId` with the sending peer's id before delivery to the vignette. Peers MUST NOT self-assign; hosts MUST overwrite whatever a peer put in this field. Identity is asserted by the host at the transport attachment, never by the wire.
  - **Peer-bound** (host → peer): the *target*. `0` = broadcast to all attached peers; nonzero = unicast to that peer only. Hosts MUST silently drop unicast envelopes targeting an id that has no live transport at emission time — whether the peer has left, been evicted, or is mid-reconnect with its transport detached (§3.3). The peer may simply be gone; this is never an error. Broadcasts likewise reach only currently-attached transports. Dropped peer-bound bytes are **not** buffered for later delivery (§3.3).
- Ids are minted by the host per session (§3.4) and fit in u16. `0xFFFF` is reserved for future use.

### 1.4 Channel semantics

**System** (`channel=0`): framework-owned control traffic. Reliable, ordered.

**App** (`channel=1`): the semantic event/command stream. Reliable, ordered per peer. Hosts MUST deliver App messages from a given peer to the vignette in the order received, and deliver peer-bound App messages to each peer in the order emitted. No ordering is guaranteed *across* peers.

**Frame** (`channel=2`): per-tick state publication. Semantics are **latest-wins**:

- The first 8 bytes of every Frame payload are framework-owned: `frameSeq: u32` (monotonic per source, wrapping) and `sourceTick: u32` (the sim `stepIndex` the frame was built from). Remaining bytes are opaque.
- Transports and hosts MAY drop or reorder Frame envelopes. Receivers MUST discard any frame whose `frameSeq` is not newer (modular comparison) than the last accepted frame.
- On transports with a single reliable stream (WebSocket), hosts SHOULD coalesce: if a peer's send buffer already holds an unsent frame, replace it rather than queue behind it.
- On multi-stream/datagram transports (WebTransport), Frame maps to unreliable datagrams; System and App map to a reliable stream. This mapping is the *reason* the channel field exists at the envelope level.

**Publication timing (host side).** The host snapshots and publishes the vignette's frame at exactly one point per loop iteration: **immediately after the `fixedTick` burst completes** (§2.3), never mid-burst. Consequently:

- `sourceTick` is always the `stepIndex` of the last `fixedTick` in that iteration's burst.
- A loop iteration that runs **zero** `fixedTick` calls publishes **no** frame and does **not** advance `frameSeq` — the channel stays silent rather than re-emitting the prior frame. `frameSeq` advances if and only if `sourceTick` advances, so a peer that receives frame *N* and frame *N+1* knows the sim state genuinely changed between them.
- The snapshot is taken by value: bytes already handed to the transport are immutable with respect to later vignette mutation of its frame buffer (the binding either copies on snapshot or exposes the buffer such that post-publication mutation is impossible — see §2.5).

### 1.5 System message set

| `systemType` | Direction | Payload | Notes |
|---|---|---|---|
| `Init` | peer → host | binary (§3.2) | Provision request. Only valid from the founding peer path; see §3.3. |
| `Join` | peer → host | binary: `vignetteId` string, optional `resumeToken` | Attach to an already-provisioned vignette. **New in v2.** |
| `Ready` | host → peer | binary: resolved `vignetteId`, `version`, assigned `clientId`, `fixedStepUs`, `resumeToken` | Per-peer. Echoing the resolved id lets the peer verify it got what it asked for. `resumeToken` is the bearer secret for Reconnect (§3.3); empty when reconnect is disabled (`reconnectGraceMs: 0`). |
| `Error` | host → peer | binary: `code: u16`, `message` string | Codes: `Generic=0`, `UnsupportedVersion=1`, `UnknownVignette=2`, `SessionFull=3`, `NotProvisioned=4`, `PeerFault=5`. Unicast unless sim-fatal. |
| `Shutdown` | either | empty | From host: sim is ending (broadcast). From peer: **request** to leave (equivalent to `Leave`); a peer-originated Shutdown MUST NOT terminate the vignette. Trust boundary — see §3.6. |
| `Leave` | peer → host | empty | Graceful detach. **New in v2.** |
| `Ping` / `Pong` | either | `sequence: u32`, `sentAtMs: f64` | Unchanged from v1. |

`Ready` and `Error` move from JSON to binary payloads in v2 for symmetry with the rest of the protocol; the JSON forms are deprecated.

---

## 2. Vignette ABI & Host Guarantees

### 2.1 The canonical operation set

The ABI is defined once, language-neutrally. Each binding (TS, WASM, C) is a mechanical rendering of this table; no binding may add observable semantics.

| Operation | Signature (conceptual) | Called by host when |
|---|---|---|
| `init` | `(initPayload: bytes) → void` | Once, before anything else. |
| `tick` | `(dtUs: u32, frameId: u32) → void` | Once per host loop iteration while READY. |
| `fixedTick` | `(stepUs: u32, stepIndex: u32) → void` | Zero or more times per loop iteration (§2.3). |
| `handleMessage` | `(senderId: u16, payload: bytes) → void` | Per inbound App envelope. `senderId` is host-stamped (§1.3). |
| `peerJoined` | `(clientId: u16) → void` | After a peer completes Join/provision and before its first `handleMessage`. **New.** |
| `peerLeft` | `(clientId: u16, reason: u8) → void` | On graceful leave, fault eviction, or grace-period expiry. Reasons: `Left=0`, `Fault=1`, `TimedOut=2`. **New.** |
| `shutdown` | `() → void` | Once, last. No operation is invoked after it. |
| `outboxHasMessages` / `outboxPop` | `() → bool` / `() → (targetId: u16, payload: bytes)` | Host drains after every vignette call. `targetId=0` = broadcast. |
| `publishFrame` | *(vignette-initiated; see bindings)* | Vignette exposes the current frame buffer + `frameSeq`; host snapshots/forwards per §1.4. **New.** |

Peer membership is delivered through dedicated `peerJoined`/`peerLeft` operations rather than reserved App payloads, preserving the invariant that App bytes are 100% application-owned.

### 2.2 Call discipline

Hosts MUST:

- Invoke all operations **serially** — never concurrently, never reentrantly. A vignette may assume single-threaded execution.
- Invoke nothing before `init` resolves and nothing after `shutdown` begins.
- Drain the outbox after every operation that can produce output (`init`, `tick`, `fixedTick`, `handleMessage`, `peerJoined`, `peerLeft`).
- Deliver `peerJoined(id)` before any `handleMessage(id, …)` for that id, and deliver no `handleMessage(id, …)` after `peerLeft(id, …)`.

### 2.3 Time and the fixed-step contract

This section exists because a deterministic sim's behavior *is* the host's stepping policy. Every conforming host MUST implement exactly:

- **Units:** microseconds, u32, modular arithmetic. Timestamps wrap at 2³² µs (~71.6 min); deltas computed as `(now - last) >>> 0` are correct across wrap. Vignettes MUST NOT treat `frameId`, `stepIndex`, or `frameSeq` as non-wrapping.
- **Exactness:** `fixedTick` always receives exactly the configured `stepUs` (from the manifest, §3.2). Never a partial step.
- **Monotonicity:** `stepIndex` increments by exactly 1 per `fixedTick` call (mod 2³²), with no gaps and no repeats, across the entire vignette lifetime.
- **Accumulator:** per loop iteration, the host adds `dtUs` to an accumulator and calls `fixedTick` while `acc ≥ stepUs`, up to `maxSubsteps` calls.
- **Overload policy — drop time:** if the accumulator still holds ≥ `stepUs` after `maxSubsteps` calls, the host MUST clamp the accumulator to `< stepUs` (discarding the excess) before the next iteration. Overloaded sims run in slow motion for the overloaded interval and then resume real-time; debt never carries forward. *(This is a behavioral change from the current reference host, which retains the debt.)*
- **Ordering:** within one loop iteration: `tick` once, then the `fixedTick` burst. Inbound App messages are delivered between loop iterations, never between the fixed-step substeps of a single iteration — otherwise message timing relative to `stepIndex` becomes host-dependent, which is observable.
- **Pacing is unspecified** (a host may run its loop at any rate) *except* that the fixed-step contract above must hold. Pacing affects `tick` frequency and frame publication rate, which are explicitly allowed to differ between hosts.

### 2.4 Error containment

v2 replaces the single fatal-error path with two classes:

- **Peer-fault:** an exception/trap thrown by `handleMessage(senderId, …)` is attributed to that sender. The host emits `Error(code=PeerFault)` unicast to the offender, evicts it (`peerLeft(senderId, reason=Fault)` to the vignette), and the sim continues. A malformed or malicious peer cannot take down a session.
- **Sim-fatal:** an exception/trap thrown by `init`, `tick`, `fixedTick`, `peerJoined`, `peerLeft`, or `shutdown` is fatal: the host broadcasts `Error`, then performs shutdown. (A WASM trap is always sim-fatal regardless of which export trapped — a trapped instance's memory is not trustworthy.)

Rationale: `handleMessage` is the only operation driven by untrusted per-peer input; everything else is host-driven and a failure there means the sim itself is broken.

### 2.5 Bindings

Three bindings render the ABI. They are specified fully in the Bindings appendix; the design constraint that matters architecturally:

- **TypeScript:** the `Vignette` interface, extended per §2.1 (`handleMessage(senderId, payload)`, `peerJoined`, `peerLeft`, `outboxPop(): { targetId, payload }`, frame accessor).
- **WASM:** the `vf_*` export set, extended: `vf_handle_message(sender_id, ptr, len)`, `vf_peer_joined(id)`, `vf_peer_left(id, reason)`, outbox entries carry a u16 target prefix, plus `vf_frame_offset` / `vf_frame_len` / `vf_frame_seq` for the frame channel. Staging via `vf_mem_alloc`/`vf_mem_free` or the inbox-staging window, unchanged.
- **C header (`wg_vf.h`):** the same symbols as the WASM export set, declared as a plain C API. **The WASM and native bindings are intentionally the same header** — one C/Nim/Rust/Zig source compiles to a worker-hosted `.wasm` and a server-hosted `.so`/static lib from the same code, making "run in a browser worker" vs. "run native in a room service" a build flag rather than a port. This is the concrete mechanism behind the framework's hosting promise.

---

## 3. Provisioning & Session

### 3.1 Principle: clients name, hosts resolve

Peers never send module URLs. A peer names a vignette by **id** (`restEasy`, optionally `restEasy@1.2`); the host resolves that id against a **manifest** it loaded at startup. What code actually runs is always the host's decision, in every mode. Development convenience is a manifest policy, not a protocol difference.

### 3.2 The manifest

Every host — local worker host included — is constructed with a manifest (a `config.json`, an equivalent object, or programmatic `vignetteFactory` entries, which are the same thing in code form). Schema per entry:

```jsonc
{
  "vignettes": {
    "restEasy": {
      "version": "1.2.0",
      "type": "wasm",                  // "js" | "wasm" | "native"
      "module": "./sims/rest-easy.wasm",
      "fixedStepUs": 16666,
      "maxSubsteps": 4,
      "maxPeers": 8,
      "emptyGraceMs": 30000,           // §3.5
      "reconnectGraceMs": 15000,       // §3.5
      "maxPayloadBytes": 1048576       // §1.6; defaults to 1 MiB if omitted
    }
  },
  "allowClientModuleUrls": false        // dev-only escape hatch, §3.7
}
```

The manifest is the single home for **per-sim host policy**: step configuration, peer limits, lifetime rules, payload bounds. The ABI guarantees of chapter 2 are stated as "the host honors what the manifest declares," which keeps sim-specific numbers out of the framework.

The same manifest format serves both host families. Rest Easy's app bundle ships a manifest; single-player runs the same `VignetteHost` inside a worker (via `runWorkerHost`), resolving `restEasy` from the bundled manifest over a loopback `BytePeer`. The production resolution path is therefore exercised by the dogfood on every run.

### 3.3 Session verbs

A **session** is one provisioned vignette instance plus its peer set. Four verbs:

- **Provision** — `Init(vignetteId, initPayload)`. Valid only when the host is IDLE. Resolves the id (failure → `Error(UnknownVignette)`), instantiates, calls vignette `init`, transitions to READY, then attaches the provisioning peer as the first member (mint id → `peerJoined` → `Ready`).
- **Join** — `Join(vignetteId)`. Valid only when READY. The id MUST match the provisioned vignette (mismatch → `Error(UnknownVignette)`); at `maxPeers` → `Error(SessionFull)`. On success: mint `clientId` → `peerJoined` → unicast `Ready`. `Join` before any provision → `Error(NotProvisioned)`.
- **Leave** — graceful detach: `peerLeft(id, Left)`, id retired (§3.4).
- **Reconnect** — a `Join` carrying a `resumeToken` issued in `Ready`. Within `reconnectGraceMs` of that peer's transport drop, the host re-binds the *same* `clientId` to the new transport without a `peerLeft`/`peerJoined` cycle — a Wi-Fi blip is invisible to the sim. After the grace window the token is dead and the flow is an ordinary Join with a fresh id.
  - **Peer-bound traffic during the gap is dropped, not buffered.** While a reconnecting peer's transport is detached, its `clientId` stays live in the registry (so the sim never sees a `peerLeft`), but any unicast or broadcast bytes targeting it are discarded per §1.3 — the host holds no per-peer resend queue. This is deliberate and consistent with the frame channel's droppable model: the App stream *into* the vignette is unaffected (delivery to the vignette does not depend on any peer's transport), and a sim that needs the reconnecting peer to re-converge does so through its normal state publication (the Frame channel republishes on the next step) or by having peers re-request on rebind. Bounded per-peer buffering is a possible future extension but is not part of this contract.

Who calls Provision is deployment policy, outside this contract: a party leader (client-provisioned co-op), a lobby service (matchmade), or the app itself (single-player local). The protocol is identical in all three.

### 3.4 Peer registry and identity

The host owns a peer registry keyed by `clientId`:

- Ids are minted per session starting at 1; `0` and `0xFFFF` reserved.
- An id is bound to exactly one transport attachment at a time (modulo reconnect re-binding).
- Retired ids (post-Leave, post-grace-expiry, post-eviction) MUST NOT be reused within the session. u16 gives 65k joins per session before exhaustion, which is ample for room-scale sessions; id-exhaustion is sim-fatal.
- The registry, not the wire, is the source of identity truth (§1.3).

The host works in structured envelopes: its seam is `EnvelopePeer` (`send(env)` / `onEnvelope`), and byte (de)serialization is a transport concern (`byteEnvelopePeer`) that can run on any thread. It exposes `connect(bytePeer)` (wraps a raw byte transport) and `connectEnvelopes(envelopePeer)` (already-structured — framing ran elsewhere, e.g. on an IO thread). Identity is minted when the peer sends Init/Join, and the internal `PeerRegistry` binds it via `attach(clientId, pipe)` / `detach(clientId)`. See [Part II §5](./architecture-part2.md) and [transport-perf.md](./transport-perf.md).

### 3.5 Lifetime

The vignette's lifetime belongs to the **host**, not to any peer's connection:

- A peer transport drop starts that peer's `reconnectGraceMs` timer; expiry → `peerLeft(id, TimedOut)`.
- The session entering the empty state (zero attached peers, zero pending reconnects) starts the `emptyGraceMs` timer; expiry → host-initiated shutdown. `emptyGraceMs: 0` means immediate teardown (today's behavior, as a special case).
- Host-initiated shutdown broadcasts `Shutdown`, then runs the vignette `shutdown` op.

### 3.6 Trust boundaries

- Peers can send exactly: `App`, `Frame` (if the app uses client-published frames), `Init`/`Join`/`Leave`, `Ping`, and `Shutdown`-as-leave-request. A peer-originated `Shutdown` detaches that peer only. No peer-originated envelope may terminate, reconfigure, or re-provision a running session.
- Hosts MUST stamp inbound `clientId` (§1.3); a peer cannot impersonate another.
- Administrative control of a session (kill room, kick peer, migrate) is a host-process concern (room-server runtime, ops tooling) and is out of scope for the peer protocol by design.

### 3.7 Development mode

With `allowClientModuleUrls: true`, a host additionally accepts the v1-style provision payload carrying an explicit module URL, enabling push-your-local-sim-to-a-remote-host iteration. This flag:

- MUST default to false and SHOULD refuse to enable outside loopback/LAN binds.
- Changes *resolution* only; every other contract in this document (identity, session, stepping, containment) applies identically. Dev mode is therefore a superset, not a fork — nothing tested in dev mode behaves differently in production except where the module came from.

---

## Appendix A: v1 → v2 changelog (completed)

v1 was removed and rebuilt as v2; all of the following landed. (The one genuinely
open item is the dev-mode `allowClientModuleUrls` client-URL escape hatch, §3.7.)

1. **Envelope v2** — header 8 → 12 bytes; `channel` replaces `messageKind`; `clientId` + `flags` added; binary `Ready`/`Error`/`Join`; new `Join`/`Leave` types; error codes. (`src/envelope/`)
2. **`Vignette` ABI** — `senderId` on `handleMessage`; `peerJoined`/`peerLeft`; targeted outbox; frame accessors. Mirrored in the `vf_*` C ABI (`wg_vf.h`/`wg_vf.c`). (`src/vignettes/`)
3. **Host core** (`VignetteHost`, replacing v1's `BaseVignetteHost`): peer registry; Join-against-READY; peer-fault vs sim-fatal split; drop-time accumulator clamp; App delivery ordered between loop iterations.
4. **Manifest resolution** — hosts constructed with a `Manifest`; the id is resolved at Provision (inline in `handleInit`). *Open:* the `allowClientModuleUrls` URL branch.
5. **Peer-originated `Shutdown` demoted to a leave request**; per-peer `connect`/`disconnect` wired to the registry (in `VignetteHost`, replacing v1's `RemoteVignetteHost`).
6. **Reference server** — host lifetime decoupled from socket lifetime via `SessionManager` (session-keyed host map). *Note:* WebSocket frame coalescing exists as a test helper (`CoalescingPipe`), not yet wired into the WS transport.
