// Adapts any postMessage/onmessage port into a BytePeer (Part II §8). A Worker
// boundary is just another byte-pipe transport — the envelope is the protocol,
// so no bespoke RPC layer is needed, exactly as with the WebSocket path.
//
// Works for all three port shapes: a main-thread `Worker`, the worker global
// `self`, and a `MessageChannel` port (the last makes the worker host testable
// in-process, no real Worker required).

import type { BytePeer } from './BytePeer.js';

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
    send(bytes: Uint8Array): void {
      // Structured clone copies the bytes; correct across the boundary and
      // avoids detaching a buffer the caller may reuse.
      port.postMessage(bytes);
    },
    onBytes(cb: (bytes: Uint8Array) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
