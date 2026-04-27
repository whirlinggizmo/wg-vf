# Spec Accuracy Verification

**Date:** April 26, 2026  
**Spec File:** `vignette_framework_spec.md`  
**Status:** ✅ **ACCURATE** - Implementation matches specification

## Verification Results

### Public Interfaces

| Spec Definition | Implementation | Status |
|-----------------|----------------|--------|
| `Vignette` interface | `@/src/vignettes/Vignette.ts:9-17` | ✅ Match |
| `VignetteBridge` interface | `@/src/bridge/VignetteBridge.ts:107-226` | ✅ Match |
| `VignetteHost` interface | `@/src/hosts/VignetteHost.ts:1-7` | ✅ Match |
| `VignetteBridgeConfig` | `@/src/bridge/VignetteBridge.ts:4-15` | ✅ Match |

### Envelope Format

| Spec Field | Implementation | Status |
|------------|----------------|--------|
| `version: u8` at byte 0 | `encode.ts:16`, `decode.ts:11` | ✅ Match |
| `messageKind: u8` at byte 1 | `encode.ts:17`, `decode.ts:12` | ✅ Match |
| `systemType: u16` LE at bytes 2-3 | `encode.ts:18`, `decode.ts:13` | ✅ Match |
| `payloadLen: u32` LE at bytes 4-7 | `encode.ts:19`, `decode.ts:14` | ✅ Match |
| Payload at byte 8+ | `encode.ts:21`, `decode.ts:20` | ✅ Match |

### System Types

| Spec | Implementation (`types.ts:8-15`) | Status |
|------|-----------------------------------|--------|
| `Init = 1` | `Init = 1` | ✅ Match |
| `Ready = 2` | `Ready = 2` | ✅ Match |
| `Error = 3` | `Error = 3` | ✅ Match |
| `Shutdown = 4` | `Shutdown = 4` | ✅ Match |
| `Ping = 5` | `Ping = 5` | ✅ Match |
| `Pong = 6` | `Pong = 6` | ✅ Match |

### System Payloads

| Payload | Spec Format | Implementation | Status |
|---------|-------------|----------------|--------|
| `Ready` | JSON: `{ ready: boolean, vignetteType }` | `systemPayloads.ts:38-58` | ✅ Match |
| `Error` | JSON: `{ message: string, code?: string }` | `systemPayloads.ts:60-83` | ✅ Match |
| `Ping` | Binary: `sequence: u32, sentAtMs: f64` | `systemPayloads.ts:85-91` | ✅ Match |

### State Machines

#### Host States

| Spec State | Implementation (`BaseVignetteHost.ts:11`) | Status |
|------------|---------------------------------------------|--------|
| `IDLE` | `'IDLE'` | ✅ Match |
| `INITING` | `'INITING'` | ✅ Match |
| `READY` | `'READY'` | ✅ Match |
| `SHUTTING_DOWN` | `'SHUTTING_DOWN'` | ✅ Match |
| `CLOSED` | `'CLOSED'` | ✅ Match |

**Spec Rule:** "host must not process app messages before READY"  
**Implementation:** `BaseVignetteHost.ts:78` checks `if (this.state !== 'READY') return;` ✅

**Spec Rule:** "host must turn internal failures into Error system messages"  
**Implementation:** `BaseVignetteHost.ts:114-118` `onHostError()` emits Error then shuts down ✅

#### Bridge States (Remote)

| Spec State | Implementation (`VignetteBridgeWorker.ts:17`) | Status |
|------------|------------------------------------------------|--------|
| `DISCONNECTED` | `'DISCONNECTED'` | ✅ Match |
| `CONNECTING` | `'CONNECTING'` | ✅ Match |
| `READY` | `'READY'` | ✅ Match |
| `ERROR` | `'ERROR'` | ✅ Match |
| `CLOSED` | `'CLOSED'` | ✅ Match |

**Spec Rule:** "app messages may only be sent when remote state is READY"  
**Implementation:** `VignetteBridgeWorker.ts:252-254` throws if state !== 'READY' ✅

**Spec Rule:** "reconnect replays the last init payload"  
**Implementation:** `VignetteBridgeWorker.ts:351-362` `reinitializeAfterReconnect()` uses `lastInitPayload` ✅

### Hard Boundaries

| Spec Rule | Implementation | Status |
|-----------|----------------|--------|
| "Only a host calls `Vignette.init()` and `Vignette.shutdown()`" | `BaseVignetteHost.ts:65, 105` - only host calls these | ✅ Verified |
| "Only a host drives `tick()` and `fixedTick()`" | `BaseVignetteHost.ts:178-214` - private `startTickLoop()` | ✅ Verified |
| "Transport does not parse envelopes" | `Transport.ts` - only `send`/`onBytes`, no decode | ✅ Verified |
| "App messages are opaque bytes" | All `payload: Uint8Array` usage | ✅ Verified |
| "The bridge is the only app-facing session API" | `VignetteBridge` class is sole export to app | ✅ Verified |

### Bridge-to-Worker Control Layer

| Spec Description | Implementation | Status |
|------------------|----------------|--------|
| Control messages use structured-clone | `VignetteBridge.ts:257` `worker.postMessage(request, transfer)` | ✅ Match |
| Request format: `{ id, method, ... }` | `VignetteBridge.ts:17-51` - all request types match | ✅ Match |
| Response format: `{ type: 'response', id, ok }` | `VignetteBridgeWorker.ts:68` | ✅ Match |
| Pong format: `{ type: 'pong', id, payload }` | `VignetteBridgeWorker.ts:61-66` | ✅ Match |
| Outbox format: `{ type: 'outbox', payload }` | `VignetteBridgeWorker.ts:281, 401` | ✅ Match |
| Error format: `{ type: 'error', message }` | `VignetteBridgeWorker.ts:168-170, 344-347` | ✅ Match |

### Authority Model

| Spec | Implementation | Status |
|------|------------------|--------|
| Local: vignette selected at `connect()` | `VignetteBridgeWorker.ts:122-125` uses config.vignetteType/moduleUrl | ✅ Match |
| Remote: vignette selected in `init()` payload | `VignetteBridgeWorker.ts:239-248` sends init payload to remote | ✅ Match |

### Error Handling

| Spec Requirement | Implementation | Status |
|------------------|----------------|--------|
| "emit an Error system message" | `BaseVignetteHost.ts:116` `emitSystem(SystemType.Error, ...)` | ✅ Match |
| "shut itself down" | `BaseVignetteHost.ts:117` `await this.onShutdown()` | ✅ Match |
| "bridge surfaces remote transport failures" | `VignetteBridgeWorker.ts:161-170` posts 'error' on transport error | ✅ Match |
| "rejects pending remote init or ping" | `VignetteBridge.ts:163-165, 375-380` rejects pending on disconnect | ✅ Match |

### Ping RTT Behavior

| Spec | Implementation | Status |
|------|----------------|--------|
| Local ping measures bridge-to-worker RTT | `VignetteBridgeWorker.ts:104-107` returns payload immediately | ✅ Match |
| Remote ping measures full roundtrip | `VignetteBridgeWorker.ts:258-271` awaits transport pong | ✅ Match |
| `VignetteBridgePingResult` structure | `VignetteBridge.ts:95-100` matches spec | ✅ Match |

## Minor Notes (Non-Issues)

1. **Transport interface** - Spec defines minimal `Transport` with `open/close/send/onBytes`. Implementation adds optional callbacks (`onError`, `onConnect`, `onDisconnect`, `onReconnect`) for richer lifecycle handling. This is an extension, not a violation.

2. **Worker message transfer** - Spec mentions "Payload buffers are transferred." Implementation uses transferable objects for payload buffers (`VignetteBridge.ts:244, 65`) to avoid copying. This is a correct implementation detail.

## Conclusion

The `vignette_framework_spec.md` is **accurate and complete**. All specified interfaces, state machines, message formats, and behaviors are correctly implemented. The few implementation details that extend beyond the spec (optional transport callbacks) do not violate any spec constraints.
