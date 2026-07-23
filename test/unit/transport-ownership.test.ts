// Transport ownership hint (SendOptions.transferable): a sole-recipient send may
// grant the transport the buffer — loopback delivers it as-is (no copy), the
// worker port transfers it (zero-copy) — while a shared/broadcast buffer is
// always copied. Delivered bytes are identical either way (the DET suite proves
// that end-to-end; this pins the mechanism).

import { describe, expect, test } from 'bun:test';

import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { messagePortBytePeer, type MessagePortLike } from '../../src/transports/MessagePortBytePeer.js';

describe('loopback ownership', () => {
  test('transferable delivers the same buffer; otherwise a copy', () => {
    const { a, b } = createLoopbackPipe(); // sync delivery
    let received: Uint8Array | null = null;
    b.onBytes((x) => {
      received = x;
    });

    const owned = new Uint8Array([1, 2, 3]);
    a.send(owned, { transferable: true });
    expect(received).toBe(owned); // delivered as-is, no defensive copy

    const shared = new Uint8Array([4, 5, 6]);
    a.send(shared); // no grant → copy
    expect(received).not.toBe(shared);
    expect(Array.from(received!)).toEqual([4, 5, 6]);
  });
});

describe('worker port ownership', () => {
  function fakePort() {
    const calls: Array<{ message: unknown; transfer?: Transferable[] }> = [];
    const port: MessagePortLike = {
      postMessage(message: unknown, transfer?: Transferable[]) {
        calls.push({ message, transfer });
      },
      onmessage: null,
    };
    return { port, calls };
  }

  test('transfers an owned buffer only when ownership is granted', () => {
    const { port, calls } = fakePort();
    const peer = messagePortBytePeer(port);

    const owned = new Uint8Array([1, 2, 3]);
    peer.send(owned, { transferable: true });
    expect(calls[0].transfer).toEqual([owned.buffer]); // zero-copy transfer

    peer.send(new Uint8Array([4, 5, 6])); // no grant → clone, no transfer list
    expect(calls[1].transfer).toBeUndefined();
  });

  test('never transfers a view that does not own its whole buffer', () => {
    const { port, calls } = fakePort();
    const peer = messagePortBytePeer(port);

    const big = new Uint8Array(10);
    const view = big.subarray(2, 5); // shares `big`'s buffer
    peer.send(view, { transferable: true });
    expect(calls[0].transfer).toBeUndefined(); // fell back to copy — transferring would neuter `big`
  });
});
