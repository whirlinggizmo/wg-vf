# Local vs Remote Message Flow Symmetry Analysis

## Overview

This document analyzes the differences between local and remote message flows to identify which are **intentional** (necessary by design) versus **accidental** (could be unified).

## High-Level Flow Comparison

| Aspect | Local Mode | Remote Mode | Symmetry Status |
|--------|-----------|-------------|-----------------|
| **Connect** | Bridge → Worker → LocalHost | Bridge → Worker → Transport → Remote | ✅ Intentional |
| **Init** | Worker → Host.onInit() | Worker → Transport.send(Init) → RemoteHost | ⚠️ Review |
| **App Messages** | Worker → Host.onAppMessage() | Worker → Transport.send(App) | ✅ Intentional |
| **Outbox** | Host emits → Worker posts 'outbox' | Remote emits → Worker posts 'outbox' | ✅ Intentional |
| **Ping** | Echo in worker | Send Ping → await Pong | ⚠️ Review |
| **Error Handling** | Host emits Error → Worker posts 'error' | Transport/Remote emits Error → Worker posts 'error' | ✅ Intentional |
| **Connection State** | Immediately true after connect | False until Ready, changes on reconnect | ✅ Intentional |
| **Reconnect** | N/A | Built into transport | ✅ Intentional |

## Detailed Analysis

### 1. Init Flow (⚠️ REVIEW)

**Local:**
```
App → bridge.init(payload)
    → worker (dispatch → host.onInit(payload))
        → host creates vignette, calls vignette.init()
        → host emits Ready system message
        → worker receives Ready, immediately resolves
```

**Remote:**
```
App → bridge.init(payload)
    → worker (dispatch → initRemote(payload))
        → worker stores lastInitPayload
        → worker sends System Init envelope to remote
        → remote host creates vignette, calls vignette.init()
        → remote host emits Ready system message
        → worker receives Ready, resolves pendingRemoteInit
        → worker emits connection state 'connected'
```

**Differences:**
- Local: init is synchronous (awaits host completion)
- Remote: init is async/waiting (awaits network roundtrip)
- Remote stores `lastInitPayload` for reconnect replay, local doesn't need this

**Verdict:** ✅ **INTENTIONAL** - Network latency requires async pattern and replay capability.

---

### 2. Ping Flow (⚠️ REVIEW)

**Local:**
```
App → bridge.ping()
    → worker (dispatch: returns request.payload unchanged)
    → bridge calculates RTT = now - sentAtMs
```

**Remote:**
```
App → bridge.ping()
    → worker (dispatch → pingRemote)
        → worker sends System Ping envelope
        → remote host receives Ping, sends Pong
        → worker receives Pong, resolves pendingRemotePing
        → bridge calculates RTT from pong payload
```

**Differences:**
- Local: RTT measures bridge→worker roundtrip only
- Remote: RTT measures bridge→worker→transport→remote→transport→worker→bridge

**Verdict:** ⚠️ **MIXED** - The different measurement scopes are intentional, but the API asymmetry is interesting:
- Local ping is handled entirely in `dispatch()` 
- Remote ping gets its own `pingRemote()` method

This is acceptable because the worker needs to track pending pings for remote mode only (to handle disconnect races).

---

### 3. HandleMessage Flow (✅ INTENTIONAL)

**Local:**
```
App → bridge.handleMessage(payload)
    → worker (dispatch → host.onAppMessage(payload))
        → host calls vignette.handleMessage()
        → host drains outbox, emits to worker
        → worker posts 'outbox' to bridge
```

**Remote:**
```
App → bridge.handleMessage(payload)
    → worker (dispatch → handleMessageRemote)
        → worker checks remoteState === 'READY'
        → worker sends App envelope to remote
        → remote host calls vignette.handleMessage()
        → remote host drains outbox, emits to transport
        → worker receives bytes, posts 'outbox' to bridge
```

**Differences:**
- Local: synchronous call to host
- Remote: async fire-and-forge (no response waited)
- Remote has state check (must be READY), local doesn't need this (host always ready after init)

**Verdict:** ✅ **INTENTIONAL** - Network requires state management and async patterns.

---

### 4. Outbox Draining (✅ INTENTIONAL)

Both modes use identical envelope format for outbox messages:
- `MessageKind.App` envelope
- Worker posts `{ type: 'outbox', payload }` to bridge

The difference is only in transport:
- Local: Host.emit → worker callback → bridge
- Remote: RemoteHost.emit → transport → worker onBytes → bridge

**Verdict:** ✅ **INTENTIONAL** - Same contract, different transport plumbing.

---

### 5. Error Handling (✅ INTENTIONAL)

Both modes post `{ type: 'error', message }` to the bridge.

**Local:**
- Host catches error → emits Error system envelope → worker `handleHostBytes` → posts 'error'

**Remote:**
- Transport error → worker `unbindTransportError` → posts 'error'
- Remote host error → transport → worker `handleRemoteBytes` → posts 'error'

**Verdict:** ✅ **INTENTIONAL** - Same error contract regardless of source.

---

### 6. Connection State (✅ INTENTIONAL)

**Local:**
- `isConnected()` true immediately after `connect()` resolves
- Never changes (no reconnection concept)

**Remote:**
- `isConnected()` false after `connect()` (transport open ≠ host ready)
- Becomes true after `init()` receives Ready
- Becomes false on disconnect, true again on reconnect

**Verdict:** ✅ **INTENTIONAL** - Remote has lifecycle states; local is always ready after connect.

---

## Accidental Asymmetries (Potential Unifications)

None identified in current implementation. The differences are all driven by:
1. **Network latency** requires async patterns
2. **Reconnection** requires state tracking and replay
3. **Worker boundary** requires message passing vs direct calls

## Worker/Host Boundary Assessment

The boundary is **clear and appropriate**:

| Layer | Responsibilities |
|-------|-----------------|
| **VignetteBridge** | App-facing API, request/response orchestration, outbox buffering |
| **VignetteBridgeWorker** | Session lifecycle (connect/disconnect), RPC routing, transport abstraction |
| **LocalVignetteHost** | Vignette lifecycle (init/tick/shutdown), outbox draining |
| **RemoteVignetteHost** | Same as Local, but with byte-peer attachment instead of worker coupling |

The worker does not own vignette lifecycle - it delegates to hosts. This is correct.

## Recommendations

1. **No changes required** - The asymmetries are all intentional and well-justified.

2. **Documentation only** - The spec at `vignette_framework_spec.md:274-298` accurately describes both flows.

3. **Optional future work** - If we wanted to eliminate the ping asymmetry:
   - Local could use the same pending-ping pattern
   - But this adds complexity without benefit (local ping is deterministic)

## Conclusion

The local vs remote message flows are **appropriately asymmetric**. Differences exist where the problem domains differ (local deterministic vs network distributed), and symmetry exists where the contracts should match (outbox format, error reporting, envelope structure).

The implementation follows the spec correctly.
