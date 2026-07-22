// DET-03 (test plan §4): cross-binding determinism. The same vignette (counter)
// and the same input script must yield byte-identical observable behavior
// whether the vignette is TS or Nim-compiled-to-WASM. Only the binding differs;
// the host, envelope, and transport are identical, so matching traces prove the
// WASM binding is deterministically faithful. Skips if the WASM isn't built.

import { describe, expect, test } from 'bun:test';

import { createWasmInstance } from '../../src/vignettes/WasmVignette.js';
import { CounterVignette } from '../../src/testing/vignettes.js';
import { VignetteHost, type HostVignetteEntry } from '../../src/hosts/VignetteHost.js';
import type { Vignette } from '../../src/vignettes/Vignette.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';

type Factory = () => Promise<unknown>;
let counterF: Factory | null = null;
try {
  counterF = ((await import('./out/counter_wasm.js')) as { default: Factory }).default;
} catch {
  counterF = null;
}

const STEP = 16_666;

function entry(create: () => Vignette | Promise<Vignette>): HostVignetteEntry {
  return { vignetteId: 'sim', version: '1.0.0', fixedStepUs: STEP, maxSubsteps: 4, maxPeers: 8, create };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Run a fixed script and return the full observable trace (frame + App stream)
// as comparable strings.
async function trace(create: () => Vignette | Promise<Vignette>): Promise<string[]> {
  const clock = new VirtualClock(0);
  const host = new VignetteHost(entry(create), clock);
  const { a, b } = createLoopbackPipe();
  host.connect(a);
  const peer = new HostPeer(b);

  peer.init('sim');
  await host.whenIdle();

  // 30 pumps with jittery dt → variable substeps and a growing sumDtUs, all
  // driven by the injected clock so both bindings see the identical sequence.
  for (let i = 0; i < 30; i++) {
    clock.advance(15_000 + (i % 7) * 400);
    await host.pump();
  }

  const frames = peer.frames().map((e) => `F:${hex(e.payload)}`);
  const apps = peer.apps().map((e) => `A:${e.clientId}:${hex(e.payload)}`);
  return [...frames, ...apps];
}

describe('DET-03 cross-binding determinism', () => {
  test.skipIf(!counterF)('counter TS and WASM produce byte-identical traces', async () => {
    const tsTrace = await trace(() => new CounterVignette());
    const wasmTrace = await trace(async () => createWasmInstance((await counterF!()) as never));

    expect(wasmTrace.length).toBeGreaterThan(0);
    expect(wasmTrace).toEqual(tsTrace);
  });

  if (!counterF) {
    test('WASM artifact not built — DET-03 skipped', () => {
      expect(true).toBe(true);
    });
  }
});
