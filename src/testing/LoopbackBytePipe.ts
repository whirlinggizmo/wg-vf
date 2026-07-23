// T-PIPE (test plan §0): an in-process BytePeer pair. Bytes sent on one end
// surface on the other end's onBytes listeners. Delivery is synchronous by
// default (deterministic for tests) or via microtask when `async` is set.
// This is also the exported single-player / loopback transport.

import type { BytePeer, SendOptions } from '../transports/BytePeer.js';

class LoopbackEnd implements BytePeer {
  private listeners = new Set<(bytes: Uint8Array) => void>();
  /** The far end this end delivers into; wired by createLoopbackPipe. */
  peer: LoopbackEnd | null = null;

  constructor(private readonly asyncDelivery: boolean) {}

  send(bytes: Uint8Array, opts?: SendOptions): void {
    const target = this.peer;
    if (!target) return;
    // Copy so a caller reusing its buffer cannot mutate delivered bytes — unless
    // the caller grants ownership (sole recipient), then deliver it as-is.
    const payload = opts?.transferable ? bytes : bytes.slice();
    if (this.asyncDelivery) {
      queueMicrotask(() => target.deliver(payload));
    } else {
      target.deliver(payload);
    }
  }

  onBytes(cb: (bytes: Uint8Array) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private deliver(bytes: Uint8Array): void {
    for (const cb of this.listeners) cb(bytes);
  }
}

export interface LoopbackPipe {
  a: BytePeer;
  b: BytePeer;
}

export interface LoopbackOptions {
  /** Deliver via microtask instead of synchronously. Default false. */
  async?: boolean;
}

/** Create a connected BytePeer pair; a.send lands on b.onBytes and vice versa. */
export function createLoopbackPipe(options: LoopbackOptions = {}): LoopbackPipe {
  const asyncDelivery = options.async ?? false;
  const a = new LoopbackEnd(asyncDelivery);
  const b = new LoopbackEnd(asyncDelivery);
  a.peer = b;
  b.peer = a;
  return { a, b };
}
