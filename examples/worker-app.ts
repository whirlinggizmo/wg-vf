import { VignetteClientImpl, WorkerTransport, type WorkerVignetteType } from '../src';

// Choose which vignette implementation the worker should host.

const vignetteType: WorkerVignetteType = 'wasm';
// JS vignette module:
//const vignetteUrl = new URL('./vignettes/echo-js/echo-vignette.ts', import.meta.url).href;

// WASM vignette Emscripten loader:
const vignetteUrl = new URL('./vignettes/echo-wasm/out/echo-vignette_wasm.js', import.meta.url).href;
const workerEntryUrl = new URL('../src/VignetteWorker.ts', import.meta.url);

// Start the reusable worker host entrypoint.
const worker = new Worker(workerEntryUrl.href, {
  type: 'module',
});

// Configure the worker with vignette type + module URL.
worker.postMessage({ type: 'vf-config', vignetteType, vignetteUrl });

// Loopback byte transport between app thread and worker host.
const transport = new WorkerTransport({
  worker,
});

// App-facing client API.
const vc = new VignetteClientImpl({ transport });

// App callbacks.
vc.onReady((ready) => {
  if (!ready) {
    console.log('app not ready');
    return;
  }
  console.log('app ready');
  vc.send(new TextEncoder().encode(JSON.stringify({ type: 'SpawnPlayer' })));
});

vc.onMessage((payload) => {
  console.log('app message:', new TextDecoder().decode(payload));
});

vc.onError((err) => {
  console.error('vignette error:', err);
});

// Initiates INIT -> READY handshake.
await vc.connect(new TextEncoder().encode(JSON.stringify({ userId: 'Bob' })));

// Connection established; continue to watch onReady for readiness changes.
