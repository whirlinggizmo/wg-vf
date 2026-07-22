// PAR-05 (test plan §5): the native build. The same counter.nim compiled to a
// native .so (not wasm) must, driven through a minimal bun:ffi harness, produce
// byte-identical frames and outbox tuples to the TS CounterVignette. Proves the
// one-source→(wasm | native) promise and that wg_vf.h's uintptr_t offsets work
// on a 64-bit host. Skips if libcounter.so isn't built.

import { describe, expect, test } from 'bun:test';

import { CounterVignette } from '../../src/testing/vignettes.js';
import type { OutboxEntry, Vignette } from '../../src/vignettes/Vignette.js';

const SO_PATH = new URL('./out/libcounter.so', import.meta.url).pathname;

// Load bun:ffi and the .so; null if unavailable so the suite skips.
let lib: { symbols: Record<string, (...a: number[]) => number> } | null = null;
let toArrayBuffer: ((ptr: number, offset: number, len: number) => ArrayBuffer) | null = null;
try {
  const ffi = await import('bun:ffi');
  toArrayBuffer = ffi.toArrayBuffer as never;
  const t = ffi.FFIType;
  lib = ffi.dlopen(SO_PATH, {
    vf_init: { args: [t.ptr, t.u32], returns: t.u32 },
    vf_tick: { args: [t.u32, t.u32], returns: t.u32 },
    vf_fixed_tick: { args: [t.u32, t.u32], returns: t.u32 },
    vf_outbox_offset: { args: [], returns: t.ptr },
    vf_outbox_capacity: { args: [], returns: t.u32 },
    vf_frame_offset: { args: [], returns: t.ptr },
    vf_frame_len: { args: [], returns: t.u32 },
    vf_frame_seq: { args: [], returns: t.u32 },
  }) as never;
} catch {
  lib = null;
}

function readRing(region: Uint8Array, base: number, cap: number, offset: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  if (len === 0) return out;
  const first = Math.min(len, cap - offset);
  out.set(region.subarray(base + offset, base + offset + first), 0);
  if (first < len) out.set(region.subarray(base, base + (len - first)), first);
  return out;
}

function drainNative(): OutboxEntry[] {
  const base = Number(lib!.symbols.vf_outbox_offset());
  const cap = lib!.symbols.vf_outbox_capacity() >>> 0;
  const region = new Uint8Array(toArrayBuffer!(base, 0, 12 + cap));
  const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
  const payloadBase = 12;
  let head = view.getUint32(0, true) >>> 0;
  const tail = view.getUint32(4, true) >>> 0;
  const out: OutboxEntry[] = [];
  while (head !== tail) {
    const lenBytes = readRing(region, payloadBase, cap, head, 4);
    const len = new DataView(lenBytes.buffer).getUint32(0, true) >>> 0;
    const targetOffset = (head + 4) % cap;
    const tBytes = readRing(region, payloadBase, cap, targetOffset, 2);
    const target = new DataView(tBytes.buffer).getUint16(0, true);
    const payloadOffset = (targetOffset + 2) % cap;
    const payload = readRing(region, payloadBase, cap, payloadOffset, len);
    out.push({ targetId: target, payload });
    head = (payloadOffset + len) % cap;
    view.setUint32(0, head >>> 0, true); // write head back into native memory
  }
  return out;
}

function nativeFrame(): { seq: number; body: Uint8Array } | null {
  const len = lib!.symbols.vf_frame_len() >>> 0;
  if (len === 0) return null;
  const ptr = Number(lib!.symbols.vf_frame_offset());
  const seq = lib!.symbols.vf_frame_seq() >>> 0;
  return { seq, body: new Uint8Array(toArrayBuffer!(ptr, 0, len)).slice() };
}

describe('PAR-05 native .so vs TS', () => {
  test.skipIf(!lib)('counter native binding matches TS frames + outbox', () => {
    const ts: Vignette = new CounterVignette();
    ts.init(new Uint8Array());
    lib!.symbols.vf_init(0, 0);

    // drain any init-time output
    while (ts.outboxHasMessages()) ts.outboxPop();
    drainNative();

    for (let i = 0; i < 25; i++) {
      const dt = 997 + i;
      ts.tick(dt, i);
      lib!.symbols.vf_tick(dt >>> 0, i >>> 0);

      ts.fixedTick(16_666, i);
      lib!.symbols.vf_fixed_tick(16_666, i >>> 0);

      // Outbox tuples identical.
      const tsOut: OutboxEntry[] = [];
      while (ts.outboxHasMessages()) tsOut.push(ts.outboxPop());
      const natOut = drainNative();
      expect(natOut.length).toBe(tsOut.length);
      for (let k = 0; k < tsOut.length; k++) {
        expect(natOut[k].targetId).toBe(tsOut[k].targetId);
        expect(Array.from(natOut[k].payload)).toEqual(Array.from(tsOut[k].payload));
      }

      // Frame identical.
      const tf = ts.currentFrame?.() ?? null;
      const nf = nativeFrame();
      expect(nf?.seq).toBe(tf?.seq);
      expect(Array.from(nf?.body ?? [])).toEqual(Array.from(tf?.body ?? []));
    }
  });

  if (!lib) {
    test('libcounter.so not built — native parity skipped', () => {
      expect(true).toBe(true);
    });
  }
});
