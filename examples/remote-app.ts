import { ReconnectingWebSocketTransport, VignetteClientImpl } from '../src';

const transport = new ReconnectingWebSocketTransport({
  url: 'ws://localhost:8787',
  maxDelayMs: 3000,
});
const vc = new VignetteClientImpl({ transport });

vc.onError((err) => {
  console.error('vignette error:', err);
});

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

await vc.connect(new TextEncoder().encode(JSON.stringify({ userId: 'rob' })));
