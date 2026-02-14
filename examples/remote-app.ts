import { ReconnectingWebSocketTransport, VignetteClientImpl } from '../src';

// Reconnecting transport keeps retrying when the server is down or restarted.
const transport = new ReconnectingWebSocketTransport({
  url: 'ws://localhost:8787',
  maxDelayMs: 3000,
});

// App-facing client API.
const vc = new VignetteClientImpl({ transport });

vc.onError((err) => {
  console.error('vignette error:', err);
});

// readiness-only signal:
// false = transport/session unavailable, true = INIT/READY handshake completed.
vc.onReady((ready) => {
  if (!ready) {
    console.info('vignette not ready');
    return;
  }

  console.info('vignette ready');
  vc.send(new TextEncoder().encode(JSON.stringify({ type: 'SpawnPlayer' })));
});

vc.onMessage((_payload) => {
  // TODO: decode the payload
});

// Initiates INIT -> READY handshake (and reconnection re-init is automatic).
await vc.connect(
  new TextEncoder().encode(
    JSON.stringify({
      vignetteType: 'wasm',
      vignetteUrl: new URL('./vignettes/echo-wasm/out/echo-vignette_wasm.js', import.meta.url).href,
      initPayload: { userId: 'Bob' },
    }),
  ),
);
