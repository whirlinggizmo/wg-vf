// The sim thread. Runs the SessionManager, every room's VignetteHost + sim, and
// the pump loop — isolated from socket IO, which stays on the main thread. It
// speaks the bridge protocol over the Worker channel: the main thread relays raw
// client bytes here, and this thread relays host output back. Envelope decode
// happens here (with the sim); the main thread never touches the wire format.

import {
  SessionManager,
  SystemClock,
  fileDurableStore,
  type Envelope,
  type EnvelopePeer,
  type Manifest,
} from '../src';
import type { MainToWorker, WorkerToMain } from './remote-server-bridge';

const MAX_ROOMS = Number(Bun.env.VF_MAX_ROOMS ?? 256);
const PUMP_INTERVAL_MS = Number(Bun.env.VF_PUMP_INTERVAL_MS ?? 16);
const RECONNECT_GRACE_MS = Number(Bun.env.VF_RECONNECT_GRACE_MS ?? 30_000);
const EMPTY_GRACE_MS = Number(Bun.env.VF_EMPTY_GRACE_MS ?? 60_000);

// Persist vignette state to disk (per room) when VF_DATA_DIR is set — a worker
// can do fs IO. Unset → ephemeral.
const dataDir = Bun.env.VF_DATA_DIR;
const durableStore = dataDir ? fileDurableStore(dataDir) : undefined;

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

const sessions = new SessionManager({ manifestFor, clock: new SystemClock(), maxSessions: MAX_ROOMS, durableStore });

// Minimal typed view of the worker scope (avoids DOM/WebWorker lib ambiguity).
const scope = self as unknown as {
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void;
  addEventListener(type: 'message', cb: (ev: MessageEvent<MainToWorker>) => void): void;
};

const conns = new Map<number, { listeners: Set<(env: Envelope) => void>; disconnect: () => void }>();

scope.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.t === 'open') {
    const listeners = new Set<(env: Envelope) => void>();
    // A structured EnvelopePeer: the host works in envelopes; main did the
    // decode and does the encode, so this thread never frames.
    const pipe: EnvelopePeer = {
      send: (env, opts) => {
        // Honor the ownership grant: transfer the payload buffer to main when
        // this send is its sole use and it owns its whole buffer.
        const p = env.payload;
        const owned = !!opts?.transferable && p.byteOffset === 0 && p.buffer.byteLength === p.byteLength;
        scope.postMessage({ t: 'data', id: m.id, env }, owned ? [p.buffer] : undefined);
      },
      onEnvelope: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    };
    const conn = sessions.connectEnvelopes(m.room, pipe);
    if (!conn) {
      // Unknown room, or at MAX_ROOMS capacity. 1013 = try again later.
      scope.postMessage({ t: 'close', id: m.id, code: 1013, reason: `session unavailable: '${m.room}'` });
      return;
    }
    conns.set(m.id, { listeners, disconnect: conn.disconnect });
  } else if (m.t === 'data') {
    const c = conns.get(m.id);
    if (c) for (const cb of c.listeners) cb(m.env);
  } else if (m.t === 'close') {
    const c = conns.get(m.id);
    if (c) {
      c.disconnect();
      conns.delete(m.id);
    }
  }
});

// The sim loop runs here, in the worker — off the socket-IO thread.
setInterval(() => void sessions.pumpAll(), PUMP_INTERVAL_MS);

console.log(
  `[sim-worker] ready (max ${MAX_ROOMS} rooms; storage: ${dataDir ? `persistent → ${dataDir}` : 'ephemeral'})`,
);
