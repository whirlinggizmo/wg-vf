// Server-hardening coverage: the session-keyed host map (src/hosts/SessionManager).
// Driven in-process over loopback pipes with a VirtualClock — the flaky bits of
// the live server (multi-room isolation, re-provision after teardown) verified
// deterministically.

import { describe, expect, test } from 'bun:test';

import { SessionManager } from '../../src/hosts/SessionManager.js';
import type { HostVignetteEntry } from '../../src/hosts/VignetteHost.js';
import type { Vignette } from '../../src/vignettes/Vignette.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';
import { EchoVignette, CounterVignette } from '../../src/testing/vignettes.js';
import { Channel, SystemType } from '../../src/envelope/index.js';

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

function setup(create: () => Vignette, over?: Partial<HostVignetteEntry>) {
  const clock = new VirtualClock(0);
  const mgr = new SessionManager({
    clock,
    entryFor: (key) => (key === 'bad' ? null : entry(create, over)),
  });
  const connect = (key: string): (HostPeer & { attached: boolean }) => {
    const { a, b } = createLoopbackPipe();
    const pc = mgr.connect(key, a);
    return Object.assign(new HostPeer(b), { attached: pc !== null });
  };
  return { mgr, clock, connect };
}

describe('SessionManager', () => {
  test('SM-03: unknown key is rejected (connect returns null)', () => {
    const { connect, mgr } = setup(() => new EchoVignette());
    const p = connect('bad');
    expect(p.attached).toBe(false);
    expect(mgr.sessionCount).toBe(0);
  });

  test('SM-01: rooms are isolated — traffic and id spaces do not cross', async () => {
    const { mgr, connect } = setup(() => new EchoVignette());
    const a = connect('roomA');
    a.init('sim');
    await mgr.whenIdle();
    const b = connect('roomB');
    b.init('sim');
    await mgr.whenIdle();

    // Independent hosts → each mints clientId 1.
    expect(a.ready()?.clientId).toBe(1);
    expect(b.ready()?.clientId).toBe(1);
    expect(mgr.sessionCount).toBe(2);

    // A message in roomA never reaches roomB.
    a.app(new Uint8Array([7]));
    await mgr.whenIdle();
    expect(a.apps().length).toBeGreaterThan(0);
    expect(b.apps().length).toBe(0);
  });

  test('SM-02: a torn-down session frees its key for a fresh Provision', async () => {
    // emptyGraceMs 0 → the host closes the instant its last peer leaves.
    const { mgr, connect } = setup(() => new CounterVignette(), { emptyGraceMs: 0 });
    const p1 = connect('room');
    p1.init('sim');
    await mgr.whenIdle();
    expect(mgr.get('room')?.getState()).toBe('READY');

    p1.leave();
    await mgr.whenIdle(); // host reaches CLOSED and is reaped
    expect(mgr.sessionCount).toBe(0);

    // Re-provisioning the same key gets a brand-new session (clientId 1 again).
    const p2 = connect('room');
    p2.init('sim');
    await mgr.whenIdle();
    expect(p2.ready()?.clientId).toBe(1);
    expect(mgr.get('room')?.getState()).toBe('READY');
  });

  test('SM-04: two peers in one room share the sim; pumpAll drives every host', async () => {
    const counter = new CounterVignette();
    const { mgr, clock, connect } = setup(() => counter);
    const p1 = connect('room');
    p1.init('sim');
    await mgr.whenIdle();
    const p2 = connect('room');
    p2.join('sim');
    await mgr.whenIdle();
    expect(p1.ready()?.clientId).toBe(1);
    expect(p2.ready()?.clientId).toBe(2);

    clock.advance(STEP);
    await mgr.pumpAll();
    // Both peers receive the same shared frame.
    const f1 = p1.frames().at(-1);
    const f2 = p2.frames().at(-1);
    expect(f1).toBeDefined();
    expect(f2).toBeDefined();
    expect(f1!.payload).toEqual(f2!.payload);
  });

  test('pumpAll reaps a session that shut down mid-pump', async () => {
    // With an empty-grace window, the host tears down on a later pump, not on leave.
    const { mgr, clock, connect } = setup(() => new CounterVignette(), { emptyGraceMs: 30_000 });
    const p = connect('room');
    p.init('sim');
    await mgr.whenIdle();
    p.leave();
    await mgr.whenIdle();
    expect(mgr.sessionCount).toBe(1); // still in empty grace

    clock.advance(30_000_000);
    await mgr.pollAll();
    expect(mgr.sessionCount).toBe(0); // grace expired → shut down → reaped
    // A Shutdown was broadcast before teardown (no peers to receive it here).
    expect(p.received.some((e) => e.channel === Channel.System && e.systemType === SystemType.Shutdown)).toBe(false);
  });
});
