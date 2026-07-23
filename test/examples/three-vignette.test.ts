// Headless verification of the rewritten three.js example vignette (v2). The
// browser render can't run here, but the vignette's logic can be driven through
// a real VignetteHost over loopback: init spawns entities, peerJoined brings a
// peer up to date, SpawnPlayer adds the green player, and ticks broadcast state.

import { describe, expect, test } from 'bun:test';

import ThreeVignette from '../../examples/three/vignette/ts/three-vignette.js';
import { encodePayload, decodePayload } from '../../examples/codecs/json-codec.js';
import { VignetteHost } from '../../src/hosts/VignetteHost.js';
import type { ManifestEntry } from '../../src/hosts/Manifest.js';
import { memoryDurableStore } from '../../src/storage/VignetteStorage.js';
import { createWasmInstance } from '../../src/vignettes/WasmVignette.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';

// The Nim-interop→WASM three vignette (build artifact); null if not built.
let threeWasm: (() => Promise<unknown>) | null = null;
try {
  threeWasm = ((await import('../../examples/three/vignette/nim/out/three-vignette_wasm.js')) as { default: () => Promise<unknown> }).default;
} catch {
  threeWasm = null;
}

interface Entity { id: number; color: number; type: string }
interface Msg { type: string; entity?: Entity; entities?: Entity[] }

function entry(): ManifestEntry {
  return {
    version: '1.0.0',
    fixedStepUs: 16_666,
    maxSubsteps: 4,
    maxPeers: 8,
    create: () => new ThreeVignette(),
  };
}

describe('three example vignette (v2)', () => {
  test('provision → state, SpawnPlayer → green player, ticks → StateUpdate', async () => {
    const clock = new VirtualClock(0);
    const host = VignetteHost.single('three', entry(), clock);
    const { a, b } = createLoopbackPipe();
    host.connect(a);
    const peer = new HostPeer(b);

    peer.init('three', encodePayload({ type: 'Init', scene: 'test' }));
    await host.whenIdle();
    expect(peer.ready()?.clientId).toBe(1);

    const decode = (): Msg[] => peer.apps().map((e) => decodePayload(e.payload) as Msg);

    // peerJoined broadcasts a StateUpdate with the 5 init-spawned entities.
    const joinState = decode().find((m) => m.type === 'StateUpdate');
    expect(joinState?.entities?.length).toBe(5);

    // SpawnPlayer → an EntitySpawned for the green (0x00ff00) player.
    peer.app(encodePayload({ type: 'SpawnPlayer' }));
    await host.whenIdle();
    const player = decode().find((m) => m.type === 'EntitySpawned' && m.entity?.color === 0x00ff00);
    expect(player).toBeDefined();

    // A tick broadcasts a StateUpdate now containing 6 entities.
    clock.advance(16_666);
    await host.pump();
    const latest = decode().filter((m) => m.type === 'StateUpdate').at(-1);
    expect(latest?.entities?.length).toBe(6);
    expect(latest?.entities?.some((e) => e.color === 0x00ff00)).toBe(true);

    expect(host.getState()).toBe('READY');
  });

  test('persists its world and restores it into a fresh host (browser reload)', async () => {
    // The browser uses indexedDbDurableStore; the logic is identical with memory.
    const durable = memoryDurableStore();
    const make = () =>
      VignetteHost.single('three', entry(), new VirtualClock(0), { durableStore: durable, storageKey: 'save1' });
    const connect = (host: VignetteHost) => {
      const { a, b } = createLoopbackPipe();
      host.connect(a);
      return new HostPeer(b);
    };
    const decode = (peer: HostPeer): Msg[] => peer.apps().map((e) => decodePayload(e.payload) as Msg);

    // Session 1: 5 seeded entities + a spawned green player = 6, all persisted.
    const h1 = make();
    const p1 = connect(h1);
    p1.init('three', encodePayload({ type: 'Init' }));
    await h1.whenIdle();
    p1.app(encodePayload({ type: 'SpawnPlayer' }));
    await h1.whenIdle();
    expect(decode(p1).some((m) => m.type === 'EntitySpawned' && m.entity?.color === 0x00ff00)).toBe(true);

    // Session 2: a brand-new host + vignette with the same store + scope. init
    // restores the world (no fresh 5-spawn), and peerJoined broadcasts it back —
    // so the green player from session 1 is present without re-spawning.
    const h2 = make();
    const p2 = connect(h2);
    p2.init('three', encodePayload({ type: 'Init' }));
    await h2.whenIdle();
    const restored = decode(p2).find((m) => m.type === 'StateUpdate');
    expect(restored?.entities?.length).toBe(6); // 5 seeded + 1 player, restored (not re-seeded)
    expect(restored?.entities?.some((e) => e.color === 0x00ff00)).toBe(true);
  });

  test.skipIf(!threeWasm)('the Nim-interop→WASM three vignette behaves the same (green player on SpawnPlayer)', async () => {
    const clock = new VirtualClock(0);
    const host = VignetteHost.single(
      'three',
      { ...entry(), create: async () => createWasmInstance((await threeWasm!()) as never) },
      clock,
    );
    const { a, b } = createLoopbackPipe();
    host.connect(a);
    const peer = new HostPeer(b);

    peer.init('three', encodePayload({ type: 'Init' }));
    await host.whenIdle();
    peer.app(encodePayload({ type: 'SpawnPlayer' }));
    await host.whenIdle();

    const msgs = peer.apps().map((e) => decodePayload(e.payload) as Msg);
    expect(msgs.some((m) => m.type === 'EntitySpawned' && m.entity?.color === 0x00ff00)).toBe(true);
    expect(host.getState()).toBe('READY');
  });
});
