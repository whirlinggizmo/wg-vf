// Server-hardening coverage: the session-keyed host map (src/hosts/SessionManager).
// Driven in-process over loopback pipes with a VirtualClock — the flaky bits of
// the live server (multi-room isolation, re-provision after teardown) verified
// deterministically.

import { describe, expect, test } from 'bun:test';

import { SessionManager } from '../../src/hosts/SessionManager.js';
import { singleVignetteManifest } from '../../src/hosts/Manifest.js';
import type { ManifestEntry } from '../../src/hosts/Manifest.js';
import type { Vignette } from '../../src/vignettes/Vignette.js';
import { BaseVignette } from '../../src/vignettes/BaseVignette.js';
import { memoryDurableStore } from '../../src/storage/VignetteStorage.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';
import { EchoVignette, CounterVignette } from '../../src/testing/vignettes.js';
import { Channel, SystemType } from '../../src/envelope/index.js';

const STEP = 16_666;

function entry(create: () => Vignette, over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    version: '1.0.0',
    fixedStepUs: STEP,
    maxSubsteps: 4,
    maxPeers: 8,
    create,
    ...over,
  };
}

function setup(create: () => Vignette, over?: Partial<ManifestEntry>, maxSessions?: number) {
  const clock = new VirtualClock(0);
  const mgr = new SessionManager({
    clock,
    maxSessions,
    manifestFor: (key) => (key === 'bad' ? null : singleVignetteManifest('sim', entry(create, over))),
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

  test('SM-05: maxSessions caps new rooms but never blocks an existing one, and a freed slot re-opens', async () => {
    // Cap of 2 live sessions; empty-grace 0 so a leave frees the slot at once.
    const { mgr, connect } = setup(() => new EchoVignette(), { emptyGraceMs: 0 }, 2);
    const a = connect('roomA');
    a.init('sim');
    await mgr.whenIdle();
    const b = connect('roomB');
    b.init('sim');
    await mgr.whenIdle();
    expect(mgr.sessionCount).toBe(2);

    // A third distinct room is refused at capacity.
    const c = connect('roomC');
    expect(c.attached).toBe(false);
    expect(mgr.sessionCount).toBe(2);

    // A second peer joining an EXISTING room is still admitted (cap is on rooms).
    const a2 = connect('roomA');
    a2.join('sim');
    await mgr.whenIdle();
    expect(a2.ready()?.clientId).toBe(2);

    // Freeing a slot (roomB empties → CLOSED → reaped) re-opens capacity.
    b.leave();
    await mgr.whenIdle();
    expect(mgr.sessionCount).toBe(1);
    const d = connect('roomD');
    d.init('sim');
    await mgr.whenIdle();
    expect(d.attached).toBe(true);
    expect(mgr.get('roomD')?.getState()).toBe('READY');
  });

  test('SM-06: with a durableStore, a room\'s state survives teardown + re-provision', async () => {
    // A counter that restores from storage on init and persists on each message.
    class PersistCounter extends BaseVignette {
      private n = 0;
      override init(): void {
        const s = this.fs.read('n');
        this.n = s ? s[0] : 0;
      }
      override async handleMessage(sender: number): Promise<void> {
        this.n = (this.n + 1) & 0xff;
        this.fs.write('n', new Uint8Array([this.n]));
        await this.fs.flush();
        this.emit(sender, new Uint8Array([this.n]));
      }
    }
    const durable = memoryDurableStore();
    const clock = new VirtualClock(0);
    const mgr = new SessionManager({
      clock,
      durableStore: durable,
      // emptyGrace 0 → the room tears down the instant its last peer leaves.
      manifestFor: () => singleVignetteManifest('sim', entry(() => new PersistCounter(), { emptyGraceMs: 0 })),
    });
    const connect = (key: string) => {
      const { a, b } = createLoopbackPipe();
      mgr.connect(key, a);
      return new HostPeer(b);
    };

    // Provision room1, bump the counter to 1 (persisted, scope keyed by room).
    const p1 = connect('room1');
    p1.init('sim');
    await mgr.whenIdle();
    p1.app(new Uint8Array([1]));
    await mgr.whenIdle();
    expect(p1.apps().at(-1)!.payload[0]).toBe(1);

    // Last peer leaves → room torn down and reaped.
    p1.leave();
    await mgr.whenIdle();
    expect(mgr.sessionCount).toBe(0);

    // Re-provisioning the same room restores n=1, so the next bump is 2.
    const p2 = connect('room1');
    p2.init('sim');
    await mgr.whenIdle();
    p2.app(new Uint8Array([1]));
    await mgr.whenIdle();
    expect(p2.apps().at(-1)!.payload[0]).toBe(2);

    // A different room is an independent scope — starts from 0.
    const p3 = connect('room2');
    p3.init('sim');
    await mgr.whenIdle();
    p3.app(new Uint8Array([1]));
    await mgr.whenIdle();
    expect(p3.apps().at(-1)!.payload[0]).toBe(1);
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
