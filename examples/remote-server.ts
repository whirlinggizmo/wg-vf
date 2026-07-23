// The socket thread. Bun.serve accepts WebSocket connections and does socket IO
// only; the sim (SessionManager + hosts + vignettes + pump) runs in a Worker,
// isolated from socket jitter and connection churn (see the perf/architecture
// notes). This thread multiplexes every connection over the one Worker channel,
// tagged by a numeric id, and relays raw bytes both ways — it never touches the
// envelope or vignette code.

import type { ServerWebSocket } from 'bun';

import type { MainToWorker, WorkerToMain } from './remote-server-bridge';

const port = Number(Bun.env.VF_HOST_PORT ?? 8787);
const hostname = String(Bun.env.VF_HOST_HOSTNAME ?? '0.0.0.0');

// Socket-level hardening (env-overridable), orthogonal to the per-session caps
// the worker enforces (maxSessions, maxPeers, maxPayloadBytes).
//   MAX_MESSAGE_BYTES  — frame ceiling; Bun drops larger frames (1009) at the socket.
//   MAX_BUFFERED_BYTES — drop a client that falls this far behind, vs unbounded memory.
const MAX_MESSAGE_BYTES = Number(Bun.env.VF_MAX_MESSAGE_BYTES ?? 1024 * 1024 + 1024);
const MAX_BUFFERED_BYTES = Number(Bun.env.VF_MAX_BUFFERED_BYTES ?? 4 * 1024 * 1024);

function toUint8Array(message: unknown): Uint8Array | null {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return null;
}

// The sim thread. All room/session/vignette logic lives here; this thread only
// shuttles bytes to and from it.
const worker = new Worker(new URL('./remote-server-worker.ts', import.meta.url).href, { type: 'module' });

type ConnData = { id: number; room: string };
const conns = new Map<number, ServerWebSocket<ConnData>>();
let nextId = 1;

worker.addEventListener('message', (ev: MessageEvent<WorkerToMain>) => {
  const m = ev.data;
  const ws = conns.get(m.id);
  if (!ws) return;
  if (m.t === 'data') {
    if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) {
      ws.close(1013, 'backpressure: client too slow');
      return;
    }
    ws.send(m.bytes);
  } else if (m.t === 'close') {
    ws.close(m.code ?? 1000, m.reason);
    conns.delete(m.id);
  }
});

const toWorker = (m: MainToWorker) => worker.postMessage(m);

const server = Bun.serve<ConnData>({
  port,
  hostname,
  fetch(req, server) {
    const path = new URL(req.url).pathname;
    const match = path.match(/^\/r\/([\w-]+)$/);
    if (!match) {
      return new Response('connect to /r/<room>', { status: 400 });
    }
    if (server.upgrade(req, { data: { id: nextId++, room: match[1] } })) {
      return;
    }
    return new Response('Expected WebSocket', { status: 426 });
  },
  websocket: {
    // Bun closes (1009) any frame larger than this before it reaches us.
    maxPayloadLength: MAX_MESSAGE_BYTES,
    open(ws) {
      conns.set(ws.data.id, ws);
      toWorker({ t: 'open', id: ws.data.id, room: ws.data.room });
    },
    message(ws, message) {
      const bytes = toUint8Array(message);
      if (!bytes) {
        ws.close(1003, 'Binary frames required');
        return;
      }
      toWorker({ t: 'data', id: ws.data.id, bytes }); // structured clone (socket buffers may be pooled)
    },
    close(ws) {
      conns.delete(ws.data.id);
      toWorker({ t: 'close', id: ws.data.id });
    },
  },
});

console.log(
  `[server] listening on ws://${hostname}:${port}/r/<room> — sockets on main, sim in a worker`,
);

// Graceful shutdown: stop accepting connections and tear down the sim thread.
function stop(signal: string): void {
  console.log(`[server] ${signal} — shutting down`);
  void server.stop();
  void worker.terminate();
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
