// PAR (test plan §5): binding parity. The `counter` vignette implemented twice
// — TS (src/testing/vignettes.ts) and Nim-compiled-to-WASM (counter.nim via
// wg_vf.h) — driven with an identical call sequence must produce byte-identical
// outbox tuples and frame buffers. This proves the WASM binding renders the ABI
// without adding or dropping semantics.
//
// Requires the WASM build (cd test/wasm && nim c -d:emscripten counter.nim).
// If the artifact is absent the suite skips rather than fails.

import { describe, expect, test } from 'bun:test';

import { createWasmInstance } from '../../src/vignettes/WasmVignette.js';
import { CounterVignette } from '../../src/testing/vignettes.js';
import type { OutboxEntry, Vignette } from '../../src/vignettes/Vignette.js';
import { VignetteHost } from '../../src/hosts/VignetteHost.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';
import { readFrameHeader } from '../../src/envelope/index.js';

// Top-level await: load the emscripten module factory if it was built.
let factory: (() => Promise<unknown>) | null = null;
try {
  const mod = (await import('./out/counter_wasm.js')) as { default: () => Promise<unknown> };
  factory = mod.default;
} catch {
  factory = null;
}

function drain(v: Vignette): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  while (v.outboxHasMessages()) out.push(v.outboxPop());
  return out;
}

function sameEntries(a: OutboxEntry[], b: OutboxEntry[]): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i].targetId).toBe(b[i].targetId);
    expect(Array.from(a[i].payload)).toEqual(Array.from(b[i].payload));
  }
}

function sameFrame(a: Vignette, b: Vignette): void {
  const fa = a.currentFrame?.() ?? null;
  const fb = b.currentFrame?.() ?? null;
  expect(fb?.seq).toBe(fa?.seq);
  expect(Array.from(fb?.body ?? [])).toEqual(Array.from(fa?.body ?? []));
}

describe('PAR: counter TS vs WASM', () => {
  test.skipIf(!factory)('identical outbox + frames across an awkward call sequence', async () => {
    const ts: Vignette = new CounterVignette();
    const wasm: Vignette = createWasmInstance((await factory!()) as never);

    ts.init(new Uint8Array());
    wasm.init(new Uint8Array());
    sameEntries(drain(ts), drain(wasm));

    // 25 iterations of (tick, fixedTick) with prime-ish dt — crosses the
    // every-10-steps broadcast boundary twice.
    for (let i = 0; i < 25; i++) {
      const dt = 997 + i;
      ts.tick(dt, i);
      wasm.tick(dt, i);
      sameEntries(drain(ts), drain(wasm));

      ts.fixedTick(16_666, i);
      wasm.fixedTick(16_666, i);
      sameEntries(drain(ts), drain(wasm));
      sameFrame(ts, wasm);
    }
  });

  test.skipIf(!factory)('peer callbacks and a handleMessage are ABI-compatible (no traps)', async () => {
    const wasm: Vignette = createWasmInstance((await factory!()) as never);
    wasm.init(new Uint8Array());
    // These must not trap and must leave the outbox well-formed (counter emits
    // nothing on these ops, matching TS).
    wasm.peerJoined(1);
    wasm.peerLeft(2, 0);
    wasm.handleMessage(1, new Uint8Array([1, 2, 3]));
    expect(drain(wasm)).toEqual([]);
  });

  test.skipIf(!factory)('a WASM vignette runs through VignetteHost end-to-end', async () => {
    const clock = new VirtualClock(0);
    const host = new VignetteHost(
      {
        vignetteId: 'sim',
        version: '1.0.0',
        fixedStepUs: 16_666,
        maxSubsteps: 4,
        maxPeers: 8,
        create: async () => createWasmInstance((await factory!()) as never),
      },
      clock,
    );
    const { a, b } = createLoopbackPipe();
    host.connect(a);
    const peer = new HostPeer(b);

    peer.init('sim');
    await host.whenIdle();
    expect(peer.ready()?.clientId).toBe(1);

    clock.advance(16_666);
    await host.pump();

    const frame = peer.frames().at(-1);
    expect(frame).toBeDefined();
    const fh = readFrameHeader(frame!.payload)!;
    const counter = new DataView(fh.body.buffer, fh.body.byteOffset).getUint32(4, true);
    expect(counter).toBe(1); // one fixedTick ran, in the WASM sim
  });

  if (!factory) {
    test('WASM artifact not built — parity skipped', () => {
      console.warn('[PAR] out/counter_wasm.js missing; run: cd test/wasm && nim c -d:emscripten counter.nim');
      expect(true).toBe(true);
    });
  }
});
