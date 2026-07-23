# Writing a Vignette — Author Guide

**Audience:** anyone (human or agent) writing a **vignette** — the self-contained
simulation module that runs behind a wg-vf host. **You write logic and choose
your own payload bytes; the host owns everything else** — transport, identity,
lifetime, timing, and the wire protocol.

This guide is self-contained. For the normative contract see
[Architecture Part I](./architecture-part1.md); this is the practical view.

---

## 1. The mental model

```
your app  ─envelopes─▶  a stock wg-vf HOST  ─ABI calls─▶  YOUR VIGNETTE
                          (worker or server)               (this guide)
```

- You implement a small **operation set** (init, tick, fixedTick, handleMessage,
  peerJoined, peerLeft, shutdown) plus an **outbox** and an optional **frame**.
- You **never** write host, transport, worker, or socket code. A host loads your
  module from a **manifest** (it maps a vignette id → your module) and drives it.
- The same vignette source runs **unchanged** in a browser worker, a server
  process, as WASM, or as a native library. Don't assume where you run.

> **Language & toolchain.** The simplest vignette is **plain TypeScript/JS** —
> implement the `Vignette` interface (or extend `BaseVignette`) and you're done;
> **no emscripten, clang, or build step is needed.** WASM/native is an *option*,
> not a requirement — reach for the C ABI (`wg_vf.h`) only when you want a non-JS
> language or native performance. The TS path is
> [§5](#5-writing-a-vignette-in-typescript); the C-ABI path is
> [§6](#6-writing-a-vignette-in-c--wasm-or-native).

### What you own vs. what the host owns

| You own | The host owns |
|---|---|
| Sim state & logic | When ops are called, and in what order |
| The **bytes** of App and Frame payloads (any codec) | Identity (`clientId`), the wire envelope, System messages |
| Your outbox entries (target + bytes) | Routing those entries to peers |
| Your frame buffer + `frameSeq` | When to snapshot/publish it |

---

## 2. The guarantees you can rely on

Every conforming host promises all of this. Write against it:

1. **Serial, non-reentrant, single-threaded.** Operations are never called
   concurrently or nested. No locks needed.
2. **`init` first, `shutdown` last.** Nothing is called before `init` resolves;
   nothing after `shutdown` begins.
3. **Outbox drained after every op.** Anything you enqueue during an op is sent
   before the next op runs.
4. **`peerJoined(k)` precedes the first `handleMessage(k, …)`**, and you get no
   `handleMessage(k, …)` after `peerLeft(k, …)`.
5. **Fixed-step is exact.** `fixedTick` always receives exactly the configured
   `stepUs`; `stepIndex` increments by exactly 1 per call (mod 2³²), no gaps, no
   repeats, for the whole lifetime.
6. **Sender identity is trustworthy.** `senderId` on `handleMessage` is stamped
   by the host; a peer cannot forge or impersonate it.
7. **Your App bytes are 100% yours.** The framework never inspects or reorders
   the *contents* of App/Frame payloads.
8. **Messages arrive between loop iterations**, never between the fixed-step
   substeps of one iteration.

---

## 3. The operation set (the ABI)

This table is the whole contract. Every binding (TypeScript, WASM, C) renders it
identically.

| Operation | When the host calls it |
|---|---|
| `init(initPayload)` | Once, before anything else. |
| `tick(dtUs, frameId)` | Once per host loop iteration (render-rate). |
| `fixedTick(stepUs, stepIndex)` | 0..N times per iteration — the deterministic sim step. |
| `handleMessage(senderId, payload)` | Per inbound App message. `senderId` is host-stamped. |
| `peerJoined(clientId)` | When a peer attaches, before its first message. |
| `peerLeft(clientId, reason)` | On leave (`0`), fault eviction (`1`), or timeout (`2`). |
| `shutdown()` | Once, last. |
| **outbox** | You enqueue `(targetId, bytes)`; the host drains after each op. |
| **frame** | You expose current frame bytes + `frameSeq`; the host publishes it. |

**Time is microseconds, u32, wrapping.** `dtUs`, `stepUs` are durations;
`frameId`, `stepIndex`, `frameSeq` wrap at 2³². Never treat them as
non-wrapping counters.

**`tick` vs `fixedTick`.** `tick` runs once per loop at an unspecified rate — use
it for rate-independent things (interpolation, telemetry). `fixedTick` is your
deterministic sim step at a fixed cadence — put game logic here. If you want
replayable / cross-host-identical behavior, **all state changes go in
`fixedTick`** and depend only on `stepUs`/`stepIndex`.

---

## 4. Channels: how your bytes reach peers

You emit on two logical channels. You never touch the third (System).

- **App (reliable, ordered):** events and commands. `emit(targetId, bytes)` for a
  unicast (`targetId` = a peer's `clientId`), or `broadcast(bytes)` for everyone.
  Delivered reliably and in order per peer. Use any codec (JSON, MessagePack,
  protobuf, hand-rolled binary) — the framework doesn't care.
- **Frame (latest-wins, droppable):** your per-tick state snapshot. You keep a
  frame buffer and a monotonic `frameSeq`; the host snapshots it after the
  fixedTick burst and may drop/coalesce older frames in transit. **Never put
  anything you can't afford to lose on the Frame channel** — put it on App.

Rule of thumb: **discrete events → App; continuous state → Frame.**

---

## 5. Writing a vignette in TypeScript

Extend `BaseVignette` (it manages the outbox queue for you) and override what you
need. Everything is optional except that you handle whatever you care about.

```ts
import { BaseVignette, PeerLeftReason, type FrameView } from "@whirlinggizmo/wg-vf";

export default class MyVignette extends BaseVignette {
  private counter = 0;
  private frameSeq = 0;
  private readonly frame = new Uint8Array(4);

  override init(initPayload: Uint8Array): void {
    // parse your init config from initPayload (any codec)
  }

  override fixedTick(stepUs: number, stepIndex: number): void {
    this.counter = (this.counter + 1) >>> 0;           // deterministic step
    new DataView(this.frame.buffer).setUint32(0, this.counter, true);
    this.frameSeq = (this.frameSeq + 1) >>> 0;
  }

  override handleMessage(senderId: number, payload: Uint8Array): void {
    // react to a peer command; reply to just that peer, or broadcast:
    this.emit(senderId, new TextEncoder().encode("ack"));
    this.broadcast(new TextEncoder().encode("someone did a thing"));
  }

  override peerJoined(clientId: number): void {/* optionally sync state to them */}
  override peerLeft(clientId: number, reason: PeerLeftReason): void {}

  // Return your current frame (or null for "no frame yet"). Snapshot by value.
  override currentFrame(): FrameView | null {
    return { seq: this.frameSeq, body: this.frame.slice() };
  }
}
```

- `emit(targetId, bytes)` / `broadcast(bytes)` are `protected` on `BaseVignette`.
- A **default export** class (or a `() => Vignette` factory) is what the host's
  module loader instantiates.
- You may return a `Promise` from any op; the host awaits it serially.

The host's manifest entry for this module is just:
`{ type: "js", module: "<url to built module>", version, fixedStepUs, maxSubsteps, maxPeers }`.

---

## 6. Writing a vignette in C (→ WASM or native)

One source compiles to a browser-worker `.wasm` **and** a server `.so`, both via
the shipped C glue. You implement handler callbacks and register them; the glue
(`wg_vf.c`) owns the outbox ring buffer, the frame buffer, and the `vf_*` exports
the host calls. Any C-ABI language works this way — C, Rust, Zig, or Nim (see the
interop note below).

**The two assets you build against ship with the package:**

- C header — `@whirlinggizmo/wg-vf/native/wg_vf.h`
- C glue   — `@whirlinggizmo/wg-vf/native/wg_vf.c`

Physically at `node_modules/@whirlinggizmo/wg-vf/dist/native/`. Add that directory
to your include path, `#include <wg_vf.h>`, and compile/link `wg_vf.c` alongside
your vignette.

```c
#include <wg_vf.h>

static uint32_t g_counter = 0, g_seq = 0;

static void on_fixed_tick(uint32_t step_us, uint32_t step_index) {
  (void)step_us; (void)step_index;
  uint8_t body[4];
  g_counter += 1u; g_seq += 1u;
  body[0] = (uint8_t)(g_counter & 0xFF);
  wg_vf_publish_frame(g_seq, body, sizeof body);   // Frame channel
}

static uint32_t on_message(uint32_t sender_id, uint8_t *data, uint32_t len) {
  wg_vf_emit((uint16_t)sender_id, data, len);       // unicast App reply
  wg_vf_broadcast(data, len);                       // App broadcast
  return 0;                                          // 0 = ok; nonzero = sim-fatal
}

// Register on module load (works for the wasm module and the native .so).
__attribute__((constructor)) static void reg(void) {
  wg_vf_handlers h = {0};
  h.on_fixed_tick = on_fixed_tick;
  h.on_message = on_message;
  wg_vf_register(&h);
}
```

Key ABI facts (see `wg_vf.h`):

- **Return codes:** lifecycle exports return `0` on success. A nonzero return, or
  a trap, is **sim-fatal** — a trapped instance's memory is untrustworthy.
- **Outbox ring buffer** at `vf_outbox_offset()`: header `[head u32][tail u32]
  [cap u32]`, then entries `[payload_len u32][target_id u16][payload]`. The glue
  writes it; you call `wg_vf_emit`/`wg_vf_broadcast`.
- **Frame buffer:** `wg_vf_publish_frame(seq, body, len)` sets it; the host reads
  `vf_frame_offset()/len()/seq()`.
- **Input staging:** the host writes inbound payloads via `vf_mem_alloc`/`free`
  and passes `(ptr, len)`. Pointers/offsets are `uintptr_t` — 32-bit on wasm32,
  64-bit native — so the same code is correct on both.

**Build** (see `scripts/build-reference-vignettes.mjs`): `emcc your.c wg_vf.c
-sMODULARIZE -sEXPORT_ES6 -sEXPORTED_RUNTIME_METHODS=HEAPU8 -sEXPORTED_FUNCTIONS=…
--no-entry` for wasm; `clang -shared -fPIC your.c wg_vf.c -o lib….so` for native.
Export the full `vf_*` set (including `vf_peer_joined/left` and `vf_frame_*`).

**Nim / other languages:** author in Nim (or Rust/Zig) by interop — declare the
`wg_vf_*` functions and the `wg_vf_handlers` struct against `wg_vf.h`, compile in
`wg_vf.c`, and register from module init. See the worked example at
[`examples/three/vignette/nim`](../examples/three/vignette/nim).

---

## 7. Determinism (opt in if you want replay / cross-host identity)

The framework can guarantee **byte-identical behavior across hosts, languages,
and replays** — but only if your vignette is deterministic. To qualify:

- Change state **only** in `fixedTick`, using only `stepUs`/`stepIndex`.
- Never read wall-clock time, `Math.random`, or ambient entropy. If you need
  randomness, seed a PRNG from `initPayload` and advance it in `fixedTick`.
- Treat `stepIndex`/`frameId`/`frameSeq` as **wrapping u32** (modular compare).
- Use fixed iteration order (ordered maps/arrays, not hash-set iteration).
- Avoid float nondeterminism if you target multiple languages/CPUs; prefer
  integer/fixed-point for anything that must match bit-for-bit.

Then the same source, TS or WASM, produces the same outbox and frame streams —
which the DET suite verifies.

---

## 8. Errors: what happens when you throw

- **Throw in `handleMessage`** → **peer fault** (JS): the host attributes it to
  the sender, unicasts an `Error`, evicts that peer (`peerLeft(k, Fault)`), and
  the sim keeps running. A malformed/malicious peer can't take down the session.
  *(A WASM trap or nonzero return is always **sim-fatal**, not peer-fault — a
  trapped instance's memory can't be trusted.)*
- **Throw in any other op** (`init`, `tick`, `fixedTick`, `peerJoined`,
  `peerLeft`, `shutdown`) → **sim-fatal**: the host broadcasts an `Error` and
  shuts the session down. So validate untrusted input in `handleMessage`, and
  keep host-driven ops total.
- To force sim-fatal deliberately from `handleMessage` (TS), throw
  `SimFatalError`.

---

## 9. How your vignette gets loaded and run

You don't wire any of this — you just declare it in a **manifest** the host is
given:

```jsonc
{ "vignettes": {
  "my-sim": {
    "type": "wasm",                 // "js" | "wasm"
    "module": "./out/my-sim.wasm.js",
    "version": "1.0.0",
    "fixedStepUs": 16666,           // your sim cadence
    "maxSubsteps": 4,               // overload cap (drop-time beyond this)
    "maxPeers": 8,
    "reconnectGraceMs": 5000,       // optional
    "emptyGraceMs": 10000           // optional
  }
}}
```

A peer provisions your sim by **naming** `"my-sim"` (never a URL); the host
resolves it, loads your module, and drives it. Selecting js vs wasm, local vs
remote, single- vs multi-player is all host/deployment policy — your vignette is
identical in every case.

---

## 10. Testing your vignette (no browser/server needed)

Drive it in-process through a real host with the testing tooling:

```ts
import { VignetteHost } from "@whirlinggizmo/wg-vf";
import { VirtualClock, createLoopbackPipe, HostPeer } from "@whirlinggizmo/wg-vf/testing";
import MyVignette from "./my-vignette";

const clock = new VirtualClock(0);
const host = VignetteHost.single("my-sim",
  { version: "1.0.0", fixedStepUs: 16666, maxSubsteps: 4, maxPeers: 8,
    create: () => new MyVignette() }, clock);

const { a, b } = createLoopbackPipe();
host.connect(a);
const peer = new HostPeer(b);

peer.init("my-sim");           // provision
await host.whenIdle();
peer.app(/* your command bytes */);
await host.whenIdle();
clock.advance(16666);          // one fixed step
await host.pump();

peer.apps();                   // App envelopes your vignette sent
peer.frames();                 // Frame envelopes (latest-wins)
```

`VirtualClock` + `pump()` make it fully deterministic — no timers, no sleeps.

---

## 11. Versioning

Four independent version surfaces keep a moving framework from silently
mismatching a running app or sim:

- **Wire** — `ENVELOPE_VERSION` (the envelope's version byte). If an app and host
  disagree, the decoder rejects the envelope with `Error(UnsupportedVersion)`
  before delivery. Your App payload *format* is your own concern (version it
  however you like inside the bytes).
- **ABI** — `WG_VF_ABI_VERSION`. The host checks it when it **loads** a vignette
  and **refuses a mismatch** with a clear error, so a stale build fails loudly
  instead of misbehaving. How the version is carried depends on how you're loaded:
  - **wasm/native** — the binary exports `vf_abi_version()` (from `wg_vf.c`).
    Rebuild your `.wasm`/`.so` against the new `wg_vf.h` when you bump wg-vf.
  - **JS, module form (dynamically imported)** — the vignette carries an
    `abiVersion`. `BaseVignette` sets it for you; a hand-rolled
    `implements Vignette` sets `readonly abiVersion = WG_VF_ABI_VERSION`. Rebuild
    the module against the new wg-vf when you bump it.
  - **JS, factory (`create`) form** — none needed: it's compiled in the same
    project as the host, so the `Vignette` interface catches drift at build time.
- **Vignette** — the `version` in your manifest entry (your own semver). It's
  echoed back in `Ready`, so a peer can confirm it got the version it asked for.
- **Package** — `VERSION` (the wg-vf semver), exported for diagnostics/logging.

Practical rule: **rebuild any separately-built vignette (wasm/native, or a
dynamically-imported JS module) whenever you bump wg-vf.** If the ABI version
changed, the host tells you at load; if it didn't, the rebuild is a no-op.

---

## 12. Session resume (client-side)

This one is about your **app/client**, not the vignette — but it's the difference
between a dropped connection losing everything and a peer keeping its identity.

When a peer's transport drops, the host holds its `clientId` in **reconnect
grace** (`reconnectGraceMs`) instead of evicting it. From the *vignette's* side a
resume is seamless: **no `peerLeft`, no second `peerJoined`** — the sim never saw
the peer go. Only if grace lapses does the peer get `peerLeft(…, TimedOut)`.

To claim that grace, a returning peer must present the **`resumeToken`** from its
last `Ready` in a `Join`. Two layers make that survive real-world outages:

- **Socket** — `ReconnectingWebSocketTransport` reconnects the WebSocket with
  backoff (an access-point switch *without* a reload).
- **Session** — `ResumeCoordinator` + a `TokenStore` persist the token and open
  each connection with a resume-`Join`. Back it with `sessionStorage` so it also
  survives a **full page reload**:

  ```ts
  const resume = new ResumeCoordinator('myVignette', webStorageTokenStore('room:' + room, sessionStorage));
  // on (re)connect:
  socket.send(resume.opening(initBytes));       // resume-Join if a token is held, else Init
  // on every Ready:
  const { resumed } = resume.onReady(ready);    // persists the fresh token
  if (!resumed) resetLocalSessionState();       // fresh id — first run, or grace had lapsed
  // on a terminating Error/Shutdown: resume.reset();
  ```

Two things to get right:

- **Grace must bracket the outage.** `tryReconnect` only matches an id that's
  *still* in grace and a room that's *still* alive, so set `reconnectGraceMs` and
  `emptyGraceMs` wider than a realistic reload/network transition (the reference
  server defaults to 30 s / 60 s). Past that, the token is refused and the peer
  gets a fresh id — handle `resumed === false`.
- **The token is a bearer credential.** Whoever holds it rebinds that `clientId`.
  Prefer `sessionStorage` (tab-scoped, cleared on close) over `localStorage`, and
  treat it like a session secret.

---

## Checklist

- [ ] All sim state changes in `fixedTick`, driven by `stepUs`/`stepIndex`.
- [ ] Discrete events on App (`emit`/`broadcast`); continuous state on Frame.
- [ ] Validate untrusted input in `handleMessage`; keep other ops total.
- [ ] Treat `frameId`/`stepIndex`/`frameSeq` as wrapping u32.
- [ ] No wall-clock, no unseeded randomness (if you want determinism).
- [ ] `currentFrame()` snapshots by value; `frameSeq` advances only on a step.
- [ ] Default-export a class/factory (TS), or register handlers with `wg_vf_register` from a constructor (native).
