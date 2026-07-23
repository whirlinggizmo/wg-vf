import {
  SessionManager,
  SystemClock,
  type BytePeer,
  type Manifest,
} from '../src';

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

// Hardening limits (env-overridable). These protect the process from untrusted
// or slow clients — orthogonal to a host's own maxPayloadBytes/maxPeers, which
// still apply per session underneath.
//   MAX_ROOMS         — cap on concurrent sessions, so a client can't spin up
//                       unbounded hosts (enforced in SessionManager).
//   MAX_MESSAGE_BYTES — socket-level frame ceiling; Bun drops larger frames
//                       (1009) before they reach a host. Sits above the host's
//                       1 MiB payload cap plus envelope header + margin.
//   MAX_BUFFERED_BYTES — if a client falls this far behind on the send buffer,
//                       drop it rather than grow memory without bound.
const MAX_ROOMS = Number(Bun.env.VF_MAX_ROOMS ?? 256);
const MAX_MESSAGE_BYTES = Number(Bun.env.VF_MAX_MESSAGE_BYTES ?? 1024 * 1024 + 1024);
const MAX_BUFFERED_BYTES = Number(Bun.env.VF_MAX_BUFFERED_BYTES ?? 4 * 1024 * 1024);
const PUMP_INTERVAL_MS = Number(Bun.env.VF_PUMP_INTERVAL_MS ?? 16);

// Session lifetime. These must bracket a realistic client outage — a phone
// switching access points and reloading the page can take tens of seconds — so
// a returning peer (resume-Join with its saved token) still finds its id in
// grace and the room still alive. See the author guide's resume section.
const RECONNECT_GRACE_MS = Number(Bun.env.VF_RECONNECT_GRACE_MS ?? 30_000);
const EMPTY_GRACE_MS = Number(Bun.env.VF_EMPTY_GRACE_MS ?? 60_000);

// A session per room key (from the URL path /r/<room>). Each room is an
// independent host; a torn-down room frees its key for a fresh Provision. Every
// room offers the same manifest — the host loads the "simple" vignette module
// when a peer names it (Part I §3.1). The server imports no vignette code.
function manifestFor(_key: string): Manifest {
  return {
    vignettes: {
      simple: {
        version: '1.0.0',
        fixedStepUs: 16_666,
        maxSubsteps: 4,
        maxPeers: 8,
        reconnectGraceMs: RECONNECT_GRACE_MS,
        emptyGraceMs: EMPTY_GRACE_MS,
        type: 'js',
        module: new URL('./simple/vignette/js/simple-vignette.ts', import.meta.url).href,
      },
    },
  };
}

const sessions = new SessionManager({ manifestFor, clock: new SystemClock(), maxSessions: MAX_ROOMS });

type ConnData = { room: string; listeners: Set<(bytes: Uint8Array) => void>; disconnect: () => void };

const server = Bun.serve<ConnData>({
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
    // Bun closes (1009) any frame larger than this before it reaches a listener.
    maxPayloadLength: MAX_MESSAGE_BYTES,
    open(ws) {
      const pipe: BytePeer = {
        send: (bytes) => {
          // Backpressure: if the client is too far behind, drop it rather than
          // let the outbound buffer grow without bound.
          if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) {
            ws.close(1013, 'backpressure: client too slow');
            return;
          }
          ws.send(bytes);
        },
        onBytes: (cb) => {
          ws.data.listeners.add(cb);
          return () => ws.data.listeners.delete(cb);
        },
      };
      const conn = sessions.connect(ws.data.room, pipe);
      if (!conn) {
        // Unknown room, or the server is at MAX_ROOMS capacity. 1013 = try later.
        ws.close(1013, `session unavailable: '${ws.data.room}'`);
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
const pumpTimer = setInterval(() => {
  void sessions.pumpAll();
}, PUMP_INTERVAL_MS);

console.log(`[server] listening on ws://${hostname}:${port}/r/<room> (max ${MAX_ROOMS} rooms)`);

// Graceful shutdown: stop pumping and stop accepting connections.
function stop(signal: string): void {
  console.log(`[server] ${signal} — shutting down`);
  clearInterval(pumpTimer);
  void server.stop();
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

console.log(`wg-vf v2 server on ws://${hostname}:${port} — connect to /r/<room>`);
