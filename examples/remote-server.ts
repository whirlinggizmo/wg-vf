import { RemoteVignetteHost, isRemoteVignetteType, type RemoteVignetteType } from '../src';

type ConnectionData = {
  host: RemoteVignetteHost;
  onBytes: ((bytes: Uint8Array) => void) | null;
};

function toUint8Array(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) {
    return message;
  }

  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }

  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }

  return null;
}

const port = Number(Bun.env.VF_HOST_PORT ?? 8787);
const hostname = String(Bun.env.VF_HOST_HOSTNAME ?? '0.0.0.0');
const envVignetteType = Bun.env.VF_VIGNETTE_TYPE;
const vignetteType: RemoteVignetteType = isRemoteVignetteType(envVignetteType)
  ? envVignetteType
  : 'js';
const defaultVignetteUrl =
  vignetteType === 'wasm'
    ? new URL('./vignettes/echo-wasm/out/echo-vignette.js', import.meta.url).href
    : vignetteType === 'js'
      ? new URL('./vignettes/echo-js/echo-vignette.ts', import.meta.url).href
      : undefined;
const vignetteModuleUrl = Bun.env.VF_VIGNETTE_URL ?? defaultVignetteUrl;

Bun.serve<ConnectionData>({
  port,
  hostname,
  fetch(req, server) {
    const host = new RemoteVignetteHost({ vignetteType, vignetteModuleUrl });

    if (
      server.upgrade(req, {
        data: {
          host,
          onBytes: null,
        },
      })
    ) {
      return;
    }

    return new Response('Expected WebSocket', { status: 426 });
  },
  websocket: {
    open(ws) {
      const data = ws.data;
      data.host.attachToPeer({
        send(bytes) {
          ws.send(bytes);
        },
        onBytes(cb) {
          data.onBytes = cb;
          return () => {
            if (data.onBytes === cb) {
              data.onBytes = null;
            }
          };
        },
      });
    },
    message(ws, message) {
      const data = ws.data;
      const bytes = toUint8Array(message);

      if (!bytes) {
        ws.close(1003, 'Binary frames required');
        return;
      }

      data.onBytes?.(bytes);
    },
    async close(ws) {
      const data = ws.data;
      data.onBytes = null;
      await data.host.onShutdown();
    },
  },
});

console.log(`wg-vf Bun server listening on ws://localhost:${port}`);
console.log(`vignette type: ${vignetteType}`);
console.log(`vignette module: ${vignetteModuleUrl}`);
