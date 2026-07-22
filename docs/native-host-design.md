# Native Host — Design Note

**Status:** Design, not built. The current reference host is TypeScript
(`VignetteHost`), deployed on Bun for backends and in a Web Worker for local.
This note pins the shape of a **native (C) host** so it can be built when a real
need arises — embedding in a C/C++ service, or a hard no-JS-runtime constraint.

**Principle:** anything core to wg-vf that is *native* is **C**. The host core
and the vignette glue (`wg_vf.c`) are C; a vignette may be any language C can
interop with (C, Rust, Zig, Nim, …). A Nim/GC host is deliberately **not** the
native reference — it would drag a runtime into an embeddable core.

The native vignette ABI is already **proven**: `test/wasm/native-parity.test.ts`
`dlopen`s a native `.so`, calls `vf_*`, and reads the outbox ring + frame buffer
byte-for-byte. A native host reuses that exact memory model — the risk is not the
ABI, it's re-implementing the host *logic* in C.

---

## 1. What the host must do (all currently in TS)

A native host re-implements the same units the TS host has — none of which need
external dependencies; they're self-contained logic:

| Unit (TS today) | Native (C) |
|---|---|
| Envelope encode/decode (§1) | ~200 lines C; strict decode, same 12-byte header |
| `FixedStepEngine` (§2.3) | trivial C; accumulator + drop-time clamp |
| `PeerRegistry` (identity, routing) | a `client_id → connection` map; mint/retire/stamp |
| Session state machine (provision/join/leave/reconnect) | a state enum + handlers |
| `HostLoop` (pump) | one function: tick → fixedTick burst → publish frame |
| Containment (peer-fault vs sim-fatal) | branch on the vignette's return/trap |
| Lifetime timers (reconnect/empty grace) | deadlines checked on the event loop |
| Manifest resolution → load vignette | `dlopen` + `dlsym` the `vf_*` set |

## 2. The native vignette loader

The counterpart to `WasmVignette.ts`, in C:

- `dlopen("libmy-sim.so")`, `dlsym` the `vf_*` exports (`vf_init`, `vf_tick`,
  `vf_fixed_tick`, `vf_handle_message`, `vf_peer_joined`, `vf_peer_left`,
  `vf_shutdown`, `vf_outbox_offset/capacity`, `vf_frame_offset/len/seq`,
  `vf_mem_alloc/free`).
- **Drain the outbox ring** exactly as the proven harness does: read `[head]
  [tail][cap]` at `vf_outbox_offset()`, walk entries `[len u32][target u16]
  [payload]`, advance `head`. Offsets are `uintptr_t` — real pointers natively.
- **Read the frame** at `vf_frame_offset()` for `vf_frame_len()` bytes, stamped
  with `vf_frame_seq()`, after each fixedTick burst.
- **Stage inbound** via `vf_mem_alloc`/`free` around `vf_init`/`vf_handle_message`.
- A nonzero return or a trap is **sim-fatal** (§2.4).

Because a native `.so` runs in-process, the loader calls `vf_*` directly (no
serialization) — simpler than the WASM path, same memory contract.

## 3. Transport — the only real external dependency

The host logic is transport-agnostic (the `BytePeer` seam). Two targets:

### a. Framed TCP / Unix socket — **zero external deps**
POSIX sockets + a 4-byte length prefix per envelope. Ideal for a backend "room
service" behind a thin TS/edge that already terminates browser WebSockets and
forwards raw bytes. Event loop via `epoll` (Linux) directly, no libraries.

### b. WebSocket (browser-facing) — libwebsockets
Use the existing wrapper:
<https://github.com/whirlinggizmo/experiments-libwebsockets_wrapper>. Its API
maps almost one-to-one onto the host seam:

| `lwsw` (wrapper) | wg-vf host |
|---|---|
| `on_open(user, client_id)` | attach a transport → `host_connect(peer)` |
| `on_message(user, client_id, data, len, is_binary)` | feed bytes → decode → dispatch |
| `lwsw_send_binary(ctx, client_id, data, len)` | the peer's `send` |
| `on_close(user, client_id)` | transport drop → reconnect grace / evict |
| `uv_loop_t *uv_loop` | the host's event loop (also drives pump + grace timers) |

Note the wrapper's `client_id` is the **transport** handle; wg-vf's `clientId`
(identity in the envelope) is minted separately by the host's `PeerRegistry` and
stamped on inbound — never trust the transport handle as identity.

External footprint for the WS build: **libwebsockets + libuv** (+ `openssl` only
for `wss://`). The TCP build needs **none**.

## 4. Event loop & timers

- WS build: `libuv` (the wrapper already takes a `uv_loop_t`). Schedule the pump
  on a `uv_timer` at the render cadence; check reconnect/empty-grace deadlines
  each iteration (wrap-safe modular compare, as in the TS host).
- TCP build: an `epoll` loop with a timerfd for the pump; same deadline checks.

The `SystemClock` equivalent is `clock_gettime(CLOCK_MONOTONIC)` → µs, u32,
wrapping — matching the ABI's time model.

## 5. Build (Makefile)

- The vignette `.so` is loaded at runtime (`-ldl`), not linked.
- TCP build: `cc host*.c -ldl -o vf-host` (nothing else).
- WS build: link the libwebsockets wrapper + `-luv -lwebsockets` (+ `-lssl
  -lcrypto` for TLS).
- Cross-compile per target triple as usual; the host is plain C11.

## 6. Validation — the cross-host crown jewel

A native host is *correct* iff it passes the same conformance battery as the TS
host. The cleanest proof drives `runHostConformance`'s scenarios **over a
socket** against the running native host (the "WS/socket conformance driving"
item in the TODO): same ENV/ABI/SES/DET assertions, a second independent host
implementation — the strongest possible statement of the framework's promise.
Until that harness exists, a native host can be smoke-tested with the existing
reference vignettes (`counter`/`echo` `.so`) over a loopback socket.

## 7. Dependency summary

| Element | Bun+TS host | Native C host |
|---|---|---|
| Host logic (envelope/engine/session/loop) | our TS | our C — **no deps** |
| Vignette load | `import()` js/wasm | `dlopen` `.so` — **libdl** (POSIX) |
| Event loop + timers | Bun runtime | `epoll`/timerfd (**libc**) or **libuv** (WS) |
| Transport | Bun WebSocket | framed TCP (**none**) or **libwebsockets** (browser) |
| TLS | Bun built-in | **openssl** (optional, `wss` only) |

**Leanest viable native host = framed TCP + `dlopen`, zero external
dependencies** (pure libc). Add libwebsockets/libuv/openssl only when it must
face browsers directly.

## 8. When to build it

Not speculatively. Bun is a single deployable binary, so the TS host already
serves backends. Build the C host when shipping a JS runtime is unacceptable
(embedded in a native server, or an ultra-lean room service). The design above
reuses the proven ABI, so the work is bounded and well-understood.
