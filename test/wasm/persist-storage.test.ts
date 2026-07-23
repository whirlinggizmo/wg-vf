// Vignette FS ABI parity: the C/wasm `persist` vignette uses the wg_vf_fs_*
// imports (backed by the host's jailed mount) and must behave exactly like the
// TS PersistCounter — a counter that survives into a fresh host via the durable
// store. Proves the wasm side of docs/vignette-fs-abi.md end-to-end.

import { describe, expect, test } from 'bun:test';

import { createWasmInstance } from '../../src/vignettes/WasmVignette.js';
import { VignetteHost, singleVignetteManifest, memoryDurableStore } from '../../src';
import type { DurableStore, ManifestEntry } from '../../src';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';

type Factory = () => Promise<unknown>;

async function loadFactory(name: string): Promise<Factory | null> {
  try {
    return ((await import(`./out/${name}_wasm.js`)) as { default: Factory }).default;
  } catch {
    return null;
  }
}

const persistF = await loadFactory('persist');
const u32 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);

function entry(create: ManifestEntry['create']): ManifestEntry {
  return { version: '1.0.0', fixedStepUs: 16_666, maxSubsteps: 4, maxPeers: 8, create };
}

function connectPeer(host: VignetteHost) {
  const { a, b } = createLoopbackPipe();
  const pc = host.connect(a);
  return Object.assign(new HostPeer(b), { disconnect: pc.disconnect });
}

describe('Vignette FS ABI: C/wasm persist vignette', () => {
  test.skipIf(!persistF)('a wasm vignette persists via wg_vf_fs_* and restores into a fresh host', async () => {
    const durable: DurableStore = memoryDurableStore();
    const make = () =>
      new VignetteHost(
        singleVignetteManifest('sim', entry(async () => createWasmInstance((await persistF!()) as never))),
        new VirtualClock(0),
        { durableStore: durable, storageKey: 'slot1' },
      );

    // Session 1: two messages → wasm reads 0, bumps to 1 then 2, writing+flushing each.
    const h1 = make();
    const p1 = connectPeer(h1);
    p1.init('sim');
    await h1.whenIdle();
    p1.app(new Uint8Array([1]));
    await h1.whenIdle();
    p1.app(new Uint8Array([1]));
    await h1.whenIdle();
    expect(u32(p1.apps().at(-1)!.payload)).toBe(2);

    // Session 2: a fresh host + wasm instance, same durable store + scope. The
    // host restores count=2 into the mount before init; wg_vf_fs_read sees it.
    const h2 = make();
    const p2 = connectPeer(h2);
    p2.init('sim');
    await h2.whenIdle();
    p2.app(new Uint8Array([1]));
    await h2.whenIdle();
    expect(u32(p2.apps().at(-1)!.payload)).toBe(3);
  });

  test.skipIf(!persistF)('without a durable store, wasm storage works but is ephemeral', async () => {
    const make = () =>
      new VignetteHost(
        singleVignetteManifest('sim', entry(async () => createWasmInstance((await persistF!()) as never))),
        new VirtualClock(0),
      );

    const h1 = make();
    const p1 = connectPeer(h1);
    p1.init('sim');
    await h1.whenIdle();
    p1.app(new Uint8Array([1]));
    await h1.whenIdle();
    expect(u32(p1.apps().at(-1)!.payload)).toBe(1);

    const h2 = make(); // nothing persisted → back to 0, next bump is 1
    const p2 = connectPeer(h2);
    p2.init('sim');
    await h2.whenIdle();
    p2.app(new Uint8Array([1]));
    await h2.whenIdle();
    expect(u32(p2.apps().at(-1)!.payload)).toBe(1);
  });
});
