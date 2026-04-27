# Vignette Framework Spec

See also:

- [Vignette Runtime ABI](./vignette_runtime_abi.md) for the host-neutral runtime contract behind the current WASM path and future non-TypeScript hosts.

## Goal

Let an app talk to isolated vignette logic through one bridge API while the
logic runs either:
- locally in a worker-backed host
- remotely behind a WebSocket host

The app should not care whether the vignette is local or remote.

## Canonical Terms

### Vignette
A loadable logic module.

Responsibilities:
- consume opaque input payload bytes
- emit opaque output payload bytes through its outbox
- implement `init`, `tick`, `fixedTick`, `handleMessage`, and `shutdown`

A vignette does not know about workers, sockets, reconnect, or transport.

### VignetteHost
The runtime owner of a vignette instance.

Responsibilities:
- instantiate the vignette
- call `vignette.init(...)`
- drive `tick(...)` and `fixedTick(...)`
- call `vignette.handleMessage(...)`
- call `vignette.shutdown()`
- emit system and app envelopes back to the peer

Concrete hosts:
- `LocalVignetteHost`
- `RemoteVignetteHost`

### VignetteBridge
The app-facing session boundary.

Responsibilities:
- connect and disconnect
- forward app init and app messages
- expose outbox polling
- expose ping telemetry
- hide local worker and remote transport details

### Transport
A byte pipe only.

Responsibilities:
- open and close
- send raw bytes
- surface received raw bytes

It does not parse framework envelopes.

## Hard Boundaries

1. Only a host calls `Vignette.init()` and `Vignette.shutdown()`.
2. Only a host drives `tick()` and `fixedTick()`.
3. Transport does not parse envelopes.
4. App messages are opaque bytes to the framework.
5. The bridge is the only app-facing session API.

## Public Interfaces

### Vignette

```ts
export interface Vignette {
  init(initPayload: Uint8Array): Promise<void>;
  tick(dtUs: number, frameId: number): Promise<void>;
  fixedTick(stepUs: number, stepIndex: number): Promise<void>;
  handleMessage(payload: Uint8Array): Promise<void>;
  shutdown(): Promise<void>;
  outboxHasMessages(): boolean;
  outboxPop(): Uint8Array;
}
```

### VignetteBridge

```ts
export interface VignetteBridge {
  connect(config: VignetteBridgeConfig): Promise<void>;
  disconnect(): Promise<void>;

  init(payload: Uint8Array): Promise<void>;
  handleMessage(payload: Uint8Array): Promise<void>;

  ping(): Promise<VignetteBridgePingResult>;
  isConnected(): boolean;
  pollOutbox(): Uint8Array[];
}
```

`isConnected()` means the bridge currently has a usable connection to the hosted
vignette. In remote mode, it is `false` while connecting or reconnecting and
becomes `true` only after the remote host reports `Ready`.

### Bridge Config

```ts
export type VignetteBridgeConfig =
  | {
      mode: 'local';
      vignetteType: 'js' | 'wasm';
      moduleUrl: string;
    }
  | {
      mode: 'remote';
      remoteUrl: string;
    };
```

### VignetteHost

```ts
export interface VignetteHost {
  onInit(initPayload: Uint8Array): Promise<void>;
  onAppMessage(payload: Uint8Array): Promise<void>;
  onShutdown(): Promise<void>;
  setSendBytes(fn: (bytes: Uint8Array) => void): void;
}
```

## Authority Model

### Local
Local mode is bridge-config authoritative.

The app selects the vignette at `connect(...)` time with:
- `vignetteType`
- `moduleUrl`

### Remote
Remote mode is currently client-authoritative.

The app selects the remote vignette in the `init(...)` payload with:
- `vignetteType`
- `vignetteUrl`
- `initPayload`

The remote server does not currently impose its own vignette configuration.

## State Machines

### Bridge States
- `DISCONNECTED`
- `CONNECTING`
- `READY`
- `ERROR`
- `CLOSED`

Rules:
- app messages may only be sent when remote state is `READY`
- reconnect can move remote state back to `CONNECTING`
- reconnect replays the last init payload

### Host States
- `IDLE`
- `INITING`
- `READY`
- `SHUTTING_DOWN`
- `CLOSED`

Rules:
- host must not process app messages before `READY`
- host must turn internal failures into `Error` system messages

## Envelope Format

The framework transport envelope is binary.

Header layout:
- byte `0`: `version: u8`
- byte `1`: `messageKind: u8`
- bytes `2-3`: `systemType: u16` little-endian
- bytes `4-7`: `payloadLen: u32` little-endian
- bytes `8+`: payload bytes

Message kinds:
- `System = 1`
- `App = 2`

For app envelopes:
- `systemType = 0`
- payload is opaque and passed through unchanged

## Bridge-to-Worker Control Layer

Local bridge-to-worker control messages are not encoded in the binary envelope.
They use structured worker messages.

Examples:
- `{ id, method: 'connect', config }`
- `{ id, method: 'init', payload }`
- `{ id, method: 'handleMessage', payload }`
- `{ id, method: 'ping', payload }`

Worker responses include:
- `{ type: 'response', id, ok }`
- `{ type: 'pong', id, payload }`
- `{ type: 'outbox', payload }`
- `{ type: 'error', message }`

The control object is structured-cloned. Payload buffers are transferred.

## System Messages

System types:
- `Init`
- `Ready`
- `Error`
- `Shutdown`
- `Ping`
- `Pong`

### Init
- bridge to host
- starts vignette initialization
- payload meaning depends on authority model

Local `Init` payload may contain:
- raw app init bytes
- or JSON with `vignetteType`, `vignetteUrl`, `initPayload`

Remote `Init` payload currently contains JSON with:
- `vignetteType`
- `vignetteUrl`
- `initPayload`

### Ready
- host to bridge
- indicates successful vignette initialization
- payload currently JSON: `{ ready: boolean, vignetteType: 'js' | 'wasm' }`

### Error
- host to bridge
- indicates host or vignette failure
- payload currently JSON: `{ message: string, code?: string }`

### Shutdown
- bridge to host
- empty payload by default

### Ping / Pong
- liveness and RTT measurement
- binary payload

Current ping payload format:
- `sequence: uint32`
- `sentAtMs: float64`

`Pong` echoes the exact incoming ping payload.

`VignetteBridge.ping()` returns:

```ts
export interface VignetteBridgePingResult {
  sequence: number;
  sentAtMs: number;
  receivedAtMs: number;
  rttMs: number;
}
```

## Message Flow

### Local Mode
1. App creates `VignetteBridge`.
2. App calls `connect({ mode: 'local', vignetteType, moduleUrl })`.
3. Bridge creates a worker running `VignetteBridgeWorker`.
4. Worker creates `LocalVignetteHost`.
5. App calls `init(payload)`.
6. Host instantiates the vignette and calls `vignette.init(...)`.
7. Host starts its tick loop.
8. App sends app payloads with `handleMessage(...)`.
9. Host drains vignette outbox into bridge outbox.
10. App reads output via `pollOutbox()`.

### Remote Mode
1. App creates `VignetteBridge`.
2. App calls `connect({ mode: 'remote', remoteUrl })`.
3. Bridge creates `VignetteBridgeWorker`, and the worker opens `ReconnectingWebSocketTransport`.
4. App calls `init(payload)`.
5. Remote host resolves vignette selection from the init payload.
6. Remote host instantiates the vignette and calls `vignette.init(...)`.
7. Remote host starts its tick loop.
8. App sends app payloads with `handleMessage(...)`.
9. Host drains vignette outbox into bridge outbox.
10. App reads output via `pollOutbox()`.

## Error Handling

If host-side work throws during:
- instantiate
- `init`
- `handleMessage`
- `tick`
- `fixedTick`
- `shutdown`

Then the host must:
1. emit an `Error` system message
2. shut itself down

The bridge surfaces remote transport failures as bridge errors and rejects any
pending remote init or ping operations.

## Notes

- App payload encoding is app-specific. JSON is only an example choice.
- Vignette-to-app payloads are opaque bytes.
- The framework currently uses JSON for `Ready`, `Error`, and host-side init
  bootstrap parsing.
- `ping()` is a first-class bridge API.
- Local `ping()` currently measures bridge-to-worker RTT.
- Remote `ping()` measures worker, transport, and remote host echo RTT.
