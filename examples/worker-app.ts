import { VignetteClientImpl, WorkerTransport, type WorkerVignetteType } from '../src';

const vignetteType: WorkerVignetteType = 'wasm';
// js vignette
//const vignetteUrl = new URL('./vignettes/echo-js/echo-vignette.ts', import.meta.url).href;

// wasm vignette
const vignetteUrl = new URL('./vignettes/echo-wasm/out/echo-vignette_wasm.js', import.meta.url).href;
const workerEntryUrl = new URL('../src/VignetteWorker.ts', import.meta.url);

const worker = new Worker(workerEntryUrl.href, {
  type: 'module',
});
worker.postMessage({ type: 'vf-config', vignetteType, vignetteUrl });


worker.onmessage = (ev:MessageEvent)=>{
  console.log("worker sent message: ", ev)
}

const transport = new WorkerTransport({
  worker,
});

const vc = new VignetteClientImpl({ transport });

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

await vc.connect(new TextEncoder().encode(JSON.stringify({ userId: 'rob' })));
console.log('vignette connected');
