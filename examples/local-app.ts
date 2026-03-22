import {
  VignetteBridge,
  type VignetteType,
} from '../src';
import { decodeJsonPayload, encodeJsonPayload } from './codec';

const vignetteType: VignetteType = 'wasm';

function getVignetteUrl(type: VignetteType): string {
  switch (type) {
    case 'wasm':
      return new URL(
        './vignettes/echo-wasm/out/echo-vignette_wasm.js',
        import.meta.url,
      ).href;
    case 'js':
      return new URL(
        './vignettes/echo-js/echo-vignette.ts',
        import.meta.url,
      ).href;
  }
}

const bridge = new VignetteBridge();

await bridge.connect({
  mode: 'local',
  vignetteType,
  moduleUrl: getVignetteUrl(vignetteType),
});

await bridge.init(encodeJsonPayload({ userId: 'Bob' }));
await bridge.handleMessage(encodeJsonPayload({ type: 'SpawnPlayer' }));

for (const payload of bridge.pollOutbox()) {
  console.log('[bridge] received message from vignette:', decodeJsonPayload(payload));
}

setTimeout(async () => {
  console.log('[bridge] disconnecting from vignette');
  await bridge.disconnect();
}, 5000);
