// byteEnvelopePeer: the wire adapter that turns a raw BytePeer into an
// EnvelopePeer. It owns framing (both ways) and wire-level rejection, so the
// host works only in structured envelopes and (de)serialization can run on any
// thread. See docs/transport-perf.md.

import { describe, expect, test } from 'bun:test';

import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { byteEnvelopePeer } from '../../src/transports/EnvelopePeer.js';
import { Channel, SystemType, decodeEnvelope, type Envelope } from '../../src/envelope/index.js';

const CAP = () => 1 << 20;

describe('byteEnvelopePeer', () => {
  test('round-trips an envelope through the wire (frame on send, parse on receive)', () => {
    const { a, b } = createLoopbackPipe();
    const peerA = byteEnvelopePeer(a, CAP);
    const peerB = byteEnvelopePeer(b, CAP);
    const received: Envelope[] = [];
    peerB.onEnvelope((env) => received.push(env));

    peerA.send({ channel: Channel.App, systemType: 0, clientId: 5, payload: new Uint8Array([1, 2, 3]) });

    expect(received.length).toBe(1);
    expect(received[0].channel).toBe(Channel.App);
    expect(received[0].clientId).toBe(5);
    expect(Array.from(received[0].payload)).toEqual([1, 2, 3]);
  });

  test('a malformed inbound frame is answered with an Error and not delivered', () => {
    const { a, b } = createLoopbackPipe();
    const peerA = byteEnvelopePeer(a, CAP);
    let delivered = 0;
    peerA.onEnvelope(() => (delivered += 1));

    const back: Uint8Array[] = [];
    b.onBytes((bytes) => back.push(bytes)); // capture what A sends back on the raw wire

    b.send(new Uint8Array([0xff, 0x00, 0x00])); // bad version / too short → decode fails

    expect(delivered).toBe(0); // never surfaced as an envelope
    expect(back.length).toBe(1); // an Error was returned
    const err = decodeEnvelope(back[0]);
    expect(err.channel).toBe(Channel.System);
    expect(err.systemType).toBe(SystemType.Error);
  });
});
