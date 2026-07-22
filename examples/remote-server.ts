import {
  VignetteHost,
  SystemClock,
  type BytePeer,
  type HostVignetteEntry,
} from '../src';
import { createVignette } from './simple/vignette/js/simple-vignette';

function toUint8Array(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}

const port = Number(Bun.env.VF_HOST_PORT ?? 8787);
const hostname = String(Bun.env.VF_HOST_HOSTNAME ?? '0.0.0.0');

// One shared host = one multiplayer session. The first peer's Init provisions
// it; subsequent peers Join. Host resolution is manifest-driven (§3.1): peers
// name "simple", never a URL.
const entry: HostVignetteEntry = {
  vignetteId: 'simple',
  version: '1.0.0',
  fixedStepUs: 16_666,
  maxSubsteps: 4,
  maxPeers: 8,
  reconnectGraceMs: 5_000,
  emptyGraceMs: 10_000,
  create: () => createVignette(),
};

const host = new VignetteHost(entry, new SystemClock());

type ConnData = { listeners: Set<(bytes: Uint8Array) => void>; disconnect: () => void };

Bun.serve<ConnData>({
  port,
  hostname,
  fetch(req, server) {
    if (server.upgrade(req, { data: { listeners: new Set(), disconnect: () => {} } })) {
      return;
    }
    return new Response('Expected WebSocket', { status: 426 });
  },
  websocket: {
    open(ws) {
      // Bridge this socket to the host as a BytePeer.
      const pipe: BytePeer = {
        send: (bytes) => {
          ws.send(bytes);
        },
        onBytes: (cb) => {
          ws.data.listeners.add(cb);
          return () => ws.data.listeners.delete(cb);
        },
      };
      ws.data.disconnect = host.connect(pipe).disconnect;
    },
    message(ws, message) {
      const bytes = toUint8Array(message);
      if (!bytes) {
        ws.close(1003, 'Binary frames required');
        return;
      }
      for (const cb of ws.data.listeners) cb(bytes);
    },
    close(ws) {
      ws.data.disconnect();
    },
  },
});

// Real-time driver: pump the host loop on a wall-clock interval. Host lifetime
// is decoupled from any single socket (Part I §3.5).
setInterval(() => {
  void host.pump();
}, 16);

console.log(`wg-vf v2 server on ws://${hostname}:${port} (vignette 'simple')`);
