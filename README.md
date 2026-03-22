# wg-vf

Whirling Gizmo Vignette Framework.

`wg-vf` runs self-contained `Vignette` modules behind a host boundary while the
app talks to them through a single `VignetteBridge` API.

A vignette can run:
- locally inside a worker-backed host
- remotely behind a WebSocket host
- as either JavaScript or WASM

The app-facing contract stays the same in both cases.

## Core Model

The main pieces are:

- `VignetteBridge`: app-facing session API
- `LocalVignetteHost`: owns a local vignette instance and its tick loop
- `RemoteVignetteHost`: owns a remote vignette instance and its tick loop
- `Vignette`: the isolated logic module

Key ownership rules:

- the host owns `init`, `tick`, `fixedTick`, and `shutdown`
- the bridge owns connection/session lifecycle
- app payloads are opaque `Uint8Array` bytes
- system messages use a framework-owned binary envelope

## Install

```bash
npm install @whirlinggizmo/wg-vf
```

## Build

```bash
npm install
npm run build
```

To remove stale output first:

```bash
npm run rebuild
```

## Example Commands

```bash
npm run dev
```

Watches and rebuilds the package `dist/` output.

```bash
npm run example
```

Runs the local example app plus the vignette watcher.

```bash
npm run example:remote
```

Runs the remote server, remote app, and the vignette watcher together.

Note: the `example:remote:*:watch` scripts use Bun watch mode and are expected to
stay alive.

## Public API

```ts
import { VignetteBridge } from '@whirlinggizmo/wg-vf';
```

```ts
export interface VignetteBridge {
  connect(config: VignetteBridgeConfig): Promise<void>;
  disconnect(): Promise<void>;

  init(payload: Uint8Array): Promise<void>;
  handleMessage(payload: Uint8Array): Promise<void>;

  ping(): Promise<VignetteBridgePingResult>;
  pollOutbox(): Uint8Array[];
}
```

### Bridge config

```ts
export type VignetteBridgeConfig =
  | {
      mode: 'local';
      vignetteType: 'js' | 'wasm';
      moduleUrl: string;
    }
  | {
      mode: 'remote';
      url: string;
    };
```

## Usage

### Local

```ts
import { VignetteBridge } from '@whirlinggizmo/wg-vf';
import { encodeJsonPayload, decodeJsonPayload } from './examples/codec';

const bridge = new VignetteBridge();

await bridge.connect({
  mode: 'local',
  vignetteType: 'js',
  moduleUrl: new URL('./vignettes/echo-js/echo-vignette.ts', import.meta.url).href,
});

await bridge.init(encodeJsonPayload({ userId: 'Bob' }));
await bridge.handleMessage(encodeJsonPayload({ type: 'SpawnPlayer' }));

for (const payload of bridge.pollOutbox()) {
  console.log(decodeJsonPayload(payload));
}

await bridge.disconnect();
```

### Remote

```ts
import { VignetteBridge } from '@whirlinggizmo/wg-vf';
import { encodeJsonPayload, decodeJsonPayload } from './examples/codec';

const bridge = new VignetteBridge();

await bridge.connect({
  mode: 'remote',
  url: 'ws://localhost:8787',
});

await bridge.init(
  encodeJsonPayload({
    vignetteType: 'js',
    vignetteUrl: new URL('./vignettes/echo-js/echo-vignette.ts', import.meta.url).href,
    initPayload: { userId: 'Bob' },
  }),
);

await bridge.handleMessage(encodeJsonPayload({ type: 'SpawnPlayer' }));

for (const payload of bridge.pollOutbox()) {
  console.log(decodeJsonPayload(payload));
}

const ping = await bridge.ping();
console.log(ping.rttMs);

await bridge.disconnect();
```

## Authority Model

Current remote mode is client-authoritative.

That means:
- local mode selects the vignette in `connect({ mode: 'local', ... })`
- remote mode selects the vignette in the remote `init(...)` payload
- the remote server does not impose its own default vignette selection

## Envelope Model

There are two layers:

- bridge-to-local-worker control messages: structured-clone worker messages
- bridge/host transport messages: binary envelope plus opaque payload bytes

The binary envelope uses:
- `version: u8`
- `messageKind: u8`
- `systemType: u16`
- `payloadLen: u32`
- `payload: bytes`

For `MessageKind.App`, the payload is opaque to the framework.

## System Messages

System message types:
- `Init`
- `Ready`
- `Error`
- `Shutdown`
- `Ping`
- `Pong`

`Ready` and `Error` currently use JSON payloads.

`Ping` and `Pong` use a small binary payload containing:
- `sequence: uint32`
- `sentAtMs: float64`

`bridge.ping()` returns:
- `sequence`
- `sentAtMs`
- `receivedAtMs`
- `rttMs`

## Vignette Interface

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

Hosts drain vignette outbox messages and forward them back to the bridge as app
payloads.

## WASM Support

`createWasmInstance(...)` adapts an instantiated WASM vignette module into the
`Vignette` interface.

Expected exports include:
- `vf_init`
- `vf_tick`
- `vf_fixed_tick`
- `vf_handle_message`
- `vf_shutdown`
- `vf_outbox_offset`
- `memory`

Input staging is supported via either:
- `vf_mem_alloc` / `vf_mem_free`
- or `vf_inbox_staging_offset` / `vf_inbox_staging_capacity`

## Examples

See:
- [`examples/local-app.ts`](./examples/local-app.ts)
- [`examples/remote-app.ts`](./examples/remote-app.ts)
- [`examples/remote-server.ts`](./examples/remote-server.ts)
