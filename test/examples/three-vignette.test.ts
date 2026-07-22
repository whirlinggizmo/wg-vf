// Headless verification of the rewritten three.js example vignette (v2). The
// browser render can't run here, but the vignette's logic can be driven through
// a real VignetteHost over loopback: init spawns entities, peerJoined brings a
// peer up to date, SpawnPlayer adds the green player, and ticks broadcast state.

import { describe, expect, test } from 'bun:test';

import ThreeVignette from '../../examples/three/vignette/ts/three-vignette.js';
import { encodePayload, decodePayload } from '../../examples/codecs/json-codec.js';
import { VignetteHost } from '../../src/hosts/VignetteHost.js';
import type { ManifestEntry } from '../../src/hosts/Manifest.js';
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
