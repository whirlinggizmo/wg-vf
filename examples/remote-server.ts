import {
  SessionManager,
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

// A session per room key (from the URL path /r/<room>). Each room is an
// independent VignetteHost; a torn-down room frees its key for a fresh
// Provision. All rooms run the "simple" vignette here (manifest policy §3.1).
function entryFor(_key: string): HostVignetteEntry {
  return {
    vignetteId: 'simple',
    version: '1.0.0',
    fixedStepUs: 16_666,
    maxSubsteps: 4,
    maxPeers: 8,
    reconnectGraceMs: 5_000,
    emptyGraceMs: 10_000,
    create: () => createVignette(),
  };
}

const sessions = new SessionManager({ entryFor, clock: new SystemClock() });

type ConnData = { room: string; listeners: Set<(bytes: Uint8Array) => void>; disconnect: () => void };

Bun.serve<ConnData>({
  port,
  hostname,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    const match = path.match(/^\/r\/([\w-]+)$/);
    if (!match) {
      return new Response('connect to /r/<room>', { status: 400 });
    }
    if (server.upgrade(req, { data: { room: match[1], listeners: new Set(), disconnect: () => {} } })) {
      return;
    }
    return new Response('Expected WebSocket', { status: 426 });
  },
  websocket: {
    open(ws) {
      const pipe: BytePeer = {
        send: (bytes) => {
          ws.send(bytes);
        },
        onBytes: (cb) => {
          ws.data.listeners.add(cb);
          return () => ws.data.listeners.delete(cb);
        },
      };
      const conn = sessions.connect(ws.data.room, pipe);
      if (!conn) {
        ws.close(1008, `unknown room ${ws.data.room}`);
        return;
      }
      ws.data.disconnect = conn.disconnect;
      console.log(`[server] peer connected to room '${ws.data.room}' (${sessions.sessionCount} live)`);
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

// Real-time driver: pump every live session, reaping any that shut down.
setInterval(() => {
  void sessions.pumpAll();
}, 16);

console.log(`wg-vf v2 server on ws://${hostname}:${port} — connect to /r/<room>`);
