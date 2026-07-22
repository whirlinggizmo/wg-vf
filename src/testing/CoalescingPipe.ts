// Models a single reliable stream (e.g. a WebSocket) with frame coalescing
// (Part I §1.4, Part II §6): while the send buffer is stalled, a newly-sent
// Frame replaces the buffered unsent frame rather than queuing behind it, while
// System/App bytes queue reliably and are never dropped. On unstall, the
// reliable queue flushes in order, then the single latest frame.

import type { BytePeer } from '../transports/BytePeer.js';
import { Channel } from '../envelope/index.js';

export interface CoalescingPipe {
  pipe: BytePeer;
  stall(): void;
  unstall(): void;
}

/** Wrap the host-facing end so its sends coalesce frames while stalled. */
export function coalescingPipe(inner: BytePeer): CoalescingPipe {
  let stalled = false;
  const reliable: Uint8Array[] = [];
  let pendingFrame: Uint8Array | null = null;

  const flush = () => {
    for (const b of reliable) inner.send(b);
    reliable.length = 0;
    if (pendingFrame) {
      inner.send(pendingFrame);
      pendingFrame = null;
    }
  };

  const pipe: BytePeer = {
    send(bytes: Uint8Array): void {
      if (!stalled) {
        inner.send(bytes);
        return;
      }
      if (bytes.length > 1 && bytes[1] === Channel.Frame) {
        pendingFrame = bytes; // replace the unsent frame (coalesce)
      } else {
        reliable.push(bytes); // System/App: reliable, ordered
      }
    },
    onBytes: (cb) => inner.onBytes(cb),
  };

  return {
    pipe,
    stall: () => {
      stalled = true;
    },
    unstall: () => {
      stalled = false;
      flush();
    },
  };
}
