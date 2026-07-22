// Conformance: host core over loopback pipes (contract §1–§3, test plan
// ENV/ABI/SES areas). Drives VignetteHost directly — the same core the worker
// and WebSocket adapters will wrap.

import { describe, expect, test } from 'bun:test';

import { VignetteHost, type HostVignetteEntry } from '../../src/hosts/VignetteHost.js';
import { BaseVignette } from '../../src/vignettes/BaseVignette.js';
import { PeerLeftReason, type Vignette } from '../../src/vignettes/Vignette.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { EchoVignette, CounterVignette, ChaosVignette, ChaosOp } from '../../src/testing/vignettes.js';
import type { BytePeer } from '../../src/transports/BytePeer.js';
import {
  Channel,
  ErrorCode,
  SystemType,
  decodeEnvelope,
  encodeAppEnvelope,
  encodeSystemEnvelope,
  readFrameHeader,
  type Envelope,
} from '../../src/envelope/index.js';
import {
  decodeErrorPayload,
  decodePingPayload,
  decodeReadyPayload,
  encodeInitPayload,
  encodeJoinPayload,
  encodePingPayload,
} from '../../src/envelope/systemPayloads.js';

const STEP = 16_666;

function entry(create: () => Vignette, over: Partial<HostVignetteEntry> = {}): HostVignetteEntry {
  return {
    vignetteId: 'sim',
    version: '1.0.0',
    fixedStepUs: STEP,
    maxSubsteps: 4,
    maxPeers: 8,
    create,
    ...over,
  };
}

/** A test peer wrapping one loopback end: sends verbs, records what it receives. */
function makePeer(end: BytePeer) {
  const received: Envelope[] = [];
  end.onBytes((bytes) => received.push(decodeEnvelope(bytes)));
  return {
    received,
    init: (id: string, payload = new Uint8Array()) =>
      end.send(encodeSystemEnvelope(SystemType.Init, encodeInitPayload({ vignetteId: id, initPayload: payload }))),
    join: (id: string) =>
      end.send(encodeSystemEnvelope(SystemType.Join, encodeJoinPayload({ vignetteId: id }))),
    app: (payload: Uint8Array, forgedClientId = 0) => end.send(encodeAppEnvelope(payload, forgedClientId)),
    leave: () => end.send(encodeSystemEnvelope(SystemType.Leave)),
    ping: (sequence: number, sentAtMs: number) =>
      end.send(encodeSystemEnvelope(SystemType.Ping, encodePingPayload({ sequence, sentAtMs }))),
    ready: () => {
      const env = received.find((e) => e.channel === Channel.System && e.systemType === SystemType.Ready);
      return env ? decodeReadyPayload(env.payload) : null;
    },
    errors: () =>
      received
        .filter((e) => e.channel === Channel.System && e.systemType === SystemType.Error)
        .map((e) => decodeErrorPayload(e.payload)),
    apps: () => received.filter((e) => e.channel === Channel.App),
    frames: () => received.filter((e) => e.channel === Channel.Frame),
  };
}

function setup(create: () => Vignette, over?: Partial<HostVignetteEntry>) {
  const clock = new VirtualClock(0);
  const host = new VignetteHost(entry(create, over), clock);
  const connect = () => {
    const { a, b } = createLoopbackPipe();
    host.connect(a);
    return makePeer(b);
  };
  return { host, clock, connect };
}

describe('SES/ENV provisioning & session', () => {
  test('SES-01/ENV-21: Provision resolves and Ready echoes id, version, clientId, fixedStepUs', async () => {
    const { host, connect } = setup(() => new CounterVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    expect(host.getState()).toBe('READY');
    expect(p.ready()).toEqual({ vignetteId: 'sim', version: '1.0.0', clientId: 1, fixedStepUs: STEP });
  });

  test('SES-08: Join mints a unique id ≥1 and Readys; existing peer undisturbed', async () => {
    const { host, connect } = setup(() => new EchoVignette());
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    expect(p1.ready()?.clientId).toBe(1);
    expect(p2.ready()?.clientId).toBe(2);
    expect(p1.errors()).toHaveLength(0);
  });

  test('SES-09: Join before Provision → NotProvisioned', async () => {
    const { host, connect } = setup(() => new EchoVignette());
    const p = connect();
    p.join('sim');
    await host.whenIdle();
    expect(p.errors()).toEqual([{ code: ErrorCode.NotProvisioned, message: expect.any(String) }]);
    expect(host.getState()).toBe('IDLE');
  });

  test('SES-10: Join with mismatched id → UnknownVignette', async () => {
    const { host, connect } = setup(() => new EchoVignette());
    connect().init('sim');
    await host.whenIdle();
    const p = connect();
    p.join('other');
    await host.whenIdle();
    expect(p.errors()[0]?.code).toBe(ErrorCode.UnknownVignette);
  });

  test('SES-11: Join at maxPeers → SessionFull; a freed slot admits the next', async () => {
    const { host, connect } = setup(() => new EchoVignette(), { maxPeers: 2 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    const p3 = connect();
    p3.join('sim');
    await host.whenIdle();
    expect(p3.errors()[0]?.code).toBe(ErrorCode.SessionFull);

    p2.leave();
    await host.whenIdle();
    const p4 = connect();
    p4.join('sim');
    await host.whenIdle();
    expect(p4.ready()?.clientId).toBe(3); // freed id 2 not reused (SES-12)
  });

  test('SES-12: Leave delivers peerLeft(Left); retired id never re-minted', async () => {
    const counter = new CounterVignette();
    const { host, connect } = setup(() => counter);
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    p2.leave();
    await host.whenIdle();
    expect(counter.left).toEqual([{ id: 2, reason: PeerLeftReason.Left }]);
  });

  test('ENV-23: Ping → Pong echoes sequence and sentAtMs', async () => {
    const { host, connect } = setup(() => new EchoVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    p.ping(42, 1234.5);
    await host.whenIdle();
    const pong = p.received.find((e) => e.systemType === SystemType.Pong);
    expect(pong).toBeDefined();
    expect(decodePingPayload(pong!.payload)).toEqual({ sequence: 42, sentAtMs: 1234.5 });
  });
});

describe('ENV clientId & routing', () => {
  test('ENV-10/22: host stamps the true sender; echo reply routes to it, not a forged id', async () => {
    const { host, connect } = setup(() => new EchoVignette());
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();

    // p2 (real id 2) forges clientId 999 on the wire.
    p2.app(new Uint8Array([7, 7]), 999);
    await host.whenIdle();

    // Unicast echo comes back only to p2, carrying the original bytes.
    const p2unicast = p2.apps().find((e) => e.clientId === 2);
    expect(p2unicast).toBeDefined();
    expect(Array.from(p2unicast!.payload)).toEqual([7, 7]);

    // Broadcast copy is prefixed with the TRUE sender id (2), reaching both peers.
    for (const p of [p1, p2]) {
      const bcast = p.apps().find((e) => e.clientId === 0);
      expect(bcast).toBeDefined();
      expect(new DataView(bcast!.payload.buffer, bcast!.payload.byteOffset).getUint16(0, true)).toBe(2);
    }
  });

  test('ENV-11/12: unicast reaches only its target; broadcast reaches all', async () => {
    const { host, connect } = setup(() => new EchoVignette());
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    const p3 = connect();
    p3.join('sim');
    await host.whenIdle();

    p1.app(new Uint8Array([1]));
    await host.whenIdle();

    // Only p1 gets the unicast echo (clientId 1); all three get the broadcast.
    expect(p1.apps().some((e) => e.clientId === 1)).toBe(true);
    expect(p2.apps().some((e) => e.clientId === 1)).toBe(false);
    expect(p3.apps().some((e) => e.clientId === 1)).toBe(false);
    expect([p1, p2, p3].every((p) => p.apps().some((e) => e.clientId === 0))).toBe(true);
  });

  test('ENV-15: App messages from one peer are delivered in send order', async () => {
    const { host, connect } = setup(() => new EchoVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    for (let i = 1; i <= 5; i++) {
      p.app(new Uint8Array([i]));
    }
    await host.whenIdle();
    // Broadcast copies carry sender(1) prefix + the byte; assert their order.
    const order = p.apps().filter((e) => e.clientId === 0).map((e) => e.payload[2]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('ABI error containment', () => {
  test('ABI-15: throw in handleMessage → PeerFault to sender, peerLeft(Fault), sim survives', async () => {
    class FaultyRecorder extends BaseVignette {
      readonly left: Array<{ id: number; reason: PeerLeftReason }> = [];
      override handleMessage(_sender: number, payload: Uint8Array): void {
        if (payload[0] === 0xee) throw new Error('boom');
      }
      override peerLeft(id: number, reason: PeerLeftReason): void {
        this.left.push({ id, reason });
      }
    }
    const vig = new FaultyRecorder();
    const { host, connect } = setup(() => vig);
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();

    p2.app(new Uint8Array([0xee]));
    await host.whenIdle();

    expect(p2.errors().some((e) => e?.code === ErrorCode.PeerFault)).toBe(true);
    expect(vig.left).toEqual([{ id: 2, reason: PeerLeftReason.Fault }]);
    expect(p1.errors()).toHaveLength(0); // other peer untouched
    expect(host.getState()).toBe('READY'); // sim continues
  });

  test('ABI-16: throw in fixedTick → broadcast Error + shutdown (sim-fatal)', async () => {
    const { host, clock, connect } = setup(() => new ChaosVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    p.app(new Uint8Array([ChaosOp.ThrowInFixedTick]));
    await host.whenIdle();

    clock.advance(STEP);
    await host.pump();

    expect(p.errors().length).toBeGreaterThan(0);
    expect(host.getState()).toBe('CLOSED');
  });

  test('ABI-17: throw in init → Error to peer, host not READY, later Join → NotProvisioned', async () => {
    class ThrowingInit extends BaseVignette {
      override init(): void {
        throw new Error('init failed');
      }
    }
    const { host, connect } = setup(() => new ThrowingInit());
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    expect(p1.errors().length).toBeGreaterThan(0);
    expect(host.getState()).toBe('IDLE');

    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    expect(p2.errors()[0]?.code).toBe(ErrorCode.NotProvisioned);
  });
});

describe('ABI frame publication', () => {
  test('ABI-20: host publishes post-burst frame with correct seq/sourceTick/body', async () => {
    const { host, clock, connect } = setup(() => new CounterVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();

    clock.advance(STEP);
    await host.pump();

    const frame = p.frames().at(-1);
    expect(frame).toBeDefined();
    const fh = readFrameHeader(frame!.payload);
    expect(fh).not.toBeNull();
    expect(fh!.frameSeq).toBe(1); // vignette-owned, bumped in fixedTick
    expect(fh!.sourceTick).toBe(0); // stepIndex of the (only) step
    const body = new DataView(fh!.body.buffer, fh!.body.byteOffset);
    expect(body.getUint32(0, true)).toBe(0); // stepIndex
    expect(body.getUint32(4, true)).toBe(1); // counter
    expect(body.getUint32(8, true)).toBe(STEP); // sum of dtUs
  });

  test('ABI-22: a zero-fixedTick pump publishes no frame; frameSeq advances only with a step', async () => {
    const { host, clock, connect } = setup(() => new CounterVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();

    clock.advance(STEP);
    await host.pump(); // one step, one frame
    const afterFirst = p.frames().length;
    expect(afterFirst).toBe(1);

    clock.advance(1_000); // < STEP → zero steps
    await host.pump();
    expect(p.frames().length).toBe(afterFirst); // silent, no new frame

    clock.advance(STEP - 1_000); // completes the next step
    await host.pump();
    const frames = p.frames();
    expect(frames.length).toBe(afterFirst + 1);
    expect(readFrameHeader(frames.at(-1)!.payload)!.frameSeq).toBe(2);
  });
});
