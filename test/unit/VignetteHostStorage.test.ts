// Vignette storage through the host (Phase 2): a storage-using vignette persists
// via flush, and a *fresh* host (standing in for a reload) restores its mount
// before init. Covers the vignette-driven flush, the graceful-shutdown flush,
// and the ephemeral (no durable store) case. Driven in-process over loopback.

import { describe, expect, test } from 'bun:test';

import { VignetteHost, singleVignetteManifest, BaseVignette, memoryDurableStore } from '../../src';
import type { DurableStore, ManifestEntry } from '../../src';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';

const STEP = 16_666;
const u32 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
const packU32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};

/** Rehydrates a counter from storage on init; each message bumps + persists it. */
class PersistCounter extends BaseVignette {
  private count = 0;
  private readonly flushEach: boolean;
  constructor(flushEach = true) {
    super();
    this.flushEach = flushEach;
  }
  override init(): void {
    const saved = this.storage.read('count');
    this.count = saved ? u32(saved) : 0;
  }
  override async handleMessage(sender: number, _payload: Uint8Array): Promise<void> {
    this.count = (this.count + 1) >>> 0;
    this.storage.write('count', packU32(this.count));
    if (this.flushEach) await this.flush();
    this.emit(sender, packU32(this.count)); // echo the running count
  }
  // Flush on graceful teardown too (covers the no-flush-per-message case).
  override async shutdown(): Promise<void> {
    await this.flush();
  }
}

function entry(create: () => PersistCounter, over: Partial<ManifestEntry> = {}): ManifestEntry {
  return { version: '1.0.0', fixedStepUs: STEP, maxSubsteps: 4, maxPeers: 8, create, ...over };
}

function connectPeer(host: VignetteHost) {
  const { a, b } = createLoopbackPipe();
  const pc = host.connect(a);
  return Object.assign(new HostPeer(b), { disconnect: pc.disconnect });
}

describe('vignette storage through the host', () => {
  test('a flushed counter is restored into a fresh host before init', async () => {
    const durable = memoryDurableStore();
    const make = () =>
      new VignetteHost(singleVignetteManifest('sim', entry(() => new PersistCounter())), new VirtualClock(0), {
        durableStore: durable,
        storageKey: 'slot1',
      });

    // Session 1: two messages → count reaches 2, flushed each time.
    const h1 = make();
    const p1 = connectPeer(h1);
    p1.init('sim');
    await h1.whenIdle();
    p1.app(new Uint8Array([1]));
    await h1.whenIdle();
    p1.app(new Uint8Array([1]));
    await h1.whenIdle();
    expect(u32(p1.apps().at(-1)!.payload)).toBe(2);

    // Session 2: a brand-new host with the same durable store + scope restores
    // count=2 before init, so the next bump is 3.
    const h2 = make();
    const p2 = connectPeer(h2);
    p2.init('sim');
    await h2.whenIdle();
    p2.app(new Uint8Array([1]));
    await h2.whenIdle();
    expect(u32(p2.apps().at(-1)!.payload)).toBe(3);
  });

  test('a graceful shutdown flush lands before the host is done (single whenIdle)', async () => {
    const durable = memoryDurableStore();
    const make = () =>
      new VignetteHost(
        // flushEach=false → the only persistence is shutdown()'s flush.
        singleVignetteManifest('sim', entry(() => new PersistCounter(false), { emptyGraceMs: 0 })),
        new VirtualClock(0),
        { durableStore: durable, storageKey: 'slot1' },
      );

    const h1 = make();
    const p1 = connectPeer(h1);
    p1.init('sim');
    await h1.whenIdle();
    p1.app(new Uint8Array([1])); // count=1, written to the mount but NOT flushed
    await h1.whenIdle();
    expect(u32(p1.apps().at(-1)!.payload)).toBe(1);

    p1.leave(); // empty → graceful hostShutdown → shutdown() flushes, inline
    await h1.whenIdle();
    expect(h1.getState()).toBe('CLOSED');

    // Fresh host restores the shutdown-flushed count=1, so the next bump is 2.
    const h2 = make();
    const p2 = connectPeer(h2);
    p2.init('sim');
    await h2.whenIdle();
    p2.app(new Uint8Array([1]));
    await h2.whenIdle();
    expect(u32(p2.apps().at(-1)!.payload)).toBe(2);
  });

  test('without a durable store, storage works but is ephemeral', async () => {
    const make = () =>
      new VignetteHost(singleVignetteManifest('sim', entry(() => new PersistCounter())), new VirtualClock(0));

    const h1 = make();
    const p1 = connectPeer(h1);
    p1.init('sim');
    await h1.whenIdle();
    p1.app(new Uint8Array([1]));
    await h1.whenIdle();
    expect(u32(p1.apps().at(-1)!.payload)).toBe(1); // writes/reads work within the session

    const h2 = make(); // nothing was persisted → starts from 0
    const p2 = connectPeer(h2);
    p2.init('sim');
    await h2.whenIdle();
    p2.app(new Uint8Array([1]));
    await h2.whenIdle();
    expect(u32(p2.apps().at(-1)!.payload)).toBe(1);
  });
});
