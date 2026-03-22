import { RemoteVignetteHost } from '../src';

type ConnectionData = {
  // Host instance is scoped per websocket connection.
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

console.log(`Starting wg-vf Bun server with config:`);
console.log(`  Hostname: ${hostname}`);
console.log(`  Port: ${port}`);
console.log(`  Vignette Selection: client-authoritative`);

Bun.serve<ConnectionData>({
  port,
  hostname,
  fetch(req, server) {
    // New host per connection/session.
    const host = new RemoteVignetteHost({});

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
      // Bridge host byte I/O to websocket send/receive.
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
      // Ensure vignette shutdown on socket close.
      await data.host.onShutdown();
    },
  },
});

console.log(`wg-vf Bun server listening on ws://${hostname}:${port}`);
