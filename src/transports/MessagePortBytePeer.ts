// Adapts any postMessage/onmessage port into a BytePeer (Part II §8). A Worker
// boundary is just another byte-pipe transport — the envelope is the protocol,
// so no bespoke RPC layer is needed, exactly as with the WebSocket path.
//
// Works for all three port shapes: a main-thread `Worker`, the worker global
// `self`, and a `MessageChannel` port (the last makes the worker host testable
// in-process, no real Worker required).

import type { BytePeer, SendOptions } from './BytePeer.js';
import type { EnvelopePeer } from './EnvelopePeer.js';
import type { Envelope } from '../envelope/index.js';

export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener?(type: 'message', listener: (ev: MessageEvent) => void): void;
  onmessage?: ((ev: MessageEvent) => void) | null;
  /** MessagePort requires start() to begin dispatch when using addEventListener. */
  start?(): void;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export function messagePortBytePeer(port: MessagePortLike): BytePeer {
  const listeners = new Set<(bytes: Uint8Array) => void>();

  const handler = (ev: MessageEvent) => {
    const bytes = toBytes(ev.data);
    if (!bytes) return; // ignore non-byte control messages
    for (const cb of listeners) cb(bytes);
  };

  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', handler);
  } else {
    port.onmessage = handler;
  }
  port.start?.();

  return {
    send(bytes: Uint8Array, opts?: SendOptions): void {
      // Zero-copy across the boundary when the caller grants ownership AND this
      // view owns its whole buffer (else transferring would neuter unrelated
      // bytes). Otherwise structured clone copies — correct, but slower for large
      // frames on the local (worker) path.
      if (opts?.transferable && bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength) {
        port.postMessage(bytes, [bytes.buffer]);
      } else {
        port.postMessage(bytes);
      }
    },
    onBytes(cb: (bytes: Uint8Array) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/**
 * Adapt a postMessage port into an {@link EnvelopePeer} that carries structured
 * envelopes directly — no byte framing. The envelope object is structured-cloned
 * across the boundary; a granted, owned payload buffer is transferred (zero-copy).
 * The wire unit is the Envelope, so this is the framing-free local counterpart to
 * `byteEnvelopePeer(messagePortBytePeer(port))` — use it for the worker path to
 * make (de)serialization a no-op.
 */
export function messagePortEnvelopePeer(port: MessagePortLike): EnvelopePeer {
  const listeners = new Set<(env: Envelope) => void>();

  const handler = (ev: MessageEvent) => {
    const env = ev.data as Envelope | undefined;
    if (!env || typeof env !== 'object' || !(env.payload instanceof Uint8Array)) return; // not an envelope
    for (const cb of listeners) cb(env);
  };

  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', handler);
  } else {
    port.onmessage = handler;
  }
  port.start?.();

  return {
    send(env: Envelope, opts?: SendOptions): void {
      const p = env.payload;
      const owned = !!opts?.transferable && p.byteOffset === 0 && p.buffer.byteLength === p.byteLength;
      port.postMessage(env, owned ? [p.buffer] : undefined);
    },
    onEnvelope(cb: (env: Envelope) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
