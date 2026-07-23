// Transport ownership hint (SendOptions.transferable): a sole-recipient send may
// grant the transport the buffer — loopback delivers it as-is (no copy), the
// worker port transfers it (zero-copy) — while a shared/broadcast buffer is
// always copied. Delivered bytes are identical either way (the DET suite proves
// that end-to-end; this pins the mechanism).

import { describe, expect, test } from 'bun:test';

import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { messagePortBytePeer, type MessagePortLike } from '../../src/transports/MessagePortBytePeer.js';
import { PeerRegistry } from '../../src/hosts/PeerRegistry.js';
import type { SendOptions } from '../../src/transports/BytePeer.js';
import type { EnvelopePeer } from '../../src/transports/EnvelopePeer.js';
import { Channel, type Envelope } from '../../src/envelope/index.js';

const envP = (bytes: number[]): Envelope => ({
  channel: Channel.App,
  systemType: 0,
  clientId: 0,
  payload: new Uint8Array(bytes),
});

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

// --- Layer 1: PeerRegistry.route decides the grant by recipient count --------

function recordingPipe() {
  const sends: Array<{ transferable?: boolean }> = [];
  const pipe: EnvelopePeer = {
    send: (_env, opts) => void sends.push({ transferable: opts?.transferable }),
    onEnvelope: () => () => {},
  };
  return { sends, pipe };
}

describe('route ownership grant', () => {
  test('grants to a unicast and a sole broadcast recipient, but not a shared broadcast', () => {
    const reg = new PeerRegistry();
    const a = recordingPipe();
    reg.attach(reg.mint(), a.pipe);

    reg.route(1, envP([1])); // unicast → sole recipient
    expect(a.sends.at(-1)!.transferable).toBe(true);

    reg.route(0, envP([2])); // broadcast, one peer → still sole
    expect(a.sends.at(-1)!.transferable).toBe(true);

    const b = recordingPipe();
    reg.attach(reg.mint(), b.pipe);
    reg.route(0, envP([3])); // broadcast, two peers → shared, no grant
    expect(a.sends.at(-1)!.transferable).toBe(false);
    expect(b.sends.at(-1)!.transferable).toBe(false);
  });
});

// --- End-to-end: a transport that REALLY neuters the payload on transfer (like
// postMessage), so a wrong grant on a shared broadcast would corrupt the later
// recipients. Loopback can't catch this — it never neuters.

function neuteringPeer() {
  const inbox: number[][] = [];
  const pipe: EnvelopePeer = {
    send(envelope: Envelope, opts?: SendOptions) {
      const p = envelope.payload;
      if (opts?.transferable && p.byteOffset === 0 && p.buffer.byteLength === p.byteLength) {
        const moved = structuredClone(p, { transfer: [p.buffer] }); // detaches the shared payload buffer
        inbox.push(Array.from(moved));
      } else {
        inbox.push(Array.from(p)); // clone
      }
    },
    onEnvelope: () => () => {},
  };
  return { inbox, pipe };
}

describe('broadcast transfer safety (real neutering)', () => {
  test('a broadcast to two peers delivers intact payload to both', () => {
    const reg = new PeerRegistry();
    const a = neuteringPeer();
    const b = neuteringPeer();
    reg.attach(reg.mint(), a.pipe);
    reg.attach(reg.mint(), b.pipe);

    reg.route(0, envP([1, 2, 3])); // must NOT transfer (shared payload)
    expect(a.inbox.at(-1)).toEqual([1, 2, 3]);
    expect(b.inbox.at(-1)).toEqual([1, 2, 3]); // would be [] if peer A had neutered it
  });

  test('a unicast to a single neutering peer transfers and still delivers correctly', () => {
    const reg = new PeerRegistry();
    const a = neuteringPeer();
    const id = reg.mint();
    reg.attach(id, a.pipe);
    reg.route(id, envP([9, 8, 7])); // sole recipient → transfers
    expect(a.inbox.at(-1)).toEqual([9, 8, 7]);
  });
});
