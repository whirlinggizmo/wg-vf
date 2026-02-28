# wg-vf

Whirling Gizmo Vignette Framework.

## Install

```bash
npm install wg-vf
```

## Build

```bash
npm install
npm run build
```

## Usage

```ts
import { VignetteClientImpl, WorkerTransport } from 'wg-vf';
```

See `examples/` for two parallel client examples:

- `examples/local-app.ts` runs a vignette in local mode using a `Worker` and `WorkerTransport`.
- `examples/remote-app.ts` uses the same client flow over `ReconnectingWebSocketTransport` to talk to a remote host.

Both examples choose a vignette type/url and send that selection in the `INIT` payload.

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
await vc.connect(
  new TextEncoder().encode(
    JSON.stringify({
      vignetteType: 'js',
      vignetteUrl: new URL('./vignettes/echo-js/echo-vignette.ts', import.meta.url).href,
      initPayload: { userId: 'rob' },
    }),
  ),
);
```
