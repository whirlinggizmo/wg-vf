# wg-vf

Whirling Gizmo Vignette Framework.

`wg-vf` is a small framework for running self-contained "vignettes" behind a
message-based host boundary. A vignette is a unit of logic that can be hosted
locally in a Web Worker or remotely behind a WebSocket server, while the app
talks to it through the same client-side API.

One of the main use cases is game or simulation logic that should behave like a
"server" in both single-player and multiplayer modes:

- run that logic locally for offline mode, development, or single-player
- run the same logic remotely for multiplayer or shared simulation
- keep the app-side protocol the same in both cases

That lets a client move between local and remote hosting without having to know
much about where the vignette is actually running.

The main goal is to keep vignette code portable across hosting modes:

- run the same vignette locally during development or offline use
- move that vignette to a remote host without changing the app-facing protocol
- support both JavaScript and WASM vignette implementations

This is useful when you want app code to treat game logic, simulation logic, or
other isolated runtime modules as a separate service boundary, even when that
service is running locally.

## Overview

The project is organized around a few core pieces:

- `VignetteClientImpl` gives the app a single client API for connect, send,
  ready-state, and error handling.
- transports such as `WorkerTransport` and `ReconnectingWebSocketTransport`
  define how bytes move between app and host.
- hosts such as `WorkerVignetteHost` and `RemoteVignetteHost` instantiate and
  run the vignette on the other side of that transport.
- vignettes can be authored in JavaScript or in WASM, as long as they satisfy
  the expected host contract.

## Install

```bash
npm install wg-vf
```

## Build

```bash
npm install
npm run build
```

## Example Dev

```bash
bun run dev:local
```

Runs the local example app plus the vignette watcher.

```bash
bun run dev:remote
```

Runs the remote server, remote app, and the vignette watcher together.

The example watch scripts explicitly restart when dynamically loaded vignette
files change, including:

- `examples/vignettes/echo-js/**`
- `examples/vignettes/echo-wasm/out/echo-vignette*`

## Usage

```ts
import { VignetteClientImpl, WorkerTransport } from 'wg-vf';
```

See `examples/` for two parallel client examples that use the same client flow
with different hosting modes:

- `examples/local-app.ts` runs a vignette in local mode using a `Worker` and `WorkerTransport`.
- `examples/remote-app.ts` uses the same client flow over `ReconnectingWebSocketTransport` to talk to a remote host.

Both examples currently default to the JS vignette path, choose a
`vignetteType`/`vignetteUrl`, and send that selection in the `INIT` payload.

## Bun Remote Host Example

Start a Bun WebSocket host backed by `RemoteVignetteHost`:

```bash
bun run examples/remote-server.ts
```

Or with env vars:

```bash
VF_HOST_PORT=4100 VF_VIGNETTE_TYPE=js VF_VIGNETTE_URL=file:///abs/path/to/your-vignette.ts bun run examples/remote-server.ts
```

Then point the client transport to:

```ts
new ReconnectingWebSocketTransport({ url: 'ws://localhost:4100' });
```

`VignetteClientImpl.onReady` now reports readiness as a boolean:

```ts
vc.onReady((ready) => {
  console.log('ready:', ready);
});
```

## WASM Vignette Contract Support

`createWasmInstance(...)` builds a `Vignette` from an instantiated
WASM vignette module.

- `vf_init`, `vf_tick`, `vf_fixed_tick`, `vf_handle_message`, `vf_shutdown`
- `vf_outbox_offset`
- `memory`

Input staging is supported via either:

- `vf_mem_alloc/vf_mem_free`
- or `vf_inbox_staging_offset/vf_inbox_staging_capacity`

Both remote and local modes can provide per-session vignette selection in the `INIT` payload:

```ts
import { encodeJsonPayload } from './examples/codec';

await vc.connect(
  encodeJsonPayload({
    vignetteType: 'js',
    vignetteUrl: new URL('./vignettes/echo-js/echo-vignette.ts', import.meta.url).href,
    initPayload: { userId: 'rob' },
  }),
);
```
