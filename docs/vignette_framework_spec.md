# Vignette Framework — Clear Spec for Codex

> **Goal:** Make it trivial for the UI/app to talk to game logic that can run **locally in a Worker** or **remotely on a Server**, without the UI needing to compose a pile of plumbing.
>
> **Key rule:** There are **two envelopes**:
> - **System envelope** (framework-owned): `INIT`, `READY`, `ERROR`, `SHUTDOWN` (+ optional `PING`)
> - **Inner payload** (app-owned): opaque bytes forwarded to/from the game logic unchanged

---

## 1) Canonical Terms (do not rename in generated code)

### 1.1 Vignette
A **loadable module** containing game logic, with a known interface.

- **Sees only inner payload** (opaque bytes).
- Does **not** know about Worker, WebSocket, transport, or system messages.
- Implementations: game services like `GS`, `FE`, `AI`, or a thin client module.

### 1.2 VignetteHost
The thing that **executes a Vignette** and **owns the system-plane**.

Responsibilities:
- Create and own the `Vignette` instance.
- Call `vignette.init(...)` and `vignette.shutdown()` (ONLY the host does this).
- Receive system messages (`INIT`, `SHUTDOWN`) and reply with system events (`READY`, `ERROR`).
- Forward **inner payload bytes** to `vignette.handleMessage(payload)` unchanged.
- Emit inner payload bytes back to the peer unchanged.

Concrete host implementations:
- `WorkerVignetteHost` (runs inside a browser Worker)
- `RemoteVignetteHost` (runs remotely; typically inside a server process such as Bun)

### 1.3 VignetteClient (VC)
The app-facing **handle** that talks to a hosted Vignette.

Responsibilities:
- Establish a transport.
- Run the **system handshake**: send `INIT`, wait for `READY`, surface `ERROR`.
- Provide `connect()/disconnect()` and message send/receive to the app using **inner payload only**.

**VC never calls `vignette.init()` directly.**  
VC requests init/shutdown **via system messages** handled by the Host.

### 1.4 Transport
A **byte pipe** only.

- Sends/receives raw bytes.
- Knows nothing about envelopes or message semantics.

Required transports (only these for now):
- `WorkerTransport` (postMessage-based)
- `WebSocketTransport` (WS-based)
- `ReconnectingWebSocketTransport` (WS with retry/backoff + auto-reconnect)

> **No InProc transport** in this version.

### 1.5 VignetteServer (optional name, but useful)
A process container (e.g., Bun) that:
- accepts WebSocket connections
- creates/owns one or more `RemoteVignetteHost` instances

---

## 2) Hard Boundaries (must be enforced in code)

1. **Only VignetteHost may call `Vignette.init()` and `Vignette.shutdown()`.**
2. **Vignette never sees the system envelope** (`INIT/READY/ERROR/SHUTDOWN`).
3. **Transport never parses envelopes.**
4. **Inner payload is opaque to the framework.**
   - Host and VC **must not decode/inspect inner payload** (whether JSON, MessagePack, binary, etc).
   - They only forward bytes.

---

## 3) Public Interfaces (TypeScript shapes)

### 3.1 Vignette module interface
```ts
export interface Vignette {
  /** Called once after INIT system message is received by the Host */
  init(initPayload: Uint8Array): Promise<void>;

  /** Variable-step update (dt in microseconds, u32) */
  tick(dtUs: number, frameId: number): Promise<void>;

  /** Fixed-step deterministic update (step in microseconds, u32) */
  fixedTick(stepUs: number, stepIndex: number): Promise<void>;

  /** Inner payload in (opaque). V emits 0..N app messages via its outbox. */
  handleMessage(payload: Uint8Array): Promise<void>;

  /** Called once after SHUTDOWN system message is received by the Host */
  shutdown(): Promise<void>;

  /** Outbox: host drains after calling init/tick/fixedTick/handleMessage */
  outboxHasMessages(): boolean;
  outboxPop(): Uint8Array;
}
```

> Note: `initPayload` is the **inner init payload** (opaque) carried inside the `INIT` system message.

### 3.2 Transport interface (bytes only)
```ts
export interface Transport {
  open(): Promise<void>;
  close(): void;

  send(bytes: Uint8Array): void;
  onBytes(cb: (bytes: Uint8Array) => void): () => void;

  /** optional: surface transport-level errors */
  onError?(cb: (err: Error) => void): () => void;
  onConnect?(cb: () => void): () => void;
  onDisconnect?(cb: () => void): () => void;
  onReconnect?(cb: () => void): () => void;
}
```

### 3.3 VignetteClient interface (app-facing)
```ts
export interface VignetteClient {
  connect(initPayload: Uint8Array): Promise<void>;
  disconnect(): void;

  /** Inner payload only */
  send(payload: Uint8Array): void;
  onMessage(cb: (payload: Uint8Array) => void): () => void;

  /** readiness signal only */
  onReady(cb: (ready: boolean) => void): () => void;
  onError(cb: (err: Error) => void): () => void;
}
```

### 3.4 VignetteHost interface (host-facing)
```ts
export interface VignetteHost {
  /** Called when the Host receives a system INIT */
  onInit(initPayload: Uint8Array): Promise<void>;

  /** Called when the Host receives inner payload */
  onAppMessage(payload: Uint8Array): Promise<void>;

  /** Called when the Host receives system SHUTDOWN */
  onShutdown(): Promise<void>;

  /** Host emits bytes back to peer (system envelope or app envelope) */
  setSendBytes(fn: (bytes: Uint8Array) => void): void;
}
```

---

## 4) Envelope Format (outer + inner)

### 4.1 Outer (System) Envelope
The system envelope is owned by the framework and MUST be understood by VC and Host.

Recommended minimal fields (you can match your existing header):
- `version: u8`
- `messageKind: u8`  // system vs app
- `systemType: u16`  // INIT/READY/ERROR/SHUTDOWN if system
- `payloadLen: u32`
- `payload: bytes`

### 4.2 App Envelope (inner payload)
- For `messageKind = APP`, the payload is **opaque** and forwarded unchanged.
- The framework does not interpret it.

> If you already have a single outer envelope that wraps *everything*, keep it.  
> The key is that system types are recognized, and everything else is forwarded as opaque payload.

---

## 5) Required System Messages

### 5.1 System message types
- `INIT` (VC -> Host)
- `READY` (Host -> VC)
- `ERROR` (Host -> VC) and also (VC -> App via callback)
- `SHUTDOWN` (VC -> Host) *(optional but recommended)*

Optional:
- `PING`/`PONG` (health)
- `LOG` (structured logs)

### 5.2 Meaning and ownership
- `INIT` means: **request host to create/initialize a Vignette instance** using the inner `initPayload`.
- `READY` means: host readiness signal with a structured payload:
  - `{ ready: boolean, vignetteType: "js" | "wasm" | "native" }`
  - `ready=true` indicates host initialized and ready for app messages
  - `ready=false` indicates currently not ready (e.g. reconnect/recovery path)
- `ERROR` means: failure in host init, vignette init, vignette handling, or transport failures.
- `SHUTDOWN` means: request orderly shutdown of the vignette instance.

---

## 6) State Machines

### 6.1 VignetteClient states
- `DISCONNECTED`
- `CONNECTING` (transport open, INIT sent, waiting for READY)
- `READY`
- `ERROR`
- `CLOSED`

Rules:
- VC may only send inner payload in `READY`.
- If `ERROR` occurs, VC surfaces it and typically transitions to `ERROR` then `CLOSED`.

### 6.2 VignetteHost states (per connection/session)
- `IDLE`
- `INITING` (creating vignette + calling vignette.init)
- `READY`
- `SHUTTING_DOWN`
- `CLOSED`

Rules:
- Host must ignore app messages before `READY` (or queue them if you explicitly want that).
- Host must wrap any thrown exception into `ERROR` system message.

---

## 7) Message Sequences (VERY IMPORTANT)

### 7.1 Local Worker Mode (VC on main thread, Host+Vignette in Worker)

**Topology**
- Main thread: `VignetteClient`
- Worker: `WorkerVignetteHost` + `Vignette`

**Sequence**
1. UI constructs VC with `WorkerTransport(worker)`.
2. UI calls `vc.connect(initPayload)`.
3. VC: `transport.open()`.
4. VC -> Host: send **System(INIT, initPayload)** over transport.
5. Worker Host receives INIT:
   - create vignette instance (via factory)
   - call `vignette.init(initPayload)`
6. On success: Host -> VC: send **System(READY, readyPayload?)**.
7. VC receives READY:
   - transitions based on payload `ready`
   - fires `onReady(true|false)`
8. UI sends inner payload:
   - UI calls `vc.send(appPayload)`
   - VC -> Host: send **APP(appPayload)** (opaque)
9. Host receives APP:
   - calls `vignette.handleMessage(appPayload)`
   - drains outbox and sends 0..N **APP(responsePayload)** messages
10. VC receives APP:
   - fires `onMessage(responsePayload)` to UI.
11. Shutdown:
   - UI calls `vc.disconnect()`
   - VC -> Host: send **System(SHUTDOWN, empty)**
   - Host calls `vignette.shutdown()`
   - Host stops processing; Worker may terminate.
   - VC closes transport.

### 7.2 Remote Mode (VC on main thread, Host+Vignette on server)

Same as above, but transport is typically `ReconnectingWebSocketTransport` and Host is `RemoteVignetteHost`.

**Sequence**
1. UI constructs VC with `ReconnectingWebSocketTransport({ url })`.
2. UI calls `vc.connect(initPayload)`.
3. VC opens WS.
4. VC sends **System(INIT, initPayload)**.
5. Server Host initializes vignette and calls `vignette.init(initPayload)`.
6. Server Host sends **System(READY, ...)**.
7. VC fires `onReady(true|false)`.
8. APP messages flow as opaque bytes in both directions.
9. Disconnect -> System(SHUTDOWN) -> remote host calls `vignette.shutdown()` -> close.
10. On reconnecting transport recovery:
   - VC emits `onReady(false)`
   - VC re-sends `INIT` after reconnect
   - Host re-initializes and emits `READY(ready=true)`
   - VC emits `onReady(true)` again

---

## 8) Error Handling (must be explicit)

### 8.1 Host-side errors
If any of these occur:
- vignette factory throws
- `vignette.init` throws/rejects
- `vignette.handleMessage` throws/rejects
- `vignette.shutdown` throws/rejects

Then Host must:
1. send **System(ERROR, errorPayload)** back to VC
2. transition to `ERROR` then `CLOSED` (or keep alive if you explicitly want retry)

`errorPayload` should be small and safe:
- error code / string
- message
- optional stack (dev only)

### 8.2 VC-side errors
If transport errors occur, VC should:
- surface `onError(err)`
- transition out of READY
- emit `onReady(false)`
- close transport for non-recoverable failures

---

## 8.3 Recovery Semantics (reconnecting transport)

When using `ReconnectingWebSocketTransport`, recovery behavior is:

1. Transport drops:
   - VC emits `onReady(false)`.
   - VC MUST NOT allow app sends while not ready.
2. Transport reconnects:
   - VC re-sends `System(INIT, lastInitPayload)`.
   - Host re-creates/re-initializes the vignette session.
3. Host sends `System(READY, { ready: true, vignetteType })`:
   - VC emits `onReady(true)`.
   - App sends are allowed again.

Notes:
- `READY` is the framework readiness signal. It is not a full health stream.
- `ready=false` means “currently not usable for app messaging.”
- If reconnect attempts permanently fail (retry limit reached), VC surfaces `onError(err)` and remains not ready.

---

## 9) Example Usage (UI)

### 9.1 Worker-local (recommended for local execution)
```ts
const worker = new Worker(new URL("../src/VignetteWorker.ts", import.meta.url), {
  type: "module",
});

worker.postMessage({
  type: "vf-config",
  vignetteType: "js", // or "wasm"
  vignetteUrl: new URL("./vignettes/echo-js/echo-vignette.ts", import.meta.url).href,
});

const transport = new WorkerTransport({ worker });

const vc = new VignetteClientImpl({ transport });

vc.onReady((ready) => {
  if (!ready) return;
  vc.send(new TextEncoder().encode(JSON.stringify({ type: "SpawnPlayer" })));
});

vc.onMessage((payload) => {
  console.log("app message:", new TextDecoder().decode(payload));
});

vc.onError((err) => console.error("vignette error:", err));

await vc.connect(new TextEncoder().encode(JSON.stringify({ userId: "rob" })));
```

### 9.2 Remote (WS)
```ts
const transport = new ReconnectingWebSocketTransport({
  url: "wss://example.com/game",
  maxDelayMs: 3000,
});
const vc = new VignetteClientImpl({ transport });

vc.onReady((ready) => {
  console.log("ready:", ready);
});

await vc.connect(new TextEncoder().encode(JSON.stringify({ userId: "rob" })));
```

---

## 10) Worker Host Entrypoint (Host side skeleton)

```ts
// src/VignetteWorker.ts
// reusable worker entrypoint; receives one vf-config message, then boots a host
(self as DedicatedWorkerGlobalScope).onmessage = (event) => {
  if (event.data?.type !== "vf-config") return;
  const host = createHost(event.data); // js or wasm based on vignetteType
  host.attachToWorker(self);
};
```

---


---

## 11) Ticking & Fixed Step (portable, 32-bit time)

> **Intent:** A Vignette must be **swappable** between:
> - native JS/TS (or JS generated by Nim/Haxe/etc), and
> - WASM (generated by Nim/Haxe/C/etc),
>
> without changing the **VignetteClient**, the **system envelope**, or the **inner payload protocol**.
>
> Therefore, the Host drives execution with a portable, 32-bit-only API surface:
> - `tick(dtUs, frameId)` for variable-step update
> - `fixedTick(stepUs, stepIndex)` for deterministic simulation
>
> **No 64-bit values:** use unsigned 32-bit microseconds (`u32`) for time deltas/steps.

### 11.1 Where ticking happens
- **Worker-local mode:** `WorkerVignetteHost` runs the tick loop inside the Worker.
- **Remote mode:** `RemoteVignetteHost` runs the tick loop on the server.

`VignetteClient` never calls `tick()` directly; it only connects, forwards app payloads, and surfaces lifecycle.

### 11.2 Host tick loop (accumulator pattern)
The Host maintains:
- `frameId: u32`
- `stepIndex: u32`
- `fixedStepUs: u32` (configured via INIT inner payload)
- `accUs: u32` accumulator
- `lastUs: u32` last timestamp (wrap-safe)

Per “frame” in the host loop:

1. `nowUs = (performance.now()*1000) >>> 0` (or server equivalent)
2. `dtUs = (nowUs - lastUs) >>> 0` (wrap-safe unsigned diff)
3. `lastUs = nowUs`
4. Call `await vignette.tick(dtUs, frameId++)`
5. Drain outbox and forward APP messages
6. `accUs += dtUs`
7. While `accUs >= fixedStepUs` and `substeps < maxSubsteps`:
   - `await vignette.fixedTick(fixedStepUs, stepIndex++)`
   - Drain outbox and forward APP messages
   - `accUs -= fixedStepUs`

### 11.3 Outbox rule (portable messaging)
To keep JS and WASM vignettes interchangeable:
- Vignettes emit outgoing APP payloads by enqueueing to their **outbox**
- The Host drains the outbox after **every** call into the Vignette:
  - `init`, `tick`, `fixedTick`, `handleMessage`

No function-pointer callbacks are required (or desired) for core messaging.

## 11) Non-goals (keep the framework lean)
- No schema enforcement for inner payload.
- No reflection-based RPC required.
- No in-proc transport in this iteration.
- No multiplexing unless explicitly introduced later.

---

## 12) Codex Implementation Checklist (what to generate)

Generate a minimal TS project structure:

- `src/Vignette.ts` (interface)
- `src/VignetteClient.ts` (interface + impl)
- `src/VignetteHost.ts` (interface)
- `src/hosts/WorkerVignetteHost.ts`
- `src/hosts/RemoteVignetteHost.ts` *(stub is fine)*
- `src/transports/Transport.ts`
- `src/transports/WorkerTransport.ts`
- `src/transports/WebSocketTransport.ts`
- `src/transports/ReconnectingWebSocketTransport.ts`
- `src/envelope/encode.ts` + `decode.ts` for system/app envelope
- `src/VignetteWorker.ts` reusable worker host bootstrap
- Example app usage + example vignette modules

**Acceptance criteria**
- VC `connect(initPayload)` sends `INIT` and awaits `READY`.
- Host calls `vignette.init(initPayload)` only after receiving INIT.
- Inner payload is never decoded in framework.
- Host errors become `ERROR` system messages.
- Local mode uses WorkerTransport; remote may use WebSocketTransport or ReconnectingWebSocketTransport.
- Reconnecting remote mode re-sends `INIT` after reconnect and waits for `READY(ready=true)`.

---

---

## 12) JS Vignette Contract (non-WASM)

> This section applies when the **Vignette implementation is JavaScript/TypeScript** (no WASM).
>
> **Goal:** Keep JS vignettes dead simple and consistent with the framework’s `Vignette` interface.
> No transport knowledge, no system envelope awareness, no callbacks required.

### 12.1 Required interface
A JS vignette MUST implement:

```ts
export interface Vignette {
  /** Called once after INIT system message is received by the Host */
  init(initPayload: Uint8Array): Promise<void>;

  /** Variable-step update (dt in microseconds, u32) */
  tick(dtUs: number, frameId: number): Promise<void>;

  /** Fixed-step deterministic update (step in microseconds, u32) */
  fixedTick(stepUs: number, stepIndex: number): Promise<void>;

  /** Inner payload in (opaque). V emits 0..N app messages via its outbox. */
  handleMessage(payload: Uint8Array): Promise<void>;

  /** Called once after SHUTDOWN system message is received by the Host */
  shutdown(): Promise<void>;

  /** Outbox: host drains after calling init/tick/fixedTick/handleMessage */
  outboxHasMessages(): boolean;
  outboxPop(): Uint8Array;
}
```

Rules:
- `initPayload` and `payload` are **inner payload** bytes and MUST be treated as opaque by the framework.
- The JS vignette may decode/encode its *own* inner protocol (JSON/MsgPack/etc) internally, but the framework does not.

### 12.2 Module export shapes (choose ONE)

#### Option A: `createVignette()` factory export (recommended)
The module exports a factory:

```ts
export function createVignette(): Vignette;
```

Host loading logic:
- `const mod = await import(url)`
- `const vignette = mod.createVignette()`

#### Option B: Default-exported class
The module default-exports a class implementing `Vignette`:

```ts
export default class MyVignette implements Vignette { /* ... */ }
```

Host loading logic:
- `const mod = await import(url)`
- `const vignette = new mod.default()`

### 12.3 Outgoing messages (JS)

To keep JS vignettes swappable with WASM vignettes, JS vignettes MUST emit outgoing app messages via the **outbox**:

- `outboxHasMessages(): boolean`
- `outboxPop(): Uint8Array`

The Host drains the outbox after every call into the vignette (`init`, `tick`, `fixedTick`, `handleMessage`).

### 12.4 No host-callback registration for core messaging
JS vignettes MUST NOT require a `setPostMessageCallback(...)` or any host-provided function-pointer callback for gameplay/app messaging.

Rationale:
- Keeps the vignette portable and testable.
- Keeps message flow host-driven and debuggable.
- Matches the WASM contract preference (host drains outbox).

Optional diagnostics are allowed (future):
- `host_log(...)` style logging hooks controlled by the host, not required by the vignette.

### 12.5 Host execution pattern (JS)
When Host receives:

- **System(INIT, initPayload)**:
  - create vignette
  - `await vignette.init(initPayload)`
  - send **System(READY)** on success, **System(ERROR)** on failure

- **APP(payload)**:
  - `await vignette.handleMessage(payload)`
  - drain outbox and send 0..N **APP(...)** messages

- **System(SHUTDOWN)**:
  - `await vignette.shutdown()`

## 13) WASM Vignette Contract (recommended: outbox ring buffer, no callbacks)

> This section applies when the **Vignette implementation is WebAssembly (WASM)** (with or without an Emscripten JS loader).
>
> **Goal:** Avoid passing JS/native function pointers into WASM (e.g. `addFunction` / table indices) for core messaging.
> Use a **host-driven outbox** instead, which is stable across Worker, Bun, and native hosts.

### 13.1 Core principle
- **Host calls into WASM** (`init`, `handleMessage`, `shutdown`)
- WASM writes **0..N outgoing inner payload messages** into an **outbox ring buffer**
- After each call, **Host drains the outbox** and forwards each message as an APP payload (opaque bytes)

This avoids:
- fragile function pointer plumbing (`setPostMessageCallback`)
- re-entrancy (WASM calling back into host while host is mid-call)
- callback signature/lifetime issues across toolchains

### 13.2 Minimal required WASM exports

WASM Vignettes MUST export functions that match the portable, 32-bit-only surface:

- `vf_init(inPtr: u32, inLen: u32) -> u32`  
  Initialize. Returns 0 on success.

- `vf_tick(dtUs: u32, frameId: u32) -> u32`  
  Variable-step update. Returns 0 on success. May enqueue 0..N outbox messages.

- `vf_fixed_tick(stepUs: u32, stepIndex: u32) -> u32`  
  Fixed-step deterministic update. Returns 0 on success. May enqueue 0..N outbox messages.

- `vf_handle_message(inPtr: u32, inLen: u32) -> u32`  
  Consume one inner payload message. Returns 0 on success. May enqueue 0..N outbox messages.

- `vf_shutdown() -> u32`  
  Shutdown. Returns 0 on success.

> All time values are **u32 microseconds**. No 64-bit integers and no hi/lo splits.

#### Memory allocation exports (choose ONE approach)
**Option A: Emscripten-style**
- `malloc(size: u32) -> u32`
- `free(ptr: u32)`

**Option B: Framework-style**
- `vf_mem_alloc(size: u32) -> u32`
- `vf_mem_free(ptr: u32)`

**Option C: Fixed shared buffers**
- Host and WASM agree on fixed offsets/sizes for input staging and outbox ring.
- No allocator needed.

### 13.3 Outbox ring buffer layout (SPSC, varlen messages)

The outbox ring is **Single-Producer / Single-Consumer**:
- Producer: WASM vignette code
- Consumer: Host code (JS in Worker or Bun server)

#### 13.3.1 Header (12 bytes)
At a known base address `outboxBase` (u32 aligned):

- `head: u32`  (read index; advanced by consumer/host)
- `tail: u32`  (write index; advanced by producer/wasm)
- `cap:  u32`  (payload capacity in bytes, not including header)

Payload starts immediately after header:
- `payloadBase = outboxBase + 12`

All indices are byte offsets in `[0, cap)`.

#### 13.3.2 Message framing (length-prefixed)
Each message written into the ring is:

- `[len: u32 LE] [payload: len bytes]`

`len` is the number of payload bytes.

The ring may wrap; implementation must handle fragmented writes/reads.

#### 13.3.3 Required ring semantics
- The producer (WASM) MUST never overwrite unread data.
- The consumer (Host) MUST only advance `head` after fully reading a message.
- The ring supports enqueueing multiple messages per `vf_handle_message` call.

#### 13.3.4 Full/empty conditions
- Empty when `head == tail`
- Full when next write would collide with unread region (standard SPSC ring rules)

> If the ring is full, the vignette may:
> - return a non-zero error code
> - or drop non-critical messages (logs/telemetry only) if you explicitly allow that

### 13.4 Exporting ring addresses to the Host

The host needs to locate the ring buffer and (optionally) an input staging area.

Provide one of these approaches:

#### Approach A (recommended): exported offset functions
WASM exports:
- `vf_outbox_offset() -> u32`  // returns outboxBase
- `vf_outbox_capacity() -> u32` // returns cap (optional; header already contains cap)

Optionally:
- `vf_inbox_staging_offset() -> u32`
- `vf_inbox_staging_capacity() -> u32`

#### Approach B: fixed offsets in a shared memory contract
Document constants:
- `OUTBOX_BASE = ...`
- `OUTBOX_CAP = ...`

This is simplest and fastest but less flexible.

### 13.5 Host call pattern (no callbacks)

For each `INIT` or `APP` message:

1. Allocate or locate input buffer in WASM memory
2. Copy inner payload bytes into WASM memory at `inPtr`
3. Call the export (`vf_init` or `vf_handle_message`)
4. If return != 0:
   - host sends `System(ERROR, ...)`
5. Drain outbox ring:
   - while not empty:
     - read `len`
     - read `payload`
     - forward as APP payload (opaque)
     - advance `head`
6. (optional) free input buffer if using allocator

### 13.6 Optional imports for diagnostics (safe callbacks)
If desired, allow **non-critical** callbacks only for logging:

Imported function(s) (stable imports, not function-pointer registration):
- `host_log(ptr: u32, len: u32)`  // reads UTF-8 bytes from WASM memory

This is OPTIONAL and MUST NOT be required for gameplay messaging.

### 13.7 Why this contract is preferred
- Works the same in Worker and Server.
- Avoids `addFunction` / function-table churn.
- Prevents re-entrant call stacks (hard to debug).
- Enables batching and multiple outgoing messages per input.
- Plays nicely with ring-buffer tooling and your existing mental model.

---

## 14) Packaging & Tooling Requirements (wg-vf)

> **Project name:** `wg-vf`
>
> The Vignette Framework MUST be usable as a **standalone, publishable module**
> (e.g., `npm install wg-vf`) with no dependency on any specific app structure.

### 14.1 Standalone module intent

- `wg-vf` contains:
  - Vignette interfaces
  - VignetteClient
  - VignetteHost implementations
  - Transport implementations
  - Envelope encoding/decoding
- It MUST NOT depend on:
  - App-specific code
  - Game-specific logic
  - Any specific rendering framework
- It MAY depend on small runtime utilities (but keep external deps minimal).

The goal is that any project can:

```ts
import { VignetteClient, WorkerVignetteHost } from "wg-vf";
```

without needing any other framework assumptions.

---

### 14.2 Vite usage (development only)

Vite SHOULD be used for development and local builds because:
- Fast HMR
- Clean Worker bundling
- Easy TS integration

However:

> Vite is a **development/build tool**, not a runtime requirement.

The framework must work in environments that are not Vite-based.

---

### 14.3 Dynamic vignette loading (Vite-compatible, runtime-resolved)

Vignettes MUST be dynamically imported at runtime using standard ESM dynamic import.

Because this project uses Vite for development, the framework MUST use:

```ts
const mod = await import(/* @vite-ignore */ vignetteUrl);
```

Rationale:
- Prevents Vite from trying to statically analyze or pre-bundle the vignette.
- Allows truly dynamic, runtime-provided URLs.
- Keeps vignette modules swappable without rebuild.

This is REQUIRED for local development under Vite.

The runtime must still function in environments that do not use Vite
(Node, Bun, production builds, etc.), but Vite compatibility during development
is an explicit requirement of the framework.

The Host is responsible for resolving the vignette URL or module specifier.
This allows:

- JS vignette modules
- Generated JS from Nim/Haxe/etc
- WASM modules (via separate loader logic)
- Runtime-loaded remote modules

Dynamic import must remain standard ESM syntax with the Vite ignore directive
so that development tooling does not interfere with runtime module loading.

---

### 14.4 Worker entry isolation

Worker entry files must be small bootstraps that:

- Import `wg-vf`
- Construct `WorkerVignetteHost`
- Dynamically load the vignette module
- Attach to `self`

The worker bootstrap should NOT contain game logic.

---

### 14.5 Swappability requirement

The framework must allow the following swaps without changing client code:

- JS vignette → WASM vignette
- Local Worker host → Remote host
- Vite dev build → production build without Vite

If changing the vignette implementation requires modifying `VignetteClient`,
the architecture has regressed.
