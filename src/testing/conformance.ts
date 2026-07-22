// runHostConformance battery (test plan §6). A host-agnostic set of ENV/ABI/SES
// cases driven through a factory. Any host that satisfies ConformanceHost gets
// the full battery for the cost of one `makeHost` function.
//
// Cases are returned as data (id/title/run) rather than wired to a test runner,
// so this stays framework-neutral; the consumer maps each case onto its own
// `test()`. Assertions throw a descriptive Error on failure.

import type { Clock } from '../hosts/Clock.js';
import type { HostState, HostVignetteEntry } from '../hosts/VignetteHost.js';
import type { BytePeer } from '../transports/BytePeer.js';
import type { Vignette } from '../vignettes/Vignette.js';
import { BaseVignette } from '../vignettes/BaseVignette.js';
import { PeerLeftReason, SimFatalError } from '../vignettes/Vignette.js';
import { ErrorCode, readFrameHeader } from '../envelope/index.js';
import { VirtualClock } from './VirtualClock.js';
import { createLoopbackPipe } from './LoopbackBytePipe.js';
import { HostPeer } from './HostPeer.js';
import { CounterVignette, EchoVignette, ChaosVignette, ChaosOp } from './vignettes.js';

const STEP = 16_666;

/** The surface a host must expose to be driven by the conformance battery. */
export interface ConformanceHost {
  connect(pipe: BytePeer): { disconnect(): void };
  pump(): Promise<void>;
  poll(): Promise<void>;
  /** Resolves when the host's op queue drains — the battery's settle point. */
  whenIdle(): Promise<void>;
  getState(): HostState;
}

export type MakeHost = (entry: HostVignetteEntry, clock: Clock) => ConformanceHost;

export interface ConformanceCase {
  id: string;
  title: string;
  run(): Promise<void>;
}

// --- assertions ------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`conformance: ${msg}`);
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`conformance: ${msg} — expected ${String(expected)}, got ${String(actual)}`);
}
function jsonEq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`conformance: ${msg} — expected ${b}, got ${a}`);
}

// --- helper vignettes ------------------------------------------------------

class ThrowingInit extends BaseVignette {
  override init(): void {
    throw new Error('init failed');
  }
}

class FaultyRecorder extends BaseVignette {
  readonly left: Array<{ id: number; reason: PeerLeftReason }> = [];
  override handleMessage(_sender: number, payload: Uint8Array): void {
    if (payload[0] === 0xee) throw new Error('boom');
  }
  override peerLeft(id: number, reason: PeerLeftReason): void {
    this.left.push({ id, reason });
  }
}

// --- scenario builder ------------------------------------------------------

function buildEntry(create: () => Vignette, over: Partial<HostVignetteEntry> = {}): HostVignetteEntry {
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

function scenario(makeHost: MakeHost, create: () => Vignette, over?: Partial<HostVignetteEntry>) {
  const clock = new VirtualClock(0);
  const host = makeHost(buildEntry(create, over), clock);
  const connect = () => {
    const { a, b } = createLoopbackPipe();
    const pc = host.connect(a);
    return Object.assign(new HostPeer(b), { disconnect: pc.disconnect });
  };
  return { host, clock, connect };
}

function u16(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

/** Build the full battery for a given host factory. */
export function hostConformanceCases(makeHost: MakeHost): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const add = (id: string, title: string, run: () => Promise<void>) => cases.push({ id, title, run });

  // --- provisioning & session ---
  add('SES-01/ENV-21', 'Provision Ready echoes id/version/clientId/fixedStepUs/resumeToken', async () => {
    const { host, connect } = scenario(makeHost, () => new CounterVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    eq(host.getState(), 'READY', 'state');
    const ready = p.ready();
    assert(ready !== null, 'Ready received');
    jsonEq(
      { vignetteId: ready!.vignetteId, version: ready!.version, clientId: ready!.clientId, fixedStepUs: ready!.fixedStepUs },
      { vignetteId: 'sim', version: '1.0.0', clientId: 1, fixedStepUs: STEP },
      'Ready fields',
    );
    assert(ready!.resumeToken instanceof Uint8Array, 'resumeToken present');
  });

  add('SES-08', 'Join mints a unique id and Readys; existing peer undisturbed', async () => {
    const { host, connect } = scenario(makeHost, () => new EchoVignette());
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    eq(p1.ready()?.clientId, 1, 'p1 id');
    eq(p2.ready()?.clientId, 2, 'p2 id');
    eq(p1.errors().length, 0, 'p1 undisturbed');
  });

  add('SES-09', 'Join before Provision → NotProvisioned', async () => {
    const { host, connect } = scenario(makeHost, () => new EchoVignette());
    const p = connect();
    p.join('sim');
    await host.whenIdle();
    eq(p.errors()[0]?.code, ErrorCode.NotProvisioned, 'error code');
    eq(host.getState(), 'IDLE', 'state');
  });

  add('SES-10', 'Join with mismatched id → UnknownVignette', async () => {
    const { host, connect } = scenario(makeHost, () => new EchoVignette());
    connect().init('sim');
    await host.whenIdle();
    const p = connect();
    p.join('other');
    await host.whenIdle();
    eq(p.errors()[0]?.code, ErrorCode.UnknownVignette, 'error code');
  });

  add('SES-11/12', 'Join at maxPeers → SessionFull; freed slot admits next; ids not reused', async () => {
    const { host, connect } = scenario(makeHost, () => new EchoVignette(), { maxPeers: 2 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    const p3 = connect();
    p3.join('sim');
    await host.whenIdle();
    eq(p3.errors()[0]?.code, ErrorCode.SessionFull, 'session full');
    p2.leave();
    await host.whenIdle();
    const p4 = connect();
    p4.join('sim');
    await host.whenIdle();
    eq(p4.ready()?.clientId, 3, 'freed id 2 not reused');
  });

  add('SES-12', 'Leave delivers peerLeft(Left)', async () => {
    const counter = new CounterVignette();
    const { host, connect } = scenario(makeHost, () => counter);
    connect().init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    p2.leave();
    await host.whenIdle();
    jsonEq(counter.left, [{ id: 2, reason: PeerLeftReason.Left }], 'peerLeft');
  });

  add('ENV-23', 'Ping → Pong echoes sequence and sentAtMs', async () => {
    const { host, connect } = scenario(makeHost, () => new EchoVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    p.ping(42, 1234.5);
    await host.whenIdle();
    jsonEq(p.pong(), { sequence: 42, sentAtMs: 1234.5 }, 'pong');
  });

  // --- clientId & routing ---
  add('ENV-10/22', 'host stamps true sender; echo routes to it, not a forged id', async () => {
    const { host, connect } = scenario(makeHost, () => new EchoVignette());
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    p2.app(new Uint8Array([7, 7]), 999); // forge clientId 999
    await host.whenIdle();
    const unicast = p2.apps().find((e) => e.clientId === 2);
    assert(unicast !== undefined, 'p2 got its unicast echo');
    jsonEq(Array.from(unicast!.payload), [7, 7], 'echo bytes');
    for (const p of [p1, p2]) {
      const bcast = p.apps().find((e) => e.clientId === 0);
      assert(bcast !== undefined, 'broadcast received');
      eq(u16(bcast!.payload), 2, 'broadcast tagged with true sender');
    }
  });

  add('ENV-11/12', 'unicast reaches only its target; broadcast reaches all', async () => {
    const { host, connect } = scenario(makeHost, () => new EchoVignette());
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
    assert(p1.apps().some((e) => e.clientId === 1), 'p1 got unicast');
    assert(!p2.apps().some((e) => e.clientId === 1), 'p2 no unicast');
    assert(!p3.apps().some((e) => e.clientId === 1), 'p3 no unicast');
    assert([p1, p2, p3].every((p) => p.apps().some((e) => e.clientId === 0)), 'all got broadcast');
  });

  add('ENV-15/16', 'App messages delivered in send order; per-peer emission order preserved', async () => {
    const { host, connect } = scenario(makeHost, () => new EchoVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    for (let i = 1; i <= 5; i++) p.app(new Uint8Array([i]));
    await host.whenIdle();
    jsonEq(p.apps().filter((e) => e.clientId === 1).map((e) => e.payload[0]), [1, 2, 3, 4, 5], 'unicast order');
    jsonEq(p.apps().filter((e) => e.clientId === 0).map((e) => e.payload[2]), [1, 2, 3, 4, 5], 'broadcast order');
  });

  add('ENV-13', 'unicast to an unattached id is silently dropped; sim unaffected', async () => {
    const { host, connect } = scenario(makeHost, () => new ChaosVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    p.app(new Uint8Array([ChaosOp.EmitToInvalidTarget, 1, 2, 3]));
    await host.whenIdle();
    eq(p.apps().length, 0, 'nothing delivered');
    eq(p.errors().length, 0, 'not an error');
    eq(host.getState(), 'READY', 'sim survives');
  });

  // --- error containment ---
  add('ABI-15', 'throw in handleMessage → PeerFault to sender, peerLeft(Fault), sim survives', async () => {
    const vig = new FaultyRecorder();
    const { host, connect } = scenario(makeHost, () => vig);
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    p2.app(new Uint8Array([0xee]));
    await host.whenIdle();
    assert(p2.errors().some((e) => e.code === ErrorCode.PeerFault), 'PeerFault to sender');
    jsonEq(vig.left, [{ id: 2, reason: PeerLeftReason.Fault }], 'peerLeft Fault');
    eq(p1.errors().length, 0, 'other peer untouched');
    eq(host.getState(), 'READY', 'sim continues');
  });

  add('ABI-16', 'throw in fixedTick → broadcast Error + shutdown', async () => {
    const { host, clock, connect } = scenario(makeHost, () => new ChaosVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    p.app(new Uint8Array([ChaosOp.ThrowInFixedTick]));
    await host.whenIdle();
    clock.advance(STEP);
    await host.pump();
    assert(p.errors().length > 0, 'Error broadcast');
    eq(host.getState(), 'CLOSED', 'shutdown');
  });

  add('ABI-18', 'SimFatalError from handleMessage is sim-fatal, not peer-fault', async () => {
    class FatalOnCommand extends BaseVignette {
      override handleMessage(_sender: number, payload: Uint8Array): void {
        if (payload[0] === 0xff) throw new SimFatalError('untrustworthy');
      }
    }
    const { host, connect } = scenario(makeHost, () => new FatalOnCommand());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    // Ordinary bytes: sim survives.
    p.app(new Uint8Array([1]));
    await host.whenIdle();
    eq(host.getState(), 'READY', 'survives benign message');
    // Fatal marker: broadcast Error + shutdown (contrast ABI-15 peer-fault).
    p.app(new Uint8Array([0xff]));
    await host.whenIdle();
    eq(host.getState(), 'CLOSED', 'sim-fatal');
    assert(p.errors().length > 0, 'Error broadcast');
  });

  add('ABI-17', 'throw in init → Error, not READY, later Join → NotProvisioned', async () => {
    const { host, connect } = scenario(makeHost, () => new ThrowingInit());
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    assert(p1.errors().length > 0, 'init Error');
    eq(host.getState(), 'IDLE', 'not READY');
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    eq(p2.errors()[0]?.code, ErrorCode.NotProvisioned, 'NotProvisioned');
  });

  // --- frame publication ---
  add('ABI-20', 'post-burst frame carries correct seq/sourceTick/body', async () => {
    const { host, clock, connect } = scenario(makeHost, () => new CounterVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    clock.advance(STEP);
    await host.pump();
    const frame = p.frames().at(-1);
    assert(frame !== undefined, 'frame published');
    const fh = readFrameHeader(frame!.payload);
    assert(fh !== null, 'frame header');
    eq(fh!.frameSeq, 1, 'frameSeq');
    eq(fh!.sourceTick, 0, 'sourceTick');
    const body = new DataView(fh!.body.buffer, fh!.body.byteOffset);
    eq(body.getUint32(0, true), 0, 'stepIndex');
    eq(body.getUint32(4, true), 1, 'counter');
    eq(body.getUint32(8, true), STEP, 'sumDtUs');
  });

  add('ABI-22', 'zero-fixedTick pump publishes no frame; frameSeq advances only with a step', async () => {
    const { host, clock, connect } = scenario(makeHost, () => new CounterVignette());
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    clock.advance(STEP);
    await host.pump();
    eq(p.frames().length, 1, 'first frame');
    clock.advance(1_000);
    await host.pump();
    eq(p.frames().length, 1, 'silent on zero-step');
    clock.advance(STEP - 1_000);
    await host.pump();
    eq(p.frames().length, 2, 'frame after a step');
    eq(readFrameHeader(p.frames().at(-1)!.payload)!.frameSeq, 2, 'frameSeq advanced');
  });

  // --- trust & idempotence ---
  add('SES-02', 'unknown id → UnknownVignette, stays IDLE, later valid Provision succeeds', async () => {
    const { host, connect } = scenario(makeHost, () => new EchoVignette());
    const p1 = connect();
    p1.init('nope');
    await host.whenIdle();
    eq(p1.errors()[0]?.code, ErrorCode.UnknownVignette, 'unknown');
    eq(host.getState(), 'IDLE', 'stays IDLE');
    const p2 = connect();
    p2.init('sim');
    await host.whenIdle();
    eq(host.getState(), 'READY', 'now READY');
    eq(p2.ready()?.clientId, 1, 'provisioned');
  });

  add('SES-07/21', 'second Provision on READY cannot re-provision; sim undisturbed', async () => {
    const counter = new CounterVignette();
    const { host, clock, connect } = scenario(makeHost, () => counter);
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    clock.advance(STEP);
    await host.pump();
    const before = counter.value;
    const p2 = connect();
    p2.init('other');
    await host.whenIdle();
    assert(p2.errors().length > 0, 'rejected');
    eq(host.getState(), 'READY', 'undisturbed');
    eq(counter.value, before, 'sim unchanged');
  });

  add('SES-13/ENV-24', 'peer-originated Shutdown behaves as Leave; session survives', async () => {
    const counter = new CounterVignette();
    const { host, connect } = scenario(makeHost, () => counter);
    connect().init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    p2.shutdown();
    await host.whenIdle();
    jsonEq(counter.left, [{ id: 2, reason: PeerLeftReason.Left }], 'shutdown ≡ leave');
    eq(host.getState(), 'READY', 'session survives');
  });

  // --- lifetime ---
  add('SES-17', 'founding peer disconnect does not shut the session down; sim ticks on', async () => {
    const counter = new CounterVignette();
    const { host, clock, connect } = scenario(makeHost, () => counter, { reconnectGraceMs: 0 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim');
    await host.whenIdle();
    p1.disconnect();
    await host.whenIdle();
    jsonEq(counter.left, [{ id: 1, reason: PeerLeftReason.TimedOut }], 'founding peer evicted');
    eq(host.getState(), 'READY', 'session survives');
    clock.advance(STEP);
    await host.pump();
    eq(counter.value, 1, 'sim still advancing');
    assert(p2.frames().length > 0, 'peer B still served');
  });

  add('SES-19', 'emptyGraceMs 0 tears down immediately on last detach', async () => {
    const { host, connect } = scenario(makeHost, () => new CounterVignette(), { emptyGraceMs: 0 });
    const p = connect();
    p.init('sim');
    await host.whenIdle();
    p.leave();
    await host.whenIdle();
    eq(host.getState(), 'CLOSED', 'immediate teardown');
  });

  add('SES-18', 'empty grace expiry tears down; a Join inside the window cancels it', async () => {
    // cancel
    {
      const { host, clock, connect } = scenario(makeHost, () => new CounterVignette(), { emptyGraceMs: 30_000 });
      const p1 = connect();
      p1.init('sim');
      await host.whenIdle();
      p1.leave();
      await host.whenIdle();
      clock.advance(10_000_000);
      const p2 = connect();
      p2.join('sim');
      await host.whenIdle();
      clock.advance(30_000_000);
      await host.poll();
      eq(host.getState(), 'READY', 'cancelled');
    }
    // expiry
    {
      const { host, clock, connect } = scenario(makeHost, () => new CounterVignette(), { emptyGraceMs: 30_000 });
      const p1 = connect();
      p1.init('sim');
      await host.whenIdle();
      p1.leave();
      await host.whenIdle();
      clock.advance(30_000_000);
      await host.poll();
      eq(host.getState(), 'CLOSED', 'expired');
    }
  });

  add('SES-15/20', 'pending reconnect suppresses empty; expiry fires TimedOut then empty grace begins', async () => {
    const counter = new CounterVignette();
    const { host, clock, connect } = scenario(makeHost, () => counter, { reconnectGraceMs: 15_000, emptyGraceMs: 30_000 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    p1.disconnect();
    await host.whenIdle();
    clock.advance(10_000_000);
    await host.poll();
    eq(host.getState(), 'READY', 'suppressed while pending');
    jsonEq(counter.left, [], 'no peerLeft while pending');
    clock.advance(5_000_000);
    await host.poll();
    jsonEq(counter.left, [{ id: 1, reason: PeerLeftReason.TimedOut }], 'TimedOut at expiry');
    eq(host.getState(), 'READY', 'empty grace only now begins');
    clock.advance(30_000_000);
    await host.poll();
    eq(host.getState(), 'CLOSED', 'empty grace elapsed');
  });

  // --- reconnect ---
  add('SES-14', 'reconnect within grace rebinds the same id with no peerLeft/peerJoined', async () => {
    const counter = new CounterVignette();
    const { host, clock, connect } = scenario(makeHost, () => counter, { reconnectGraceMs: 15_000 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const token = p1.ready()!.resumeToken;
    jsonEq(counter.joined, [1], 'joined once');
    p1.disconnect();
    await host.whenIdle();
    clock.advance(5_000_000);
    const p1b = connect();
    p1b.join('sim', token);
    await host.whenIdle();
    eq(p1b.ready()?.clientId, 1, 'same id');
    jsonEq(counter.joined, [1], 'no second peerJoined');
    jsonEq(counter.left, [], 'no peerLeft');
  });

  add('SES-15/16', 'after grace a stale token yields a fresh id; forged token never rebinds', async () => {
    const counter = new CounterVignette();
    const { host, clock, connect } = scenario(makeHost, () => counter, { reconnectGraceMs: 15_000, emptyGraceMs: 60_000 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const token = p1.ready()!.resumeToken;
    p1.disconnect();
    await host.whenIdle();
    clock.advance(15_000_000);
    await host.poll();
    jsonEq(counter.left, [{ id: 1, reason: PeerLeftReason.TimedOut }], 'timed out');
    const p1b = connect();
    p1b.join('sim', token); // stale
    await host.whenIdle();
    eq(p1b.ready()?.clientId, 2, 'fresh id');
    jsonEq(counter.joined, [1, 2], 'ordinary join');
  });

  add('SES-16', 'a forged token (no matching pending) becomes an ordinary Join', async () => {
    const counter = new CounterVignette();
    const { host, connect } = scenario(makeHost, () => counter, { reconnectGraceMs: 15_000 });
    const p1 = connect();
    p1.init('sim');
    await host.whenIdle();
    const p2 = connect();
    p2.join('sim', new Uint8Array([9, 9, 9, 9]));
    await host.whenIdle();
    eq(p2.ready()?.clientId, 2, 'fresh id');
    jsonEq(counter.joined, [1, 2], 'ordinary join');
  });

  return cases;
}
