// PAR + ABI-18 (test plan §5, §2.3): the reference vignettes implemented twice
// — TS and Nim-compiled-to-WASM via wg_vf.h — must be observably identical, and
// a WASM failure must be sim-fatal (unlike a JS peer-fault). Requires the WASM
// build (npm run test:wasm:build); absent artifacts skip rather than fail.

import { describe, expect, test } from 'bun:test';

import { createWasmInstance } from '../../src/vignettes/WasmVignette.js';
import { CounterVignette, EchoVignette } from '../../src/testing/vignettes.js';
import type { OutboxEntry, Vignette } from '../../src/vignettes/Vignette.js';
import { VignetteHost } from '../../src/hosts/VignetteHost.js';
import type { ManifestEntry } from '../../src/hosts/Manifest.js';
import { VirtualClock } from '../../src/testing/VirtualClock.js';
import { createLoopbackPipe } from '../../src/testing/LoopbackBytePipe.js';
import { HostPeer } from '../../src/testing/HostPeer.js';
import { readFrameHeader } from '../../src/envelope/index.js';

type Factory = () => Promise<unknown>;

async function loadFactory(name: string): Promise<Factory | null> {
  try {
    return ((await import(`./out/${name}_wasm.js`)) as { default: Factory }).default;
  } catch {
    return null;
  }
}

const counterF = await loadFactory('counter');
const echoF = await loadFactory('echo');
const faultyF = await loadFactory('faulty');

async function wasmVignette(factory: Factory): Promise<Vignette> {
  return createWasmInstance((await factory()) as never);
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

function hostEntry(create: ManifestEntry['create']): ManifestEntry {
  return { version: '1.0.0', fixedStepUs: 16_666, maxSubsteps: 4, maxPeers: 8, create };
}

describe('PAR / ABI-18: TS vs WASM bindings', () => {
  test.skipIf(!counterF)('PAR-02 counter: identical outbox + frames across a call sequence', async () => {
    const ts: Vignette = new CounterVignette();
    const wasm = await wasmVignette(counterF!);

    ts.init(new Uint8Array());
    wasm.init(new Uint8Array());
    sameEntries(drain(ts), drain(wasm));

    for (let i = 0; i < 25; i++) {
      const dt = 997 + i;
      ts.tick(dt, i);
      wasm.tick(dt, i);
      sameEntries(drain(ts), drain(wasm));

      ts.fixedTick(16_666, i);
      wasm.fixedTick(16_666, i);
      sameEntries(drain(ts), drain(wasm));

      const fa = ts.currentFrame?.() ?? null;
      const fb = wasm.currentFrame?.() ?? null;
      expect(fb?.seq).toBe(fa?.seq);
      expect(Array.from(fb?.body ?? [])).toEqual(Array.from(fa?.body ?? []));
    }
  });

  test.skipIf(!echoF)('PAR-01 echo: identical outbox tuples for TS vs WASM', async () => {
    const ts: Vignette = new EchoVignette();
    const wasm = await wasmVignette(echoF!);
    const vectors: Array<[number, number[]]> = [
      [3, [1, 2, 3]],
      [7, [42]],
      [1, []],
      [65535, [9, 8, 7, 6]],
    ];
    for (const [sender, bytes] of vectors) {
      ts.handleMessage(sender, new Uint8Array(bytes));
      wasm.handleMessage(sender, new Uint8Array(bytes));
      sameEntries(drain(ts), drain(wasm));
    }
  });

  test.skipIf(!counterF)('a WASM vignette runs through VignetteHost end-to-end', async () => {
    const clock = new VirtualClock(0);
    const host = VignetteHost.single('sim', hostEntry(() => wasmVignette(counterF!)), clock);
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
    expect(new DataView(fh.body.buffer, fh.body.byteOffset).getUint32(4, true)).toBe(1);
  });

  test.skipIf(!faultyF)('ABI-18: a WASM failure in handleMessage is sim-fatal (not peer-fault)', async () => {
    const clock = new VirtualClock(0);
    const host = VignetteHost.single('sim', hostEntry(() => wasmVignette(faultyF!)), clock);
    const { a, b } = createLoopbackPipe();
    host.connect(a);
    const peer = new HostPeer(b);

    peer.init('sim');
    await host.whenIdle();
    expect(peer.ready()?.clientId).toBe(1);

    // Benign message: the sim survives (contrast: a WASM peer cannot be evicted).
    peer.app(new Uint8Array([1]));
    await host.whenIdle();
    expect(host.getState()).toBe('READY');

    // Fault command 0xFF → nonzero return → sim-fatal: broadcast Error + shutdown.
    peer.app(new Uint8Array([0xff]));
    await host.whenIdle();
    expect(host.getState()).toBe('CLOSED');
    expect(peer.errors().length).toBeGreaterThan(0);
  });

  if (!counterF) {
    test('WASM artifacts not built — parity skipped', () => {
      console.warn('[PAR] run: npm run test:wasm:build');
      expect(true).toBe(true);
    });
  }
});
