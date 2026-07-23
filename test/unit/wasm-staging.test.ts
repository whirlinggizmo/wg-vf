// PAR-03 (WASM staging / allocation failure): when vf_mem_alloc can't satisfy an
// inbound payload, the binding must surface a documented sim-fatal error instead
// of writing to a null pointer and corrupting linear memory. Pure mock — no real
// wasm needed (mirrors wasm-abi-version.test.ts).

import { describe, expect, test } from 'bun:test';

import { createWasmInstance, WG_VF_ABI_VERSION, type WasmVignetteInstance } from '../../src/vignettes/WasmVignette.js';

// A stub emscripten module. `alloc` controls what vf_mem_alloc returns; a heap of
// zeros makes the outbox ring report capacity 0, so draining is a no-op.
function stubModule(alloc: (n: number) => number): WasmVignetteInstance {
  const zero = () => 0;
  return {
    HEAPU8: new Uint8Array(256),
    _vf_abi_version: () => WG_VF_ABI_VERSION,
    _vf_init: zero,
    _vf_tick: zero,
    _vf_fixed_tick: zero,
    _vf_handle_message: zero,
    _vf_peer_joined: zero,
    _vf_peer_left: zero,
    _vf_shutdown: zero,
    _vf_outbox_offset: zero,
    _vf_frame_offset: zero,
    _vf_frame_len: zero,
    _vf_frame_seq: zero,
    _vf_mem_alloc: (n: number) => alloc(n),
    _vf_mem_free: zero,
  };
}

describe('WASM inbound staging', () => {
  test('a failed allocation for a non-empty payload is sim-fatal, not a null write', () => {
    const v = createWasmInstance(stubModule(() => 0)); // alloc always fails
    expect(() => v.handleMessage(1, new Uint8Array([1, 2, 3]))).toThrow(/allocation failed/i);
  });

  test('a successful allocation stages the payload without throwing', () => {
    const v = createWasmInstance(stubModule(() => 16)); // valid offset inside the heap
    expect(() => v.handleMessage(1, new Uint8Array([1, 2, 3]))).not.toThrow();
  });

  test('an empty payload does not require an allocation', () => {
    const v = createWasmInstance(stubModule(() => 0)); // alloc fails, but len 0 skips it
    expect(() => v.handleMessage(1, new Uint8Array())).not.toThrow();
  });
});
