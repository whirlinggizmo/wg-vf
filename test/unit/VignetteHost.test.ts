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
    join: (id: string, resumeToken?: Uint8Array) =>
      end.send(encodeSystemEnvelope(SystemType.Join, encodeJoinPayload({ vignetteId: id, resumeToken }))),
    app: (payload: Uint8Array, forgedClientId = 0) => end.send(encodeAppEnvelope(payload, forgedClientId)),
    leave: () => end.send(encodeSystemEnvelope(SystemType.Leave)),
    shutdown: () => end.send(encodeSystemEnvelope(SystemType.Shutdown)),
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

type TestPeer = ReturnType<typeof makePeer> & { disconnect: () => void };

function setup(create: () => Vignette, over?: Partial<HostVignetteEntry>) {
  const clock = new VirtualClock(0);
  const host = new VignetteHost(entry(create, over), clock);
  const connect = (): TestPeer => {
    const { a, b } = createLoopbackPipe();
    const pc = host.connect(a);
    return Object.assign(makePeer(b), { disconnect: pc.disconnect });
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
    const ready = p.ready();
    expect(ready).toMatchObject({ vignetteId: 'sim', version: '1.0.0', clientId: 1, fixedStepUs: STEP });
    expect(ready?.resumeToken).toBeInstanceOf(Uint8Array);
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

describe('SES trust & idempotence', () => {
  test('SES-02: unknown id → UnknownVignette, host stays IDLE, later valid Provision succeeds', async () => {
    const { host, connect } = setup(() => new EchoVignette());
    const p1 = connect();
    p1.init('nope');
    await host.whenIdle();
    expect(p1.errors()[0]?.code).toBe(ErrorCode.UnknownVignette);
    expect(host.getState()).toBe('IDLE');

    const p2 = connect();
    p2.init('sim');
    await host.whenIdle();
    expect(host.getState()).toBe('READY');
    expect(p2.ready()?.clientId).toBe(1);
  });

  test('SES-07/21: a second Provision on a READY session cannot re-provision; sim undisturbed', async () => {
    const counter = new CounterVignette();
    const { host, clock, connect } = setup(() => counter);
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();

    clock.advance(STEP);
    await host.pump();
    const before = counter.value;

    // Hostile re-Init naming a different vignette must not touch the session.
    const p2 = connect();
    p2.init('other');
    await host.whenIdle();
    expect(p2.errors().length).toBeGreaterThan(0);
    expect(host.getState()).toBe('READY');
    expect(counter.value).toBe(before);
  });

  test('SES-13/ENV-24: peer-originated Shutdown behaves as Leave; session survives', async () => {
    const counter = new CounterVignette();
    const { host, connect } = setup(() => counter);
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();

    // p2 sends Shutdown — a leave request for itself only.
    p2.shutdown();
    await host.whenIdle();
    expect(counter.left).toEqual([{ id: 2, reason: PeerLeftReason.Left }]);
    expect(host.getState()).toBe('READY'); // session survives, p1 still attached
  });
});

describe('ENV routing edge cases', () => {
  test('ENV-13: unicast to an unattached id is silently dropped; sim unaffected', async () => {
    const { host, connect } = setup(() => new ChaosVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();

    // chaos emits to id 0xBEEF, which is not attached.
    p.app(new Uint8Array([ChaosOp.EmitToInvalidTarget, 1, 2, 3]));
    await host.whenIdle();

    expect(p.apps()).toHaveLength(0); // nothing delivered anywhere
    expect(p.errors()).toHaveLength(0); // not an error
    expect(host.getState()).toBe('READY');
  });

  test('ENV-16: peer-bound messages arrive at a peer in emission order', async () => {
    const { host, connect } = setup(() => new EchoVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    for (let i = 1; i <= 4; i++) p.app(new Uint8Array([i]));
    await host.whenIdle();
    // The per-peer unicast echoes to p (clientId 1) preserve emission order.
    const unicastOrder = p.apps().filter((e) => e.clientId === 1).map((e) => e.payload[0]);
    expect(unicastOrder).toEqual([1, 2, 3, 4]);
  });
});

describe('SES lifetime', () => {
  test('SES-17: founding peer disconnect does not shut the session down; sim ticks on', async () => {
    const counter = new CounterVignette();
    const { host, clock, connect } = setup(() => counter, { reconnectGraceMs: 0 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();

    p1.disconnect(); // founding peer's transport drops
    await host.whenIdle();
    expect(counter.left).toEqual([{ id: 1, reason: PeerLeftReason.TimedOut }]);
    expect(host.getState()).toBe('READY');

    clock.advance(STEP);
    await host.pump();
    expect(counter.value).toBe(1); // sim still advancing for peer B
    expect(p2.frames().length).toBeGreaterThan(0);
  });

  test('SES-19: emptyGraceMs 0 tears down immediately on last detach', async () => {
    const { host, connect } = setup(() => new CounterVignette(), { emptyGraceMs: 0 });
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    p.leave();
    await host.whenIdle();
    expect(host.getState()).toBe('CLOSED');
  });

  test('SES-18: empty grace expiry tears down; a Join inside the window cancels it', async () => {
    // Cancel case.
    {
      const { host, clock, connect } = setup(() => new CounterVignette(), { emptyGraceMs: 30_000 });
      const p1 = connect();
      p1.init('sim');
      await host.whenIdle();
      p1.leave();
      await host.whenIdle(); // empty grace begins at t=0

      clock.advance(10_000_000); // 10s < 30s
      const p2 = connect();
      p2.join('sim');
      await host.whenIdle(); // cancels teardown
      clock.advance(30_000_000);
      await host.poll();
      expect(host.getState()).toBe('READY');
    }
    // Expiry case.
    {
      const { host, clock, connect } = setup(() => new CounterVignette(), { emptyGraceMs: 30_000 });
      const p1 = connect();
      p1.init('sim');
      await host.whenIdle();
      p1.leave();
      await host.whenIdle();
      clock.advance(30_000_000); // exactly the grace window
      await host.poll();
      expect(host.getState()).toBe('CLOSED');
    }
  });

  test('SES-20/15: pending reconnect suppresses empty; expiry fires TimedOut then empty grace begins', async () => {
    const counter = new CounterVignette();
    const { host, clock, connect } = setup(() => counter, {
      reconnectGraceMs: 15_000,
      emptyGraceMs: 30_000,
    });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();

    p1.disconnect(); // enters reconnect-pending — NOT empty
    await host.whenIdle();

    clock.advance(10_000_000); // 10s < reconnect grace
    await host.poll();
    expect(host.getState()).toBe('READY');
    expect(counter.left).toEqual([]); // no peerLeft while pending

    clock.advance(5_000_000); // now 15s total → reconnect grace expired
    await host.poll();
    expect(counter.left).toEqual([{ id: 1, reason: PeerLeftReason.TimedOut }]);
    expect(host.getState()).toBe('READY'); // empty grace only now begins

    clock.advance(30_000_000); // empty grace elapses
    await host.poll();
    expect(host.getState()).toBe('CLOSED');
  });
});

describe('SES reconnect', () => {
  test('SES-14: reconnect within grace rebinds the same id with no peerLeft/peerJoined', async () => {
    const counter = new CounterVignette();
    const { host, clock, connect } = setup(() => counter, { reconnectGraceMs: 15_000 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const token = p1.ready()!.resumeToken;
    expect(counter.joined).toEqual([1]);

    p1.disconnect();
    await host.whenIdle();

    clock.advance(5_000_000); // within grace
    const p1b = connect();
    p1b.join('sim', token);
    await host.whenIdle();

    expect(p1b.ready()?.clientId).toBe(1); // same id
    expect(counter.joined).toEqual([1]); // no second peerJoined
    expect(counter.left).toEqual([]); // no peerLeft — the blip was invisible
  });

  test('SES-15/16: after grace, a stale token yields a fresh id; a forged token never rebinds', async () => {
    const counter = new CounterVignette();
    // emptyGraceMs keeps the session alive after p1 times out so we can observe
    // the stale-token reconnect resolving to a fresh id.
    const { host, clock, connect } = setup(() => counter, {
      reconnectGraceMs: 15_000,
      emptyGraceMs: 60_000,
    });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const token = p1.ready()!.resumeToken;

    p1.disconnect();
    await host.whenIdle();
    clock.advance(15_000_000); // grace expires
    await host.poll();
    expect(counter.left).toEqual([{ id: 1, reason: PeerLeftReason.TimedOut }]);

    // Stale token → ordinary Join with a fresh id.
    const p1b = connect();
    p1b.join('sim', token);
    await host.whenIdle();
    expect(p1b.ready()?.clientId).toBe(2);
    expect(counter.joined).toEqual([1, 2]);
  });

  test('SES-16: a forged token (no matching pending) becomes an ordinary Join', async () => {
    const counter = new CounterVignette();
    const { host, connect } = setup(() => counter, { reconnectGraceMs: 15_000 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();

    const p2 = connect();
    p2.join('sim', new Uint8Array([9, 9, 9, 9])); // forged, no pending peer
    await host.whenIdle();
    expect(p2.ready()?.clientId).toBe(2);
    expect(counter.joined).toEqual([1, 2]);
  });
});
